'use strict';
// Paper-trading bot (DEMO ONLY): wiring into the existing backend process.
// - No broker order API is called anywhere in paperbot/. It only reads market
//   data and writes its own tables.
// - Switch: PAPER_BOT_ENABLED (default true). Set it to "false" to turn the
//   whole bot off; the read-only admin routes then answer 503.
const crypto = require('crypto');
const { createBot } = require('./bot');
const { createMemoryStore, createPgStore } = require('./store');
const { createNseSource, createCryptoSource } = require('./sources');
const { createReporter } = require('./report');
const { loadConfig } = require('./config');
const { istParts } = require('./time');

function buildStore(env, log) {
  if (!env.DATABASE_URL) {
    log('[paperbot] WARNING: DATABASE_URL is not set. Paper trades are kept in memory only and are lost on restart. Set DATABASE_URL (Neon) to keep them.');
    return createMemoryStore();
  }
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: env.DATABASE_URL, max: 3, ssl: /localhost|127\.0\.0\.1/.test(env.DATABASE_URL) ? false : { rejectUnauthorized: true } });
  pool.on('error', (e) => log(`[paperbot] database error: ${e.message}`));
  return createPgStore(pool);
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

function attachPaperBot({ app, cron, axios, deps, env = process.env, log = console.log }) {
  const enabled = env.PAPER_BOT_ENABLED !== 'false';
  const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET || '';
  const state = { enabled, store: null, ready: false };

  // Read-only admin routes (GET only). Protected by PAPER_ADMIN_SECRET (or
  // RENEW_SECRET) sent as the x-paper-secret header or ?key=.
  const okSecret = (given) => {
    if (!secret || typeof given !== 'string') return false;
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(secret).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const route = (pathname, read) => app.get(pathname, async (req, res) => {
    if (!secret) return res.status(503).json({ error: 'PAPER_ADMIN_SECRET not configured' });
    if (!okSecret(req.get('x-paper-secret') || req.query.key)) return res.status(401).json({ error: 'Unauthorized' });
    if (!enabled || !state.ready) return res.status(503).json({ error: enabled ? 'paper bot is starting' : 'paper bot is disabled (PAPER_BOT_ENABLED=false)' });
    try {
      res.set('Cache-Control', 'no-store').json({ paperOnly: true, storage: state.store.kind, rows: await read(req.query.limit) });
    } catch (e) {
      res.status(500).json({ error: 'could not read paper bot data' });
    }
  });
  route('/api/paper/summaries', (limit) => state.store.listSummaries(limit));
  route('/api/paper/trades', (limit) => state.store.listTrades(limit));
  route('/api/paper/skips', (limit) => state.store.listSkips(limit));

  if (!enabled) { log('[paperbot] disabled (PAPER_BOT_ENABLED=false)'); return state; }

  const store = buildStore(env, log);
  state.store = store;
  const nse = createNseSource({ axios, log, ...deps });
  const cryptoSrc = createCryptoSource({ axios, log });
  const bot = createBot({ store, nse, crypto: cryptoSrc, log });
  const reporter = createReporter({ store, axios, env, log, loadConfig });
  const tz = { timezone: 'Asia/Kolkata' };
  const when = () => state.ready;
  const job = (name, fn) => guarded(name, async () => { if (when()) await fn(); }, log);

  store.init().then(() => loadConfig(store)).then(() => {
    state.ready = true;
    log(`[paperbot] ready (PAPER ONLY, storage: ${store.kind}, Telegram: ${env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID ? 'on' : 'off, summaries stored in daily_summaries'})`);
  }).catch((e) => log(`[paperbot] could not start: ${e.message}`));

  // Live price samples for the fallback candle builder (memory only).
  setInterval(() => { try { nse.sample(); } catch (e) { /* sampling must never break the server */ } }, 10000).unref();

  cron.schedule('20 */5 9-15 * * 1-5', job('nse scan', bot.nseScan), tz); // 20 s after each 5-min candle closes
  cron.schedule('50 * 9-15 * * 1-5', job('nse monitor', bot.nseMonitor), tz); // exits checked every minute
  cron.schedule('25 */5 * * * *', job('crypto scan', bot.cryptoScan), tz);
  cron.schedule('55 * * * * *', job('crypto monitor', bot.cryptoMonitor), tz);
  cron.schedule('45 15 * * 1-5', job('nse summary', async () => {
    const cfg = await loadConfig(store);
    if (cfg.nse.holidays.includes(istParts(Date.now()).date)) return; // no summary on an NSE holiday
    await reporter.daily('nse');
  }), tz);
  cron.schedule('55 23 * * *', job('crypto summary', () => reporter.daily('crypto')), tz);
  cron.schedule('0 10 * * 0', job('weekly suggestions', reporter.weekly), tz);
  return state;
}

module.exports = { attachPaperBot, guarded };
