'use strict';
// scalp_wide-REVERSE: for every trade scalp_wide takes, opens a trade in the SAME direction as
// scalp_wide-MIRROR (opposite of the original), but with its OWN proper levels instead of the mirror's
// swapped ones: stop at the distance of the original's own stop from entry, target at 2x that distance
// (reward:risk 2.0) - src/paper/lib/reverse.js. Modelled on src/paper/bots/scalp_mirror/register.js for
// the wiring/routes; the entry math and the exit mechanism (own candle monitor reusing scalp_wide's own
// evaluateExit(), not a patch on the original's close) are the real differences - see
// src/paper/lib/reverseBot.js's file header. plain scalp (crypto_scalp) has NO reverse bot - only
// scalp_wide, as asked.
//
// The original (src/paper/scalp/bot.js) and scalp_wide-MIRROR are both untouched: this plugin only READS
// the shared paper_trades table (ctx.store, market 'crypto_wide_scalp') and the shared crypto candle
// source (ctx.cachedCrypto) for its OWN monitor - it never writes to either. Auto-loaded by
// src/paper/pluginLoader.js. Switch: PAPER_SCALP_WIDE_REVERSE_ENABLED (default on, follows
// PAPER_SCALP_ENABLED, same convention as scalp_wide-MIRROR).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createReverseBot } = require('../../lib/reverseBot');
const { settle, evaluateExit } = require('../../scalp/engine');
const { closedOnly } = require('../../../../paperbot/engine');
const { loadScalpWideConfig } = require('../../scalp/config');
const { MARKET_WIDE } = require('../../scalp/bot');
const { recoveryLimit } = require('../../lib/recoveryWindow');
const { summarise } = require('../../scalp/report');

const TABLE = 'scalp_wide_reverse_trades';
const LABEL = 'scalp_wide-REVERSE';
const FIVE_MIN = 300000;

// Same exit rule scalp_wide's own monitor uses (src/paper/scalp/engine.js's evaluateExit: target, stop,
// breakeven, 45-minute time stop) - just against the reverse trade's OWN target/stop, never the
// original's. Returns `timeMs` (the candle's own time), matching scalp_wide's own exit_time convention.
function evaluateExitFn(trade, rawCandles, nowMs, cfg) {
  const ev = evaluateExit({ trade, candles: closedOnly(rawCandles, FIVE_MIN, nowMs), nowMs, cfg });
  return ev.exit ? { exit: true, reason: ev.reason, price: ev.price, timeMs: ev.timeMs } : { exit: false };
}

module.exports = {
  name: 'scalp_wide_reverse',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null, cachedCrypto } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_SCALP_WIDE_REVERSE_ENABLED !== undefined ? env.PAPER_SCALP_WIDE_REVERSE_ENABLED !== 'false' : env.PAPER_SCALP_ENABLED !== 'false';

    const rStore = pool ? createPgMirrorStore(pool, TABLE) : createMemoryMirrorStore();
    ctx.scalpWideReverseMemoryStore = rStore; // so telegram-alerts / the daily report can read it even without a pool

    app.get('/api/paper/scalp-wide-reverse-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadScalpWideConfig(mainStore);
        const closed = await rStore.closedTrades();
        const open = await rStore.allOpenTrades();
        return res.json({ paperOnly: true, enabled: on, reverseOf: 'scalp_wide', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await rStore.listTrades(20) });
      } catch (e) {
        return res.status(500).type('text').send('could not read scalp_wide_reverse data');
      }
    });

    if (!on) { log('[scalp_wide_reverse] disabled'); return; }

    const originalStore = { allOpenTrades: () => mainStore.openTrades(MARKET_WIDE), closedTrades: () => mainStore.closedTrades(MARKET_WIDE) };
    const fetchCandles = async (symbol, entryMs) => {
      if (!cachedCrypto) return [];
      const limit = recoveryLimit({ oldestEntryMs: entryMs, nowMs: Date.now(), intervalMs: FIVE_MIN, defaultLimit: 330 });
      return cachedCrypto.candles(symbol, limit);
    };
    const bot = createReverseBot({ originalStore, reverseStore: rStore, fetchCandles, evaluateExitFn, settle, loadCfg: () => loadScalpWideConfig(mainStore), log, label: 'scalp_wide_reverse' });

    const syncFn = guarded('scalp_wide_reverse sync', track('scalpWideReverseSync', bot.sync), log);
    const monitorFn = guarded('scalp_wide_reverse monitor', track('scalpWideReverseMonitor', bot.monitor), log);
    cron.schedule('24 */5 * * * *', syncFn, tz); // unused second-offset (every schedule across bots/ checked)
    cron.schedule('54 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { scalpWideReverseSync: syncFn, scalpWideReverseMonitor: monitorFn });
    syncFn().then((r) => log(`[scalp_wide_reverse] startup sync: opened ${r.opened}`)).catch((e) => log(`[scalp_wide_reverse] startup sync failed: ${e.message}`));
    log(`[scalp_wide_reverse] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/scalp-wide-reverse-report)`);
  },
};
