'use strict';
// intraday-REVERSE: for every trade the main crypto bot ("intraday" - paperbot/bot.js's
// cryptoScan/cryptoMonitor) takes, opens a trade in the SAME direction as intraday-MIRROR (opposite of
// the original), but with its OWN proper levels instead of the mirror's swapped ones: stop at the
// distance of the original's own stop from entry, target at 2x that distance (reward:risk 2.0) -
// src/paper/lib/reverse.js. Modelled directly on src/paper/bots/intraday_mirror/register.js for the
// wiring/routes; the entry math and the exit mechanism (own candle monitor, not a patch on the
// original's close) are the real differences - see src/paper/lib/reverseBot.js's file header.
//
// The original bot (paperbot/bot.js) and intraday-MIRROR are both untouched: this plugin only READS the
// shared paper_trades table (ctx.store) for the 'crypto' market, and the shared crypto candle source
// (ctx.cachedCrypto, the same cache every other bots/ plugin already shares) for its OWN monitor - it
// never writes to either. Auto-loaded by src/paper/pluginLoader.js.
//
// Switch: PAPER_INTRADAY_REVERSE_ENABLED (default on, follows PAPER_BOT_ENABLED, same convention as
// intraday-MIRROR).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createReverseBot } = require('../../lib/reverseBot');
const { settle, closedOnly } = require('../../../../paperbot/engine');
const { FIVE_MIN } = require('../../../../paperbot/sources');
const { loadConfig } = require('../../../../paperbot/config');
const { recoveryLimit } = require('../../lib/recoveryWindow');
const { simulateExit } = require('../../lib/exitSim');
const { summarise } = require('../../scalp/report');

const TABLE = 'intraday_reverse_trades';
const LABEL = 'intraday-REVERSE';
const MARKET = 'crypto'; // the main crypto bot's own market key in the shared paper_trades table

async function loadCfg(mainStore) {
  const full = await loadConfig(mainStore);
  return { ...full.crypto, min_trades_for_conclusion: full.learning.min_trades_for_conclusion };
}

// Same exit rule the original crypto bot's own cryptoMonitor uses (src/paper/lib/exitSim.js's
// simulateExit, walked candle-by-candle since entry) - just against the reverse trade's OWN
// target/stop, never the original's.
function evaluateExitFn(trade, rawCandles, nowMs, cfg) {
  const short = trade.direction === 'SHORT';
  const candles = closedOnly(rawCandles, FIVE_MIN, nowMs).filter((k) => k.t + FIVE_MIN > Date.parse(trade.entry_time));
  if (!candles.length) return { exit: false };
  const sim = simulateExit({ entry: trade.entry_price, target: trade.target_price, stop: trade.sl_price, short, breakevenAt: cfg.breakeven_at ?? 0.5, candles });
  return sim.exit ? { exit: true, reason: sim.reason, price: sim.price } : { exit: false };
}

module.exports = {
  name: 'intraday_reverse',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null, cachedCrypto } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_INTRADAY_REVERSE_ENABLED !== undefined ? env.PAPER_INTRADAY_REVERSE_ENABLED !== 'false' : env.PAPER_BOT_ENABLED !== 'false';

    const rStore = pool ? createPgMirrorStore(pool, TABLE) : createMemoryMirrorStore();
    ctx.intradayReverseMemoryStore = rStore; // so telegram-alerts / the daily report can read it even without a pool

    app.get('/api/paper/intraday-reverse-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadCfg(mainStore);
        const closed = await rStore.closedTrades();
        const open = await rStore.allOpenTrades();
        const data = { paperOnly: true, enabled: on, reverseOf: 'intraday', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await rStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read intraday_reverse data');
      }
    });

    if (!on) { log('[intraday_reverse] disabled'); return; }

    const originalStore = { allOpenTrades: () => mainStore.openTrades(MARKET), closedTrades: () => mainStore.closedTrades(MARKET) };
    const fetchCandles = async (symbol, entryMs) => {
      if (!cachedCrypto) return [];
      const limit = recoveryLimit({ oldestEntryMs: entryMs, nowMs: Date.now(), intervalMs: FIVE_MIN, defaultLimit: 330 });
      return cachedCrypto.candles(symbol, limit);
    };
    const bot = createReverseBot({ originalStore, reverseStore: rStore, fetchCandles, evaluateExitFn, settle, loadCfg: () => loadCfg(mainStore), log, label: 'intraday_reverse' });

    const syncFn = guarded('intraday_reverse sync', track('intradayReverseSync', bot.sync), log);
    const monitorFn = guarded('intraday_reverse monitor', track('intradayReverseMonitor', bot.monitor), log);
    cron.schedule('17 * * * * *', syncFn, tz); // unused second-offset (docs/BOTS.md mirror schedules + intraday_mirror's own :33 already taken)
    cron.schedule('47 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { intradayReverseSync: syncFn, intradayReverseMonitor: monitorFn });
    syncFn().then((r) => log(`[intraday_reverse] startup sync: opened ${r.opened}`)).catch((e) => log(`[intraday_reverse] startup sync failed: ${e.message}`));
    log(`[intraday_reverse] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/intraday-reverse-report)`);
  },
};
