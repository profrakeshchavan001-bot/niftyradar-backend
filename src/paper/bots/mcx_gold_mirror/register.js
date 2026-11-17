'use strict';
// mcx_gold-MIRROR (docs/BOTS.md "Mirror bots"): for every trade mcx_gold takes, opens the OPPOSITE trade
// (same entry price/time and qty, direction flipped, target/stop swapped) in its own table, own virtual
// balance, never shared with the original. The original bot (src/paper/bots/mcx_gold/) is untouched: this
// plugin only READS its store (ctx.mcxGoldMemoryStore, set by that bot's own register.js, which the
// loader always runs first - "mcx_gold" sorts before "mcx_gold_mirror") and never writes to it.
// Auto-loaded by src/paper/pluginLoader.js. Switch: PAPER_MCX_GOLD_MIRROR_ENABLED (default on, follows
// PAPER_MCX_GOLD_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settle } = require('../../scalp/engine');
const { loadMcxGoldConfig } = require('../mcx_gold/config');
const { summarise } = require('../../scalp/report');

const TABLE = 'mcx_gold_mirror_trades';
const LABEL = 'mcx_gold-MIRROR';

module.exports = {
  name: 'mcx_gold_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_MCX_GOLD_MIRROR_ENABLED !== undefined ? env.PAPER_MCX_GOLD_MIRROR_ENABLED !== 'false' : env.PAPER_MCX_GOLD_ENABLED !== 'false';

    const mStore = pool ? createPgMirrorStore(pool, TABLE) : createMemoryMirrorStore();
    ctx.mcxGoldMirrorMemoryStore = mStore; // so telegram-alerts / leaderboard can read it even without a pool

    app.get('/api/paper/mcx-gold-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadMcxGoldConfig(mainStore);
        const closed = await mStore.closedTrades();
        const open = await mStore.allOpenTrades();
        const data = { paperOnly: true, enabled: on, mirrorOf: 'mcx_gold', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read mcx_gold_mirror data');
      }
    });

    if (!on) { log('[mcx_gold_mirror] disabled'); return; }

    const bot = createMirrorBot({
      originalStore: { allOpenTrades: () => ctx.mcxGoldMemoryStore.allOpenTrades(), closedTrades: () => ctx.mcxGoldMemoryStore.closedTrades() },
      mirrorStore: mStore, settle, loadCfg: () => loadMcxGoldConfig(mainStore), log, label: 'mcx_gold_mirror',
    });
    const syncFn = guarded('mcx_gold_mirror sync', track('mcxGoldMirrorSync', async () => {
      if (!ctx.mcxGoldMemoryStore) return { opened: 0, closed: 0, reason: 'original not ready yet' };
      return bot.sync();
    }), log);
    cron.schedule('48 * * * * *', syncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { mcxGoldMirrorSync: syncFn });
    syncFn().then((r) => log(`[mcx_gold_mirror] startup sync: opened ${r.opened}, closed ${r.closed}`)).catch((e) => log(`[mcx_gold_mirror] startup sync failed: ${e.message}`));
    log(`[mcx_gold_mirror] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/mcx-gold-mirror-report)`);
  },
};
