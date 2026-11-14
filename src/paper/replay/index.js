'use strict';
// Replay engine wiring: ONE hook called from paperbot/index.js, same pattern as src/paper/scalp/index.js.
// PAPER ONLY, runs on the Render server (not a sandbox) because Binance's public klines host is only
// reachable from there. PAPER_REPLAY_ENABLED (default true; "false" turns the whole lane off).
//   - history: catches up stored candles for BTCUSDT/ETHUSDT/SOLUSDT (1m/5m/15m/1h) on an interval, resumable
//   - GET /api/paper/replay-report (+&format=json): latest stored run, same secret as the other paper routes
//   - GET /api/paper/replay/run: starts a run in the background, same secret; answers immediately
//   - 02:00 IST daily automatic run, and once on startup if the watched code files changed since the last run
const { createHistoryClient, loadHistory } = require('./history');
const { createPgReplayStore, createMemoryReplayStore } = require('./store');
const { loadScalpConfig, SCALP_DEFAULTS } = require('../scalp/config');
const { runReplay } = require('./run');
const { runSweep } = require('./sweep');
const { codeVersion } = require('./codeVersion');

const SYMBOLS = SCALP_DEFAULTS.symbols;
const INTERVALS = ['1m', '5m', '15m', '1h'];
const HISTORY_DAYS = 30;

function buildReplayStore(env, log) {
  if (!env.PAPER_DATABASE_URL) {
    log('[replay] PAPER_DATABASE_URL is not set: replay history and results are kept in memory only, lost on restart.');
    return createMemoryReplayStore();
  }
  const { pgOptions } = require('../../../paperbot/index');
  const { Pool } = require('pg');
  const pool = new Pool(pgOptions(env.PAPER_DATABASE_URL));
  pool.on('error', (e) => log(`[replay] database error: ${e.message}`));
  return createPgReplayStore(() => pool);
}

function renderReport(result) {
  if (!result) return '<!doctype html><title>Replay</title><p>No replay run yet. GET /api/paper/replay/run?key=... to start one.</p>';
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const row = (label, m) => `<tr><td>${esc(label)}</td><td>${m.tooFew ? 'too few trades, no conclusion' : `${m.trades} trades, ${m.winRatePct}% win, net ₹${m.netInr}, avg win ₹${m.avgWinInr}, avg loss ₹${m.avgLossInr}, max DD ₹${m.maxDrawdownInr}, longest losing streak ${m.longestLosingStreak}`}</td></tr>`;
  const c = result.combined || {};
  return `<!doctype html><title>Replay report</title>
<p><b>Past data, not proof of future results.</b> Run #${esc(result.runId)}. Look-ahead check: ${result.lookAheadOk ? 'passed' : 'FAILED'}.</p>
<table border="1" cellpadding="4">
${row('Scalp, in-sample', c.base?.inSample || { tooFew: true })}
${row('Scalp, out-of-sample', c.base?.outSample || { tooFew: true })}
${row('Scalp, full 30 days', c.base?.full || { tooFew: true })}
${row('Random baseline (same stops/targets), full', c.randomBaseline?.full || { tooFew: true })}
${row('Doubled cost, full', c.doubledCost?.full || { tooFew: true })}
</table>
<p>Per-symbol detail, filter study and look-ahead checks: ?format=json</p>`;
}

