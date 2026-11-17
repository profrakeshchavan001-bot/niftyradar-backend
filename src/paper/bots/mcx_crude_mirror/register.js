'use strict';
// mcx_crude-MIRROR (docs/BOTS.md "Mirror bots"): same pattern as mcx_gold_mirror/register.js, for
// mcx_crude. Auto-loaded by src/paper/pluginLoader.js. Switch: PAPER_MCX_CRUDE_MIRROR_ENABLED (default
// on, follows PAPER_MCX_CRUDE_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settle } = require('../../scalp/engine');
const { loadMcxCrudeConfig } = require('../mcx_crude/config');
const { summarise } = require('../../scalp/report');

const TABLE = 'mcx_crude_mirror_trades';
const LABEL = 'mcx_crude-MIRROR';

module.exports = {
  name: 'mcx_crude_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_MCX_CRUDE_MIRROR_ENABLED !== undefined ? env.PAPER_MCX_CRUDE_MIRROR_ENABLED !== 'false' : env.PAPER_MCX_CRUDE_ENABLED !== 'false';

    const mStore = pool ? createPgMirrorStore(pool, TABLE) : createMemoryMirrorStore();
    ctx.mcxCrudeMirrorMemoryStore = mStore;

    app.get('/api/paper/mcx-crude-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadMcxCrudeConfig(mainStore);
        const closed = await mStore.closedTrades();
        const open = await mStore.allOpenTrades();
        const data = { paperOnly: true, enabled: on, mirrorOf: 'mcx_crude', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read mcx_crude_mirror data');
      }
    });

    if (!on) { log('[mcx_crude_mirror] disabled'); return; }

    const bot = createMirrorBot({
      originalStore: { allOpenTrades: () => ctx.mcxCrudeMemoryStore.allOpenTrades(), closedTrades: () => ctx.mcxCrudeMemoryStore.closedTrades() },
      mirrorStore: mStore, settle, loadCfg: () => loadMcxCrudeConfig(mainStore), log, label: 'mcx_crude_mirror',
    });
    const syncFn = guarded('mcx_crude_mirror sync', track('mcxCrudeMirrorSync', async () => {
      if (!ctx.mcxCrudeMemoryStore) return { opened: 0, closed: 0, reason: 'original not ready yet' };
      return bot.sync();
    }), log);
    cron.schedule('49 * * * * *', syncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { mcxCrudeMirrorSync: syncFn });
    syncFn().then((r) => log(`[mcx_crude_mirror] startup sync: opened ${r.opened}, closed ${r.closed}`)).catch((e) => log(`[mcx_crude_mirror] startup sync failed: ${e.message}`));
    log(`[mcx_crude_mirror] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/mcx-crude-mirror-report)`);
  },
};
