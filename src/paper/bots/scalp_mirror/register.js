'use strict';
// scalp-MIRROR and scalp_wide-MIRROR (docs/BOTS.md "Mirror bots"): for every trade scalp / scalp_wide
// takes, opens the OPPOSITE trade (same entry price/time and qty, direction flipped, target/stop swapped
// - mirror target = the original's own stop price, mirror stop = the original's own target price) in its
// own table, own virtual balance, never shared with the original. The originals
// (src/paper/scalp/bot.js, wired from paperbot/index.js, NOT a bots/ plugin) are untouched: this plugin
// only READS the shared `paper_trades` table they already write to (ctx.store), filtered by their own
// market key, and never writes to it. Auto-loaded by src/paper/pluginLoader.js (this folder has its own
// register.js, unlike scalp/ itself). Switch: PAPER_SCALP_MIRROR_ENABLED (default on, follows
// PAPER_SCALP_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settle } = require('../../scalp/engine');
const { loadScalpConfig, loadScalpWideConfig } = require('../../scalp/config');
const { MARKET, MARKET_WIDE } = require('../../scalp/bot');
const { summarise } = require('../../scalp/report');

module.exports = {
  name: 'scalp_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_SCALP_MIRROR_ENABLED !== undefined ? env.PAPER_SCALP_MIRROR_ENABLED !== 'false' : env.PAPER_SCALP_ENABLED !== 'false';

    const tightStore = pool ? createPgMirrorStore(pool, 'scalp_mirror_trades') : createMemoryMirrorStore();
    const wideStore = pool ? createPgMirrorStore(pool, 'scalp_wide_mirror_trades') : createMemoryMirrorStore();
    ctx.scalpMirrorMemoryStore = tightStore; // so telegram-alerts / leaderboard can read them even without a pool
    ctx.scalpWideMirrorMemoryStore = wideStore;

    const report = (store, mirrorOf, loadCfg) => async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadCfg(mainStore);
        const closed = await store.closedTrades();
        const open = await store.allOpenTrades();
        return res.json({ paperOnly: true, enabled: on, mirrorOf, summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await store.listTrades(20) });
      } catch (e) {
        return res.status(500).type('text').send(`could not read ${mirrorOf}_mirror data`);
      }
    };
    app.get('/api/paper/scalp-mirror-report', report(tightStore, 'scalp', loadScalpConfig));
    app.get('/api/paper/scalp-wide-mirror-report', report(wideStore, 'scalp_wide', loadScalpWideConfig));

    if (!on) { log('[scalp_mirror] disabled'); return; }

    const originalAdapter = (market) => ({ allOpenTrades: () => mainStore.openTrades(market), closedTrades: () => mainStore.closedTrades(market) });
    const tightBot = createMirrorBot({ originalStore: originalAdapter(MARKET), mirrorStore: tightStore, settle, loadCfg: () => loadScalpConfig(mainStore), log, label: 'scalp_mirror' });
    const wideBot = createMirrorBot({ originalStore: originalAdapter(MARKET_WIDE), mirrorStore: wideStore, settle, loadCfg: () => loadScalpWideConfig(mainStore), log, label: 'scalp_wide_mirror' });

    const tightSyncFn = guarded('scalp_mirror sync', track('scalpMirrorSync', tightBot.sync), log);
    const wideSyncFn = guarded('scalp_wide_mirror sync', track('scalpWideMirrorSync', wideBot.sync), log);
    cron.schedule('38 * * * * *', tightSyncFn, tz);
    cron.schedule('42 */5 * * * *', wideSyncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { scalpMirrorSync: tightSyncFn, scalpWideMirrorSync: wideSyncFn });
    tightSyncFn().then((r) => log(`[scalp_mirror] startup sync: opened ${r.opened}, closed ${r.closed}`)).catch((e) => log(`[scalp_mirror] startup sync failed: ${e.message}`));
    wideSyncFn().then((r) => log(`[scalp_wide_mirror] startup sync: opened ${r.opened}, closed ${r.closed}`)).catch((e) => log(`[scalp_wide_mirror] startup sync failed: ${e.message}`));
    log('[scalp_mirror] ready (PAPER ONLY, labels "scalp-MIRROR" / "scalp_wide-MIRROR"; reports: /api/paper/scalp-mirror-report, /api/paper/scalp-wide-mirror-report)');
  },
};