function attachReplay({ app, cron, axios, env = process.env, log = console.log, secret, okSecret, enabled, guarded, now = Date.now, liveStore = null }) {
  const replayOn = env.PAPER_REPLAY_ENABLED !== 'false';
  const state = { store: null, running: false, lastResult: null };

  const route = (pathname, handler) => app.get(pathname, async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).type('text').send('Unauthorized');
    if (!enabled || !replayOn) return res.status(503).type('text').send('replay is disabled');
    try { await handler(req, res); } catch (e) { log(`[replay] route error: ${e.message}`); res.status(500).type('text').send('could not read replay data'); }
  });

  route('/api/paper/replay-report', async (req, res) => {
    const latest = await state.store.latestRun();
    let result = null;
    if (latest) {
      const resultsRows = await state.store.resultsForRun(latest.id);
      const trades = await state.store.tradesForRun(latest.id);
      const combined = {};
      for (const r of resultsRows) { combined[r.variant] = combined[r.variant] || {}; combined[r.variant][r.segment] = r.metrics; }
      result = { runId: latest.id, status: latest.status, startedAt: latest.started_at, finishedAt: latest.finished_at, error: latest.error, combined, trades: req.query.format === 'json' ? trades : undefined, lookAheadOk: latest.status !== 'failed' };
    }
    if (req.query.format === 'json') return res.json({ paperOnly: true, result });
    return res.type('html').send(renderReport(result));
  });

  route('/api/paper/replay/run', async (req, res) => {
    if (state.running) return res.json({ started: false, reason: 'a replay run is already in progress' });
    state.running = true;
    startRun(state, env, log, now, 'manual', liveStore).finally(() => { state.running = false; });
    res.json({ started: true, note: 'running in the background; poll /api/paper/replay-report' });
  });

  // Stop/target parameter sweep (brief "if time allows" extra): on demand only, one symbol at a time (it
  // is heavier than a normal run -- 25 cells by default). Suggestions only, nothing is applied automatically.
  route('/api/paper/replay/sweep', async (req, res) => {
    const symbol = String(req.query.symbol || SYMBOLS[0]);
    if (!SYMBOLS.includes(symbol)) return res.status(400).json({ error: `symbol must be one of ${SYMBOLS.join(', ')}` });
    const now_ = now();
    const windowStartMs = now_ - HISTORY_DAYS * 86400000;
    const [c1, c5] = await Promise.all([
      state.store.getCandles(symbol, '1m', { fromT: windowStartMs, toT: now_ }),
      state.store.getCandles(symbol, '5m', { fromT: windowStartMs, toT: now_ }),
    ]);
    const cfg = liveStore ? await loadScalpConfig(liveStore) : SCALP_DEFAULTS;
    if (c1.length < cfg.min_candles_1m || c5.length < cfg.min_candles_5m) return res.status(503).json({ error: 'not enough stored history for this symbol yet' });
    const result = runSweep({ symbol, candles1m: c1, candles5m: c5, cfg, windowStartMs, inSampleDays: 20 });
    res.json({ paperOnly: true, ...result });
  });

  if (!enabled || !replayOn) { log('[replay] disabled (PAPER_BOT_ENABLED=false or PAPER_REPLAY_ENABLED=false)'); return { enabled: false }; }
  state.store = buildReplayStore(env, log);

  // History catch-up: resumable, polite, small pages. Runs once shortly after start and then on an interval,
  // so it never blocks the live bot's own cron jobs and never holds more than one page of candles in memory.
  const client = createHistoryClient({ axios, log });
  const historyTick = guarded('replay history', async () => {
    const { errors } = await loadHistory({ client, store: state.store, symbols: SYMBOLS, intervals: INTERVALS, days: HISTORY_DAYS, now: now(), log });
    if (errors.length) log(`[replay] history catch-up had ${errors.length} error(s): ${JSON.stringify(errors)}`);
  }, log);
  setTimeout(historyTick, 15000).unref();
  cron.schedule('*/15 * * * *', historyTick);

  cron.schedule('0 2 * * *', guarded('replay run (scheduled)', () => startRun(state, env, log, now, 'scheduled', liveStore), log), { timezone: 'Asia/Kolkata' });

  // Also run once on startup if the watched code changed since the last stored run (brief item 6).
  setTimeout(async () => {
    try {
      const latest = await state.store.latestRun();
      if (!latest || latest.code_version !== codeVersion()) {
        // small delay so it runs after the first history catch-up has had a chance to add candles
        setTimeout(() => startRun(state, env, log, now, 'code_change', liveStore), 60000).unref();
      }
    } catch (e) { log(`[replay] could not check code version: ${e.message}`); }
  }, 20000).unref();

  log('[replay] ready (PAPER ONLY; report: /api/paper/replay-report, run: /api/paper/replay/run)');
  return { enabled: true, state };
}

// `liveStore` is the main paperbot store (paper_trades/paper_config), used ONLY to read the scalp config
// (so a rule change the owner made in paper_config is reflected here too); replay never writes to it.
// Without it (liveStore is null, e.g. the live store could not be built) the scalp defaults are used.
async function startRun(state, env, log, now, trigger, liveStore) {
  try {
    const cfg = liveStore ? await loadScalpConfig(liveStore) : SCALP_DEFAULTS;
    const result = await runReplay({ store: state.store, symbols: SYMBOLS, cfg, days: HISTORY_DAYS, inSampleDays: 20, now: now(), trigger, log });
    state.lastResult = result;
    log(`[replay] run #${result.runId} (${trigger}) done, look-ahead ${result.lookAheadOk ? 'passed' : 'FAILED'}`);
  } catch (e) {
    log(`[replay] run (${trigger}) failed: ${e.message}`);
  }
}

module.exports = { attachReplay, SYMBOLS, INTERVALS, HISTORY_DAYS };
