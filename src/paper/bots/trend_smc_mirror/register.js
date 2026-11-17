'use strict';
// trend_smc-MIRROR (docs/BOTS.md "Mirror bots"): for every trade trend_smc takes, opens the OPPOSITE
// trade (same entry price/time and qty, direction flipped, target/stop swapped - mirror target =
// trend_smc's own stop price, mirror stop = trend_smc's own target price) in its own table, own virtual
// balance, never shared with the original. The original bot (src/paper/bots/trend_smc/) is untouched:
// this plugin only READS its store (ctx.trendSmcMemoryStore, set by that bot's own register.js, which
// the loader always runs first - "trend_smc" sorts before "trend_smc_mirror"). Auto-loaded by
// src/paper/pluginLoader.js. Switch: PAPER_TREND_SMC_MIRROR_ENABLED (default on, follows
// PAPER_TREND_SMC_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settle } = require('../trend_smc/engine');
const { loadTrendSmcConfig } = require('../trend_smc/config');
const { summarise } = require('../../scalp/report');

const TABLE = 'trend_smc_mirror_trades';
const LABEL = 'trend_smc-MIRROR';

module.exports = {
  name: 'trend_smc_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_TREND_SMC_MIRROR_ENABLED !== undefined ? env.PAPER_TREND_SMC_MIRROR_ENABLED !== 'false' : env.PAPER_TREND_SMC_ENABLED !== 'false';

    const mStore = pool ? createPgMirrorStore(pool, TABLE) : createMemoryMirrorStore();
    ctx.trendSmcMirrorMemoryStore = mStore; // so telegram-alerts / leaderboard can read it even without a pool

    app.get('/api/paper/trend-smc-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadTrendSmcConfig(mainStore);
        const closed = await mStore.closedTrades();
        const open = await mStore.allOpenTrades();
        const data = { paperOnly: true, enabled: on, mirrorOf: 'trend_smc', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read trend_smc_mirror data');
      }
    });

    if (!on) { log('[trend_smc_mirror] disabled'); return; }

    const bot = createMirrorBot({
      originalStore: { allOpenTrades: () => ctx.trendSmcMemoryStore.allOpenTrades(), closedTrades: () => ctx.trendSmcMemoryStore.closedTrades() },
      mirrorStore: mStore, settle, loadCfg: () => loadTrendSmcConfig(mainStore), log, label: 'trend_smc_mirror',
    });
    const syncFn = guarded('trend_smc_mirror sync', track('trendSmcMirrorSync', async () => {
      if (!ctx.trendSmcMemoryStore) return { opened: 0, closed: 0, reason: 'original not ready yet' };
      return bot.sync();
    }), log);
    cron.schedule('28 */5 * * * *', syncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { trendSmcMirrorSync: syncFn });
    syncFn().then((r) => log(`[trend_smc_mirror] startup sync: opened ${r.opened}, closed ${r.closed}`)).catch((e) => log(`[trend_smc_mirror] startup sync failed: ${e.message}`));
    log(`[trend_smc_mirror] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/trend-smc-mirror-report)`);
  },
};
