'use strict';
// ccy_gbpinr-MIRROR (docs/BOTS.md "Mirror bots"): for every trade ccy_gbpinr takes, opens the OPPOSITE
// trade (same entry price/time and qty, direction flipped, target/stop swapped) in its own table, own
// virtual balance - never shared with the original. ccy_gbpinr itself (src/paper/bots/ccy_gbpinr/) is
// untouched: this plugin only READS its store (ctx.ccyGbpinrMemoryStore, set by ccy_gbpinr/register.js,
// which the loader always runs first - this folder name sorts after it), never writes to it. Reuses the
// SAME generic createMirrorBot()/mirror.js every other <bot>_mirror/register.js reuses (no mirror logic
// re-implemented here) and settleInr() from src/paper/lib/currencyEngine.js (never alert-formatting code,
// never mirrorStore.js internals - both only called, never edited). Switch: PAPER_CCY_GBPINR_MIRROR_ENABLED (default on,
// follows PAPER_CCY_GBPINR_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settleInr } = require('../../lib/currencyEngine');
const { loadConfig } = require('../ccy_gbpinr/config');
const { summarise } = require('../../scalp/report');

module.exports = {
  name: 'ccy_gbpinr_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_CCY_GBPINR_MIRROR_ENABLED !== undefined ? env.PAPER_CCY_GBPINR_MIRROR_ENABLED !== 'false' : env.PAPER_CCY_GBPINR_ENABLED !== 'false';

    const mirrorStore = pool ? createPgMirrorStore(pool, 'ccy_gbpinr_mirror_trades') : createMemoryMirrorStore();
    ctx.ccyGbpinrMirrorMemoryStore = mirrorStore; // so telegram-alerts / leaderboard can read it even without a pool

    app.get('/api/paper/ccy-gbpinr-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadConfig(mainStore);
        const closed = await mirrorStore.closedTrades();
        const open = await mirrorStore.allOpenTrades();
        return res.json({ paperOnly: true, enabled: on, mirrorOf: 'ccy_gbpinr', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mirrorStore.listTrades(20) });
      } catch (e) {
        return res.status(500).type('text').send('could not read ccy_gbpinr_mirror data');
      }
    });

    if (!on) { log('[ccy_gbpinr_mirror] disabled'); return; }

    // ccy_gbpinr has its OWN table (never a row in the shared paper_trades), reached the same way
    // telegramAlerts/register.js and leaderboard/register.js already read every other own-table bot: the
    // ctx key its own register.js sets (ctx.ccyGbpinrMemoryStore) BEFORE this plugin loads
    // (src/paper/pluginLoader.js loads bots/ in directory order - "ccy_gbpinr" sorts before
    // "ccy_gbpinr_mirror"). If ccy_gbpinr is disabled or has not registered yet, the property is
    // simply absent and this mirror has nothing to mirror (empty arrays, never a crash).
    const originalAdapter = {
      allOpenTrades: () => (ctx.ccyGbpinrMemoryStore ? ctx.ccyGbpinrMemoryStore.allOpenTrades() : []),
      closedTrades: () => (ctx.ccyGbpinrMemoryStore ? ctx.ccyGbpinrMemoryStore.closedTrades() : []),
    };
    const bot = createMirrorBot({ originalStore: originalAdapter, mirrorStore, settle: settleInr, loadCfg: () => loadConfig(mainStore), log, label: 'ccy_gbpinr_mirror' });

    const syncFn = guarded('ccy_gbpinr_mirror sync', track('ccyGbpinrMirrorSync', bot.sync), log);
    cron.schedule('55 * * * * *', syncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { ccyGbpinrMirrorSync: syncFn });
    syncFn().then((r) => log('[ccy_gbpinr_mirror] startup sync: opened ' + r.opened + ', closed ' + r.closed)).catch((e) => log('[ccy_gbpinr_mirror] startup sync failed: ' + e.message));
    log('[ccy_gbpinr_mirror] ready (PAPER ONLY, label "ccy_gbpinr-MIRROR"; report: /api/paper/ccy-gbpinr-mirror-report)');
  },
};
