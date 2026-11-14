'use strict';
// Paper-trading bot (DEMO ONLY): wiring into the existing backend process.
// - No broker order API is called anywhere in paperbot/. It only reads market
//   data and writes its own tables.
// - Switch: PAPER_BOT_ENABLED (default true). Set it to "false" to turn the
//   whole bot off; the read-only admin routes then answer 503.
const crypto = require('crypto');
const { createBot } = require('./bot');
const { createMemoryStore, createPgStore, createCachedStore } = require('./store');
const { createNseSource, createCryptoSource } = require('./sources');
const { createReporter } = require('./report');
const { createYahooSource } = require('./yahoo');
const { buildReport, chartData } = require('./reportPage');
const { loadUniverse } = require('./yahoo');
const { loadConfig, DEFAULTS, merge } = require('./config');
const { istParts, nseSession } = require('./time');
const { defaultTracker, attachHealthRoute } = require('../src/paper/ops/health'); // overnight glance page: GET /api/paper/health
const { newsScore, eventBlock } = require('../src/paper/context/news');
const { attachNewsCheckRoute } = require('../src/paper/context/newsCheck'); // GET /api/paper/news-check
const { attachHomeRoute } = require('../src/paper/ops/home'); // GET /api/paper/home

// The bot has its OWN database: PAPER_DATABASE_URL (any Postgres URL, for
// example a free Supabase project, direct port 5432 or the pooler). It never
// reads DATABASE_URL. Without PAPER_DATABASE_URL everything is kept in memory.
// Connection: at most 2, opened only when the first query runs (lazy), closed
// again when idle. SSL is always on for a remote host.
function pgOptions(url) {
  let connectionString = url;
  let local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  try {
    const u = new URL(url);
    local = ['localhost', '127.0.0.1'].includes(u.hostname);
    // pg would let sslmode in the URL override the ssl option below; Supabase
    // certificates are signed by Supabase's own CA, so strict checking fails.
    for (const k of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) u.searchParams.delete(k);
    connectionString = u.toString();
  } catch (e) { /* not a parseable URL: hand it to pg as it is */ }
  return {
    connectionString, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, allowExitOnIdle: true,
    ssl: local ? false : { rejectUnauthorized: false }, // encrypted; certificate chain not verified (see docs/DECISIONS-PENDING.md)
  };
}

function buildStore(env, log) {
  if (!env.PAPER_DATABASE_URL) {
    log('[paperbot] PAPER_DATABASE_URL is not set: paper trades are kept in memory only and are lost on restart. Summaries still go to Telegram.');
    return createMemoryStore();
  }
  const makePool = () => {
    const { Pool } = require('pg');
    const pool = new Pool(pgOptions(env.PAPER_DATABASE_URL));
    pool.on('error', (e) => log(`[paperbot] database error: ${e.message}`));
    return pool;
  };
  return createCachedStore(createPgStore(makePool));
}

// Rules as stored, laid over the defaults. Reads only (the report routes must not write).
const loadConfigReadOnly = async (store) => merge(DEFAULTS, await store.getConfig());

// What the bot scans and how the top stocks are picked (GET /api/paper/universe, docs/UNIVERSE.md).
function universeInfo({ live, fallback, cfg }) {
  return {
    paperOnly: true,
    nse: {
      whenDhanIsLive: { source: 'Dhan live quotes: the basket of the site Movers page (Nifty 50 list in server.js)', count: live.length, symbols: live },
      whenDhanIsDown: { source: 'Yahoo Finance chart feed, SYMBOL.NS, delayed (data/nse-fno-top60.json)', count: fallback.length, symbols: fallback },
      liquidityFilter: `traded value today (price x volume) of at least Rs ${cfg.nse.min_turnover_inr.toLocaleString('en-IN')}`,
      candleFilter: `at least ${cfg.nse.min_candles} closed 5-minute candles and 15 closed 15-minute candles; latest candle at most 2 candles old (plus up to ${cfg.nse.yahoo_max_delay_sec} s on the delayed Yahoo feed)`,
      ranking: 'risk-reward R factor = target distance / stop distance, better of the long and the short side (docs/R-FACTOR.md)',
      picked: `top ${cfg.nse.top_n} by R factor every 5 minutes; ties go to the bigger move today, then A-Z`,
      hours: `Mon-Fri 09:15-15:30 IST, new entries until ${cfg.nse.no_new_entry_after_ist}, not on: ${cfg.nse.holidays.join(', ') || 'no holiday listed'}`,
    },
    crypto: { source: 'Binance public 5-minute candles', symbols: cfg.crypto.symbols, picked: `every coin with a momentum score of at least ${cfg.crypto.min_momentum_score}; one open trade per coin, no daily limit` },
  };
}

