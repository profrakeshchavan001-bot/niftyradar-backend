'use strict';
/**
 * Overnight ops: one glance at whether the paper bot is alive, for GET /api/paper/health (+ &format=json).
 * Rule: a status is a real measurement or explicitly "unchecked" - never guessed, never invented.
 * Per-job scan times and errors come from createHealthTracker(), wrapped around the scan/monitor jobs in
 * paperbot/index.js (one line per job there). Per-source (Binance/Yahoo/Dhan) status comes from a tiny
 * ok/fail recorder inside paperbot/sources.js (Dhan's dhanCall(), Binance's get()) and paperbot/yahoo.js
 * (its existing `stats` object, extended), exposed as state.nse.stats / state.crypto.stats / state.yahoo.stats.
 */
const MAX_ERRORS = 10;
const STALE_MS = 15 * 60 * 1000; // a module with no scan in 15 minutes is a problem (overnight brief, item 7)

function createHealthTracker({ now = Date.now } = {}) {
  const jobs = new Map(); // name -> { lastRunAt, ok, error }
  const errors = []; // ring buffer, oldest first, max MAX_ERRORS
  const consecFailures = new Map(); // name -> consecutive failure count, reset to 0 on a success

  function recordRun(name, ok, error = null) {
    jobs.set(name, { lastRunAt: now(), ok, error: error || null });
    consecFailures.set(name, ok ? 0 : (consecFailures.get(name) || 0) + 1);
    if (!ok) {
      errors.push({ at: now(), job: name, message: String(error || 'unknown error').slice(0, 300) });
      while (errors.length > MAX_ERRORS) errors.shift();
    }
  }

  /** Wraps a job function so every run (success or failure) is recorded, without changing what it returns or throws. */
  function wrap(name, fn) {
    return async (...args) => {
      try {
        const result = await fn(...args);
        recordRun(name, true);
        return result;
      } catch (e) {
        recordRun(name, false, e && e.message ? e.message : String(e));
        throw e;
      }
    };
  }

  function snapshot() {
    return { jobs: Object.fromEntries(jobs), errors: errors.slice(-MAX_ERRORS).reverse(), consecFailures: Object.fromEntries(consecFailures) };
  }

  return { recordRun, wrap, snapshot };
}

// One tracker shared by the health route, the home page and the alerts plugin, so they all describe the
// same jobs (same pattern as src/paper/context/news.js's defaultContext()).
let sharedTracker = null;
const defaultTracker = () => (sharedTracker || (sharedTracker = createHealthTracker()));

const minutesAgo = (ms, now) => (ms == null ? null : Math.round((now - ms) / 60000));
const istDateFromMs = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);

async function dbStatus(store) {
  if (!store) return { ok: false, checked: false, error: 'no store configured' };
  try {
    await store.listTrades(1);
    return { ok: true, checked: true };
  } catch (e) {
    return { ok: false, checked: true, error: String((e && e.message) || e).slice(0, 200) };
  }
}

const JOB_NAMES = ['nseScan', 'nseMonitor', 'cryptoScan', 'cryptoMonitor'];

