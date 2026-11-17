'use strict';
// exhaustion_only-MIRROR (docs/BOTS.md "Mirror bots"): for every trade exhaustion_only takes, opens the
// OPPOSITE trade (same entry price/time and qty, direction flipped, target/stop swapped - mirror target
// = exhaustion_only's own stop price, mirror stop = exhaustion_only's own target price) in its own table,
// own virtual balance, never shared with the original. The original bot (src/paper/bots/exhaustion_only/)
// is untouched: this plugin only READS its store (ctx.exhaustionMemoryStore, set by that bot's own
// register.js, which the loader always runs first - "exhaustion_only" sorts before
// "exhaustion_only_mirror") and never writes to it. Auto-loaded by src/paper/pluginLoader.js.
// Switch: PAPER_EXHAUSTION_MIRROR_ENABLED (default on, follows PAPER_EXHAUSTION_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settle } = require('../exhaustion_only/engine');
const { loadExhaustionConfig } = require('../exhaustion_only/config');
const { summarise } = require('../../scalp/report');

const TABLE = 'exhaustion_only_mirror_trades';
const LABEL = 'exhaustion_only-MIRROR';

module.exports = {
  name: 'exhaustion_only_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_EXHAUSTION_MIRROR_ENABLED !== undefined ? env.PAPER_EXHAUSTION_MIRROR_ENABLED !== 'false' : env.PAPER_EXHAUSTION_ENABLED !== 'false';

    const mStore = pool ? createPgMirrorStore(pool, TABLE) : createMemoryMirrorStore();
    ctx.exhaustionMirrorMemoryStore = mStore; // so telegram-alerts / leaderboard can read it even without a pool

    app.get('/api/paper/exhaustion-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadExhaustionConfig(mainStore);
        const closed = await mStore.closedTrades();
        const open = await mStore.allOpenTrades();
        const data = { paperOnly: true, enabled: on, mirrorOf: 'exhaustion_only', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read exhaustion_only_mirror data');
      }
    });

    if (!on) { log('[exhaustion_only_mirror] disabled'); return; }

    // Built fresh at sync time (not captured once here), same convention telegram-alerts uses - so this
    // never races the original bot's own register() and always sees its latest store.
    const bot = createMirrorBot({
      originalStore: { allOpenTrades: () => ctx.exhaustionMemoryStore.allOpenTrades(), closedTrades: () => ctx.exhaustionMemoryStore.closedTrades() },
      mirrorStore: mStore, settle, loadCfg: () => loadExhaustionConfig(mainStore), log, label: 'exhaustion_only_mirror',
    });
    const syncFn = guarded('exhaustion_only_mirror sync', track('exhaustionMirrorSync', async () => {
      if (!ctx.exhaustionMemoryStore) return { opened: 0, closed: 0, reason: 'original not ready yet' };
      return bot.sync();
    }), log);
    cron.schedule('50 * * * * *', syncFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { exhaustionMirrorSync: syncFn });
    syncFn().then((r) => log(`[exhaustion_only_mirror] startup sync: opened ${r.opened}, closed ${r.closed}`)).catch((e) => log(`[exhaustion_only_mirror] startup sync failed: ${e.message}`));
    log(`[exhaustion_only_mirror] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/exhaustion-mirror-report)`);
  },
};