// Runs a job, never lets it overlap with itself, never lets it crash the server.
function guarded(name, fn, log) {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try { await fn(); } catch (e) { log(`[paperbot] ${name} failed: ${e.response?.status || e.message}`); } finally { busy = false; }
  };
}

function attachPaperBot({ app, cron, axios, deps, env = process.env, log = console.log, wakeDelayMs = 60000 }) {
  const enabled = env.PAPER_BOT_ENABLED !== 'false';
  const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET || '';
  const state = { enabled, store: null, ready: false, holidays: DEFAULTS.nse.holidays };

  // Keep-alive for the Render free plan: an external free pinger calls this
  // every 5 minutes. No database, no auth, no secrets, nothing is changed.
  app.get('/api/paper/ping', (req, res) => {
    const p = istParts(Date.now());
    const session = nseSession(Date.now(), state.holidays);
    res.set('Cache-Control', 'no-store').json({ ok: true, paperOnly: true, botEnabled: enabled, istDate: p.date, istTime: p.hhmm, insideMarketHours: session.open, marketNote: session.reason || 'NSE open (09:15-15:30 IST)', cryptoAlwaysOpen: true });
  });

  // Read-only admin routes (GET only). Protected by PAPER_ADMIN_SECRET (or
  // RENEW_SECRET) sent as the x-paper-secret header or ?key=.
  const okSecret = (given) => {
    if (!secret || typeof given !== 'string') return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(a, b);
  };
  require('../src/paper/ops/cookieAuth').attachCookieAuth(app, { okSecret, log }); // ?key= sets an HttpOnly cookie + redirects to the clean URL; ?key= still works

  // `read(limit)` answers { rows }; `custom(req)` answers { status?, body } for routes with their own shape.
  const route = (pathname, read, custom = null) => app.get(pathname, async (req, res) => {
    if (!secret) return res.status(503).json({ error: 'PAPER_ADMIN_SECRET not configured' });
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).json({ error: 'Unauthorized' });
    if (!enabled || !state.ready) return res.status(503).json({ error: enabled ? 'paper bot is starting' : 'paper bot is disabled (PAPER_BOT_ENABLED=false)' });
    try {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      if (custom) { const out = await custom(req); return res.status(out.status || 200).json(out.body); }
      res.json({ paperOnly: true, storage: state.store.kind, rows: await read(req.query.limit) });
    } catch (e) {
      res.status(500).json({ error: 'could not read paper bot data' });
    }
  });
  route('/api/paper/summaries', (limit) => state.store.listSummaries(limit));
  route('/api/paper/trades', (limit) => state.store.listTrades(limit));
  route('/api/paper/skips', (limit) => state.store.listSkips(limit));

  const healthTracker = defaultTracker(); // shared with the alerts plugin (src/paper/ops/alerts/), if loaded
  attachHealthRoute(app, { secret, okSecret, tracker: healthTracker, state });
  attachNewsCheckRoute(app, { secret, okSecret, newsScore, eventBlock });
  attachHomeRoute(app, { secret, okSecret, tracker: healthTracker, state });

  // Read-only report page (plain HTML, for a phone). Same secret, sent as ?key= (or the x-paper-secret header).
  app.get('/api/paper/report', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
    if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).type('text').send('Unauthorized');
    if (!enabled || !state.ready) return res.status(503).type('text').send(enabled ? 'paper bot is starting' : 'paper bot is disabled (PAPER_BOT_ENABLED=false)');
    try {
      res.type('html').send(await buildReport({ store: state.store }));
    } catch (e) {
      res.status(500).type('text').send('could not read paper bot data');
    }
  });

  // Candles, markers and SL / target lines of one trade, for the chart on the report page. Read-only.
  route('/api/paper/chart', null, async (req) => {
    const id = Number(req.query.id);
    if (!Number.isSafeInteger(id) || id < 1) return { status: 400, body: { error: 'id must be a trade number' } };
    const data = await chartData({ store: state.store, nse: state.nse, crypto: state.crypto, id });
    return data ? { body: data } : { status: 404, body: { error: 'no such trade' } };
  });

  // The exact lists the bot scans (docs/UNIVERSE.md says the same in words). Read-only.
  route('/api/paper/universe', null, async () => {
    let cfg = DEFAULTS;
    try { cfg = await loadConfigReadOnly(state.store); } catch (e) { /* database not reachable: show the default rules */ }
    return { body: universeInfo({ live: deps.universe || [], fallback: loadUniverse(), cfg }) };
  });

  if (!enabled) { log('[paperbot] disabled (PAPER_BOT_ENABLED=false)'); return state; }

  const store = buildStore(env, log);
  state.store = store;
  const yahoo = createYahooSource({ axios, log }); // free NSE candle fallback, asked only when Dhan has no data
  const nse = createNseSource({ axios, log, yahoo, ...deps });
  const cryptoSrc = createCryptoSource({ axios, log });
  state.nse = nse;
  state.crypto = cryptoSrc;
  const judgeOn = String(env.PAPER_JUDGE_ON ?? 'true').toLowerCase() !== 'false'; // the judge decides NSE entries (docs/JUDGE.md); PAPER_JUDGE_ON=false switches it off
  const bot = createBot({ store, nse, crypto: cryptoSrc, log, onConfig: (cfg) => { state.holidays = cfg.nse.holidays; }, judgeOn });
  const reporter = createReporter({ store, axios, env, log, loadConfig });
  const tz = { timezone: 'Asia/Kolkata' };
  const job = (name, fn) => guarded(name, fn, log);
  const jobs = {
    nseScan: job('nse scan', healthTracker.wrap('nseScan', bot.nseScan)), nseMonitor: job('nse monitor', healthTracker.wrap('nseMonitor', bot.nseMonitor)),
    cryptoScan: job('crypto scan', healthTracker.wrap('cryptoScan', bot.cryptoScan)), cryptoMonitor: job('crypto monitor', healthTracker.wrap('cryptoMonitor', bot.cryptoMonitor)),
  };
  state.ready = true; // the database is only opened when the first job needs it
  log(`[paperbot] ready (PAPER ONLY, storage: ${store.kind}, Telegram: ${env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? 'on' : 'off, summaries are only stored'})`);

  // Sleep / wake (Render free plan): a wake is a fresh start. One minute after
  // start the bot looks at open trades and at the CURRENT candle only. Missed
  // candles are never replayed, a candle is traded at most once (trigger time
  // is checked against the stored trades), and data older than 2 candles is refused.
  setTimeout(async () => {
    log('[paperbot] wake catch-up: open trades and the current candle only');
    await jobs.nseMonitor(); await jobs.nseScan(); await jobs.cryptoMonitor(); await jobs.cryptoScan();
  }, wakeDelayMs).unref();

  // Live price samples for the fallback candle builder (memory only).
  setInterval(() => { try { nse.sample(); } catch (e) { /* sampling must never break the server */ } }, 10000).unref();

  require('../src/paper/scalp').attachScalp({ app, cron, axios, env, log, state, store, crypto: cryptoSrc, secret, okSecret, enabled, guarded }); // scalp strategy + /api/paper/scalp-report (docs/SCALP.md)
  require('../src/paper/replay').attachReplay({ app, cron, axios, env, log, secret, okSecret, enabled, guarded, liveStore: store }); // replay engine + /api/paper/replay-report (docs/REPLAY.md)

  // Auto-load bots/ops plugins (docs/BOT-INTERFACE.md, src/paper/pluginLoader.js).
  // Fire-and-forget: a plugin failing to load must never stop the bot itself.
  require('../src/paper/pluginLoader').loadPlugins({
    app, cron, env, log, state, store, guarded, tz,
    pool: typeof store.query === 'function' ? { query: store.query } : null,
  }).catch((e) => log(`[paper-plugins] loadPlugins failed: ${e.message}`));

  cron.schedule('20 */5 9-15 * * 1-5', jobs.nseScan, tz); // 20 s after each 5-min candle closes
  cron.schedule('50 * 9-15 * * 1-5', jobs.nseMonitor, tz); // exits checked every minute
  cron.schedule('25 */5 * * * *', jobs.cryptoScan, tz);
  cron.schedule('55 * * * * *', jobs.cryptoMonitor, tz);
  cron.schedule('45 15 * * 1-5', job('nse summary', async () => {
    const cfg = await loadConfig(store);
    if (cfg.nse.holidays.includes(istParts(Date.now()).date)) return; // no summary on an NSE holiday
    await reporter.daily('nse');
  }), tz);
  cron.schedule('55 23 * * *', job('crypto summary', () => reporter.daily('crypto')), tz);
  cron.schedule('0 10 * * 0', job('weekly suggestions', reporter.weekly), tz);
  return state;
}

module.exports = { attachPaperBot, guarded, buildStore, pgOptions, universeInfo };
