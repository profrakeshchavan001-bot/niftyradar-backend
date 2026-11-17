'use strict';
// ccy_jpyinr-MIRROR (docs/BOTS.md "Mirror bots"): for every trade ccy_jpyinr takes, opens the OPPOSITE
// trade (same entry price/time and qty, direction flipped, target/stop swapped) in its own table, own
// virtual balance - never shared with the original. ccy_jpyinr itself (src/paper/bots/ccy_jpyinr/) is
// untouched: this plugin only READS its store (ctx.ccyJpyinrMemoryStore, set by ccy_jpyinr/register.js,
// which the loader always runs first - this folder name sorts after it), never writes to it. Reuses the
// SAME generic createMirrorBot()/mirror.js every other <bot>_mirror/register.js reuses (no mirror logic
// re-implemented here) and settleInr() from src/paper/lib/currencyEngine.js (never alert-formatting code,
// never mirrorStore.js internals - both only called, never edited). Switch: PAPER_CCY_JPYINR_MIRROR_ENABLED (default on,
// follows PAPER_CCY_JPYINR_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settleInr } = require('../../lib/currencyEngine');
const { loadConfig } = require('../ccy_jpyinr/config');
const { summarise } = require('../../scalp/report');

module.exports = {
  name: 'ccy_jpyinr_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_CCY_JPYINR_MIRROR_ENABLED !== undefined ? env.PAPER_CCY_JPYINR_MIRROR_ENABLED !== 'false' : env.PAPER_CCY_JPYINR_ENABLED !== 'false';

    const mirrorStore = pool ? createPgMirrorStore(pool, 'ccy_jpyinr_mirror_trades') : createMemoryMirrorStore();
    ctx.ccyJpyinrMirrorMemoryStore = mirrorStore; // so telegram-alerts / leaderboard can read it even without a pool

    app.get('/api/paper/ccy-jpyinr-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadConfig(mainStore);
        const closed = await mirrorStore.closedTrades();
        const open = await mirrorStore.allOpenTrades();
        return res.json({ paperOnly: true, enabled: on, mirrorOf: 'ccy_jpyinr', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mirrorStore.listTrades(20) });
      } catch (e) {
        return res.status(500).type('text').send('could not read ccy_jpyinr_mirror data');
      }
    });

    if (!on) { log('[ccy_jpyinr_mirror] disabled'); return; }

    // ccy_jpyinr has its OWN table (never a row in the shared paper_trades), reached the same way
    // telegramAlerts/register.js and leaderboard/register.js already read every other own-table bot: the
    // ctx key its own register.js sets (ctx.ccyJpyinrMemoryStore) BEFORE this plugin loads
    // (src/paper/pluginLoader.js loads bots/ in directory order - "ccy_jpyinr" sorts before
    // "ccy_jpyinr_mirror"). If ccy_jpyinr is disabled or has not registered yet, the property is
    // simply absent and this mirror has nothing to mirror (empty arrays, never a crash).
    const originalAdapter = {
      allOpenTrades: () => (ctx.ccyJpyinrMemoryStore ? ctx.ccyJpyinrMemoryStore.allOpenTrades() : []),
      closedTrades: () => (ctx.ccyJpyinrMemoryStore ? ctx.ccyJpyinrMemoryStore.closedTrades() : []),
    };
    const bot = createMirrorBot({ originalStore: originalAdapter, mirrorStore, settle: settleInr, loadCfg: () => loadConfig(mainStore), log, label: 'ccy_jpyinr_mirror' });

    const syncFn = guarded('ccy_jpyinr_mirror sync', track('ccyJpyinrMirrorSync', bot.sync), log);
    cron.schedule('55 * * * * *', syncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { ccyJpyinrMirrorSync: syncFn });
    syncFn().then((r) => log('[ccy_jpyinr_mirror] startup sync: opened ' + r.opened + ', closed ' + r.closed)).catch((e) => log('[ccy_jpyinr_mirror] startup sync failed: ' + e.message));
    log('[ccy_jpyinr_mirror] ready (PAPER ONLY, label "ccy_jpyinr-MIRROR"; report: /api/paper/ccy-jpyinr-mirror-report)');
  },
};
