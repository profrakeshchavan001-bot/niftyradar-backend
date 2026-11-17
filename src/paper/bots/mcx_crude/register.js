'use strict';
// mcx_crude plugin wiring (docs/BOTS.md, docs/BOT-INTERFACE.md). Auto-loaded by src/paper/pluginLoader.js.
// Switch: PAPER_MCX_CRUDE_ENABLED (default on).
//
// PROXY DATA SOURCE (read this before trusting the price): same caveat as mcx_gold/register.js - this
// bot trades Yahoo's free CL=F (NYMEX WTI crude, USD/barrel) chart converted to INR/barrel with the live
// USDINR rate (src/paper/lib/yahooFutures.js), standing in for the real MCX CRUDEOIL print. MCX's own
// price differs (its own benchmark feed, duty/GST/premium) - this proxy will not match tick-for-tick.
const path = require('path');
const { createMemoryMcxStore, createPgMcxStore } = require('../../lib/mcxStore');
const { createMcxBot } = require('../../lib/mcxBot');
const { createYahooFuturesSource, crudeUsdBblToInrPerBbl } = require('../../lib/yahooFutures');
const { loadMcxCrudeConfig, MCX_CRUDE_DEFAULTS } = require('./config');
const { summarise } = require('../../scalp/report');

const SYMBOL = MCX_CRUDE_DEFAULTS.symbol; // 'CRUDEOIL'

module.exports = {
  name: 'mcx_crude',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_MCX_CRUDE_ENABLED !== 'false';

    app.get('/api/paper/mcx-crude-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const store = pool ? createPgMcxStore(pool, 'mcx_crude_trades') : ctx.mcxCrudeMemoryStore;
        if (!store) return res.status(503).type('text').send('mcx_crude is starting');
        const cfg = await loadMcxCrudeConfig(mainStore);
        const closed = await store.closedTrades();
        const open = await store.allOpenTrades();
        const skips = await store.skipsSince('1970-01-01');
        const data = { paperOnly: true, enabled: on, dataSource: 'PROXY: Yahoo CL=F (NYMEX WTI) converted to INR/barrel, NOT the real MCX print', minTrades: cfg.min_trades_for_conclusion, summary: summarise({ closed, open, skips, minTrades: cfg.min_trades_for_conclusion }), recent: await store.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read mcx_crude data');
      }
    });

    if (!on) { log('[mcx_crude] disabled (PAPER_MCX_CRUDE_ENABLED=false)'); return; }

    const store = pool ? createPgMcxStore(pool, 'mcx_crude_trades') : createMemoryMcxStore();
    ctx.mcxCrudeMemoryStore = store; // so the report route, telegram-alerts, leaderboard and the mirror can read it even without a pool

    const cfgNow = await loadMcxCrudeConfig(mainStore);
    const source = createYahooFuturesSource({ axios: require('axios'), symbol: cfgNow.yahoo_symbol, unit: crudeUsdBblToInrPerBbl, log, fxFallback: cfgNow.usdinr_fallback });
    const bot = createMcxBot({ label: 'mcx_crude', symbol: SYMBOL, lotKey: 'lot_size_barrels', store, source, loadCfg: () => loadMcxCrudeConfig(mainStore), log });

    const scanFn = guarded('mcx_crude scan', track('mcxCrudeScan', bot.scan), log);
    const monitorFn = guarded('mcx_crude monitor', track('mcxCrudeMonitor', bot.monitor), log);
    cron.schedule('25 */5 * * * *', scanFn, tz);
    cron.schedule('46 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { mcxCrudeScan: scanFn, mcxCrudeMonitor: monitorFn });
    monitorFn().then((r) => log(`[mcx_crude] startup resume: checked ${r.checked}, closed ${r.closed}`)).catch((e) => log(`[mcx_crude] startup resume failed: ${e.message}`));
    log(`[mcx_crude] ready (PAPER ONLY, proxy CL=F->INR/barrel, market hours 09:00-23:30 IST Mon-Fri; report: /api/paper/mcx-crude-report)`);
  },
};
