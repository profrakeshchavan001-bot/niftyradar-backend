'use strict';
// nse-MIRROR (Group 4, 2026-11): for every REAL-priced trade the main NSE bot ("nse" - paperbot/bot.js's
// nseScan/nseMonitor) takes, opens the OPPOSITE option (CALL<->PUT) at the same strike/expiry, priced
// from a fresh Dhan option-chain quote (never simulated), with its own target/stop and its own table -
// see src/paper/lib/nseOptionSide.js's file header for the full design and why this does not reuse
// buildMirrorEntry (src/paper/lib/mirror.js, built for a single shared price series, not two option
// contracts). The original bot (paperbot/bot.js) is completely untouched: this plugin only READS the
// shared paper_trades table (market 'nse') and the shared nse data source (ctx.state.nse) for live
// option quotes - it never writes to either, and never places a real order anywhere.
//
// Switch: PAPER_NSE_MIRROR_ENABLED (default on, follows PAPER_BOT_ENABLED).
const path = require('path');
const { createMemoryNseSideStore, createPgNseSideStore } = require('../../lib/nseSideStore');
const { createNseSideBot } = require('../../lib/nseOptionSide');
const { announceLiveOnce } = require('../../lib/liveAnnounce');
const { DEFAULTS: PAPERBOT_DEFAULTS } = require('../../../../paperbot/config');

const LABEL = 'nse-MIRROR';

module.exports = {
  name: 'nse_mirror',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, state, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null, axios = require('axios'), now = Date.now } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_NSE_MIRROR_ENABLED !== undefined ? env.PAPER_NSE_MIRROR_ENABLED !== 'false' : env.PAPER_BOT_ENABLED !== 'false';

    const sideStore = pool ? createPgNseSideStore(pool, 'nse_mirror_trades', 'nse_mirror_meta') : createMemoryNseSideStore();
    ctx.nseMirrorMemoryStore = sideStore; // so telegram-alerts / the daily report can read it even without a pool

    app.get('/api/paper/nse-mirror-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      return res.json({ paperOnly: true, enabled: on, mirrorOf: 'nse', open: await sideStore.allOpenTrades(), closed: await sideStore.closedTrades(), recent: await sideStore.listTrades(20) });
    });

    if (!on) { log('[nse_mirror] disabled'); return; }

    // state.nse (paperbot/index.js) is the SAME live Dhan-backed source nse.js's optionQuote lives on -
    // read through a thin wrapper rather than destructured once, so this plugin never holds a stale
    // reference if that object is ever replaced.
    const liveNse = { optionQuote: (...a) => state.nse.optionQuote(...a) };
    const bot = createNseSideBot({ mainStore, sideStore, nse: liveNse, mode: 'mirror', log, now, label: LABEL });

    const syncFn = guarded('nse_mirror sync', track('nseMirrorSync', bot.sync), log);
    const monitorFn = guarded('nse_mirror monitor', track('nseMirrorMonitor', bot.monitor), log);
    cron.schedule('20 * * * * *', syncFn, tz); // every minute, offset from the main nse scan/monitor ticks
    cron.schedule('50 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { nseMirrorSync: syncFn, nseMirrorMonitor: monitorFn });
    syncFn().then((r) => log(`[nse_mirror] startup sync: ${JSON.stringify(r)}`)).catch((e) => log(`[nse_mirror] startup sync failed: ${e.message}`));

    announceLiveOnce({
      store: sideStore, axios, env, log, botName: 'nse-MIRROR',
      strategyLine: 'opposite option (CALL<->PUT) of every real-priced nse trade, same strike/expiry, real Dhan premium, own target/stop',
      market: 'NSE options', capitalInr: PAPERBOT_DEFAULTS.nse.capital_inr,
    }).catch((e) => log(`[nse_mirror] live-announce failed: ${e.message}`));

    log(`[nse_mirror] ready (PAPER ONLY, label "${LABEL}"; report: /api/paper/nse-mirror-report)`);
  },
};
