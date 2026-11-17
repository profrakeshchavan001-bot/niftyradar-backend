'use strict';
// intraday-MIRROR (docs/BOTS.md "Mirror bots"): for every trade the main crypto bot ("intraday" in
// telegramAlerts/register.js and the leaderboard - paperbot/bot.js's cryptoScan/cryptoMonitor) takes,
// opens the OPPOSITE trade (same entry price/time and qty, direction flipped, target/stop swapped -
// mirror target = the original's own stop price, mirror stop = the original's own target price) in its
// own table, own virtual balance, never shared with the original. The original bot
// (paperbot/bot.js, wired from paperbot/index.js, NOT a bots/ plugin) is untouched: this plugin only
// READS the shared `paper_trades` table it already writes to (ctx.store), filtered to the 'crypto'
// market ONLY (never 'nse', 'crypto_scalp' or 'crypto_wide_scalp' - those are different bots with their
// own mirrors already), and never writes to it. Auto-loaded by src/paper/pluginLoader.js. Modelled
// directly on src/paper/bots/scalp_mirror/register.js, which mirrors one market key inside this same
// shared table the same way.
//
// The intraday bot has no exported settle() of its own (paperbot/bot.js's cryptoMonitor/closeTrade do
// this arithmetic inline) - paperbot/engine.js now exports one, added ONLY for this mirror (and the
// backfill) to call; the live bot's own code is unchanged.
//
// Switch: PAPER_INTRADAY_MIRROR_ENABLED (default on, follows PAPER_BOT_ENABLED - the only switch the
// intraday/crypto loop itself has; there is no crypto-specific toggle to follow, unlike scalp_mirror
// following PAPER_SCALP_ENABLED).
const path = require('path');
const { createMemoryMirrorStore, createPgMirrorStore } = require('../../lib/mirrorStore');
const { createMirrorBot } = require('../../lib/mirrorBot');
const { settle } = require('../../../../paperbot/engine');
const { loadConfig } = require('../../../../paperbot/config');
const { summarise } = require('../../scalp/report');

const TABLE = 'intraday_mirror_trades';
const LABEL = 'intraday-MIRROR';
const MARKET = 'crypto'; // the main crypto bot's own market key in the shared paper_trades table

// Crypto cfg plus the shared learning.min_trades_for_conclusion flattened in, the same shape
// loadScalpConfig()/loadExhaustionConfig() already return (summarise() reads it at the top level).
async function loadCfg(mainStore) {
  const full = await loadConfig(mainStore);
  return { ...full.crypto, min_trades_for_conclusion: full.learning.min_trades_for_conclusion };
}

module.exports = {
  name: 'intraday_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_INTRADAY_MIRROR_ENABLED !== undefined ? env.PAPER_INTRADAY_MIRROR_ENABLED !== 'false' : env.PAPER_BOT_ENABLED !== 'false';

    const mStore = pool ? createPgMirrorStore(pool, TABLE) : createMemoryMirrorStore();
    ctx.intradayMirrorMemoryStore = mStore; // so telegram-alerts / leaderboard can read it even without a pool

    app.get('/api/paper/intraday-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cfg = await loadCfg(mainStore);
        const closed = await mStore.closedTrades();
        const open = await mStore.allOpenTrades();
        const data = { paperOnly: true, enabled: on, mirrorOf: 'intraday', summary: summarise({ closed, open, skips: [], minTrades: cfg.min_trades_for_conclusion }), recent: await mStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read intraday_mirror data');
      }
    });

    if (!on) { log('[intraday_mirror] disabled'); return; }

    const originalStore = { allOpenTrades: () => mainStore.openTrades(MARKET), closedTrades: () => mainStore.closedTrades(MARKET) };
    const bot = createMirrorBot({ originalStore, mirrorStore: mStore, settle, loadCfg: () => loadCfg(mainStore), log, label: 'intraday_mirror' });

    const syncFn = guarded('intraday_mirror sync', track('intradayMirrorSync', bot.sync), log);
    cron.schedule('33 * * * * *', syncFn, tz); // unused second-offset (docs/BOTS.md mirror schedules: :15/:22/:28/:38/:42/:45/:50/:58 already taken)
    if (jobRegistry) Object.assign(jobRegistry, { intradayMirrorSync: syncFn });
    syncFn().then((r) => log(`[intraday_mirror] startup sync: opened ${r.opened}, closed ${r.closed}`)).catch((e) => log(`[intraday_mirror] startup sync failed: ${e.message}`));
    log(`[intraday_mirror] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/intraday-mirror-report)`);
  },
};