/** Assembles the whole health snapshot. `now` is injected ms for tests; defaults to the real clock. */
async function buildHealth({ tracker, store, state, now = Date.now() }) {
  const snap = tracker.snapshot();
  const db = await dbStatus(store);
  const todayIst = istDateFromMs(now);

  const jobs = {};
  const staleJobs = [];
  for (const name of JOB_NAMES) {
    const j = snap.jobs[name];
    const ageMin = j ? minutesAgo(j.lastRunAt, now) : null;
    const stale = j == null || ageMin * 60000 > STALE_MS;
    if (stale) staleJobs.push(name);
    jobs[name] = { lastRunAt: j ? new Date(j.lastRunAt).toISOString() : null, minutesAgo: ageMin, ok: j ? j.ok : null, error: j ? j.error : null, stale };
  }

  let openTrades = { nse: null, crypto: null };
  let today = { trades: null, skips: null };
  if (db.ok) {
    try {
      const [nseOpen, cryptoOpen, nseToday, cryptoToday, skipsFromToday] = await Promise.all([
        store.openTrades('nse'), store.openTrades('crypto'), store.tradesForDay('nse', todayIst), store.tradesForDay('crypto', todayIst), store.skipsSince(todayIst),
      ]);
      openTrades = { nse: nseOpen.length, crypto: cryptoOpen.length };
      today = { trades: nseToday.length + cryptoToday.length, skips: skipsFromToday.filter((s) => s.skip_date === todayIst).length };
    } catch (e) { /* counts stay null; the database error is already reported via db.ok */ }
  }

  // Real counts from each source's own recorder (see file header). "unchecked" only when that source
  // object does not exist yet (bot disabled/starting) or it has never been asked anything - never guessed.
  const sourceStatus = (stats) => {
    if (!stats) return { status: 'unchecked', note: 'bot not ready yet' };
    if (stats.ok === 0 && stats.fail === 0) return { status: 'unchecked', note: 'not asked yet this run', ok: 0, fail: 0 };
    return {
      status: stats.ok > 0 ? 'ok' : 'failing',
      ok: stats.ok, fail: stats.fail,
      lastError: stats.lastError, lastErrorAt: stats.lastErrorAt ? new Date(stats.lastErrorAt).toISOString() : null,
      lastSuccessAt: stats.lastSuccessAt ? new Date(stats.lastSuccessAt).toISOString() : null,
    };
  };
  const dataSources = {
    binance: sourceStatus(state && state.crypto && state.crypto.stats),
    yahoo: sourceStatus(state && state.yahoo && state.yahoo.stats),
    dhan: sourceStatus(state && state.nse && state.nse.stats),
  };

  // Alerts the alerts plugin (src/paper/ops/alerts/) stored; absent entirely when paper_alerts does not
  // exist yet (plugin not loaded) or the store has no raw .query - never treated as "no alerts".
  let recentAlerts = [];
  if (store && typeof store.query === 'function') {
    try { recentAlerts = (await store.query('SELECT kind, subject, message, created_at FROM paper_alerts ORDER BY created_at DESC LIMIT 5')).rows; }
    catch (e) { /* table may not exist yet, or the database is down - already reported via database.ok */ }
  }

  const problems = [];
  if (!state || !state.enabled) problems.push('paper bot disabled (PAPER_BOT_ENABLED=false)');
  else if (!state.ready) problems.push('paper bot still starting');
  if (!db.ok) problems.push(`database: ${db.error}`);
  if (staleJobs.length) problems.push(`no scan in 15+ min: ${staleJobs.join(', ')}`);
  if (snap.errors.length) problems.push(`${snap.errors.length} recent error(s)`);

  return {
    paperOnly: true,
    status: problems.length ? 'PROBLEM' : 'ALIVE',
    reason: problems.length ? problems.join('; ') : 'all modules scanning, database ok, no recent errors',
    asOf: new Date(now).toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage ? { rssMb: Math.round(process.memoryUsage().rss / 1048576) } : null,
    jobs,
    dataSources,
    database: db,
    openTrades,
    today,
    recentErrors: snap.errors,
    recentAlerts,
  };
}

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function htmlPage(h) {
  const color = h.status === 'ALIVE' ? '#1a7f37' : '#c23';
  const row = (label, value) => `<tr><td style="padding:4px 8px;color:#666">${esc(label)}</td><td style="padding:4px 8px"><b>${esc(value)}</b></td></tr>`;
  const jobRows = Object.entries(h.jobs).map(([name, j]) => row(name, j.lastRunAt ? `${j.minutesAgo}m ago${j.stale ? ' (stale)' : ''}` : 'never')).join('');
  const sourceRows = Object.entries(h.dataSources).map(([name, s]) => row(name, s.status === 'unchecked' ? `unchecked (${s.note})` : `${s.status} (${s.ok} ok, ${s.fail} fail${s.lastError ? `, last error: ${s.lastError}` : ''})`)).join('');
  const errRows = h.recentErrors.length
    ? `<h2>Recent errors</h2><ul>${h.recentErrors.map((e) => `<li>${esc(new Date(e.at).toISOString())} - ${esc(e.job)}: ${esc(e.message)}</li>`).join('')}</ul>`
    : '';
  const alertRows = (h.recentAlerts || []).length
    ? `<h2>Alerts</h2><ul>${h.recentAlerts.map((a) => `<li>${esc(new Date(a.created_at).toISOString())} - ${esc(a.kind)} (${esc(a.subject)}): ${esc(a.message)}</li>`).join('')}</ul>`
    : '';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Paper bot health</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:16px">
<h1 style="color:${color};font-size:28px;margin:8px 0">${esc(h.status)}</h1>
<p>${esc(h.reason)}</p>
<table style="width:100%;border-collapse:collapse;font-size:14px">
${row('as of', h.asOf)}
${row('uptime', `${Math.round(h.uptimeSeconds / 60)} min`)}
${row('memory', h.memory ? `${h.memory.rssMb} MB` : 'n/a')}
${jobRows}
${sourceRows}
${row('database', h.database.ok ? 'ok' : `FAIL (${h.database.error})`)}
${row('open trades (nse)', h.openTrades.nse ?? 'n/a')}
${row('open trades (crypto)', h.openTrades.crypto ?? 'n/a')}
${row('today trades', h.today.trades ?? 'n/a')}
${row('today skips', h.today.skips ?? 'n/a')}
</table>
${errRows}
${alertRows}
</body></html>`;
}

/**
 * Mounts GET /api/paper/health. Reuses the same secret check as the other /api/paper/ admin routes.
 * `state` is the mutable state object attachPaperBot builds: state.store is null until the bot is enabled
 * and ready, so it is read fresh on every request rather than captured once at wiring time.
 */
function attachHealthRoute(app, { secret, okSecret, tracker, state }) {
  app.get('/api/paper/health', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).type('text').send('Unauthorized');
    try {
      const h = await buildHealth({ tracker, store: state.store, state, now: Date.now() });
      if (req.query.format === 'json') return res.json(h);
      res.type('html').send(htmlPage(h));
    } catch (e) {
      res.status(500).type('text').send('could not build health snapshot');
    }
  });
}

module.exports = { createHealthTracker, defaultTracker, buildHealth, attachHealthRoute, htmlPage, JOB_NAMES, STALE_MS };
