'use strict';
// ccy_eurinr-MIRROR (docs/BOTS.md "Mirror bots"): for every trade ccy_eurinr takes, opens the OPPOSITE
// trade (same entry price/time and qty, direction flipped, target/stop swapped) in its own table, own
// virtual balance - never shared with the original. ccy_eurinr itself (src/paper/bots/ccy_eurinr/) is
// untouched: this plugin only READS its store (ctx.ccyEurinrMemoryStore, set by ccy_eurinr/register.js,
// which the loader always runs first - this folder name sorts after it), never writes to it. Reuses the
// SAME generic createMirrorBot()/mirror.js every other <bot>_mirror/register.js reuses (no mirror logic
// re-implemented here) and settleInr() from src/paper/lib/currencyEngine.js (never alert-formatting code,
// never mirrorStore.js internals - both only called, never edited). Switch: PAPER_CCY_EURINR_MIRROR_ENABLED (default on,
// follows PAPER_CCY_EURINR_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settleInr } = require('../../lib/currencyEngine');
const { loadConfig } = require('../ccy_eurinr/config');
const { summarise } = require('../../scalp/report');

module.exports = {
  name: 'ccy_eurinr_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_CCY_EURINR_MIRROR_ENABLED !== undefined ? env.PAPER_CCY_EURINR_MIRROR_ENABLED !== 'false' : env.PAPER_CCY_EURINR_ENABLED !== 'false';

    const mirrorStore = pool ? createPgMirrorStore(pool, 'ccy_eurinr_mirror_trades') : createMemoryMirrorStore();
    ctx.ccyEurinrMirrorMemoryStore = mirrorStore; // so telegram-alerts / leaderboard can read it even without a pool

    app.get('/api/paper/ccy-eurinr-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadConfig(mainStore);
        const closed = await mirrorStore.closedTrades();
        const open = await mirrorStore.allOpenTrades();
        return res.json({ paperOnly: true, enabled: on, mirrorOf: 'ccy_eurinr', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mirrorStore.listTrades(20) });
      } catch (e) {
        return res.status(500).type('text').send('could not read ccy_eurinr_mirror data');
      }
    });

    if (!on) { log('[ccy_eurinr_mirror] disabled'); return; }

    // ccy_eurinr has its OWN table (never a row in the shared paper_trades), reached the same way
    // telegramAlerts/register.js and leaderboard/register.js already read every other own-table bot: the
    // ctx key its own register.js sets (ctx.ccyEurinrMemoryStore) BEFORE this plugin loads
    // (src/paper/pluginLoader.js loads bots/ in directory order - "ccy_eurinr" sorts before
    // "ccy_eurinr_mirror"). If ccy_eurinr is disabled or has not registered yet, the property is
    // simply absent and this mirror has nothing to mirror (empty arrays, never a crash).
    const originalAdapter = {
      allOpenTrades: () => (ctx.ccyEurinrMemoryStore ? ctx.ccyEurinrMemoryStore.allOpenTrades() : []),
      closedTrades: () => (ctx.ccyEurinrMemoryStore ? ctx.ccyEurinrMemoryStore.closedTrades() : []),
    };
    const bot = createMirrorBot({ originalStore: originalAdapter, mirrorStore, settle: settleInr, loadCfg: () => loadConfig(mainStore), log, label: 'ccy_eurinr_mirror' });

    const syncFn = guarded('ccy_eurinr_mirror sync', track('ccyEurinrMirrorSync', bot.sync), log);
    cron.schedule('55 * * * * *', syncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { ccyEurinrMirrorSync: syncFn });
    syncFn().then((r) => log('[ccy_eurinr_mirror] startup sync: opened ' + r.opened + ', closed ' + r.closed)).catch((e) => log('[ccy_eurinr_mirror] startup sync failed: ' + e.message));
    log('[ccy_eurinr_mirror] ready (PAPER ONLY, label "ccy_eurinr-MIRROR"; report: /api/paper/ccy-eurinr-mirror-report)');
  },
};
