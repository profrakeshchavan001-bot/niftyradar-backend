'use strict';
// mcx_gold plugin wiring (docs/BOTS.md, docs/BOT-INTERFACE.md). Auto-loaded by src/paper/pluginLoader.js -
// nothing in paperbot/index.js or server.js needs to change for this bot to exist. Switch:
// PAPER_MCX_GOLD_ENABLED (default on).
//
// PROXY DATA SOURCE (read this before trusting the price): MCX itself has no free, keyless candle feed
// wired into this repo. This bot trades a PROXY - Yahoo Finance's free GC=F (COMEX gold, USD/troy-oz)
// chart, converted to INR/gram with the live USDINR rate (src/paper/lib/yahooFutures.js) - standing in
// for the real MCX GOLDM print, which MCX adjusts for import duty, GST and a local premium/discount this
// proxy does not model. It will not match the real exchange tick-for-tick; documented again in the PR.
const path = require('path');
const { createMemoryMcxStore, createPgMcxStore } = require('../../lib/mcxStore');
const { createMcxBot } = require('../../lib/mcxBot');
const { createYahooFuturesSource, goldUsdOzToInrPerGram } = require('../../lib/yahooFutures');
const { loadMcxGoldConfig, MCX_GOLD_DEFAULTS } = require('./config');
const { summarise } = require('../../scalp/report');

const SYMBOL = MCX_GOLD_DEFAULTS.symbol; // 'GOLDM'

module.exports = {
  name: 'mcx_gold',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_MCX_GOLD_ENABLED !== 'false';

    app.get('/api/paper/mcx-gold-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const store = pool ? createPgMcxStore(pool, 'mcx_gold_trades') : ctx.mcxGoldMemoryStore;
        if (!store) return res.status(503).type('text').send('mcx_gold is starting');
        const cfg = await loadMcxGoldConfig(mainStore);
        const closed = await store.closedTrades();
        const open = await store.allOpenTrades();
        const skips = await store.skipsSince('1970-01-01');
        const data = { paperOnly: true, enabled: on, dataSource: 'PROXY: Yahoo GC=F (COMEX gold) converted to INR/gram, NOT the real MCX print', minTrades: cfg.min_trades_for_conclusion, summary: summarise({ closed, open, skips, minTrades: cfg.min_trades_for_conclusion }), recent: await store.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read mcx_gold data');
      }
    });

    if (!on) { log('[mcx_gold] disabled (PAPER_MCX_GOLD_ENABLED=false)'); return; }

    const store = pool ? createPgMcxStore(pool, 'mcx_gold_trades') : createMemoryMcxStore();
    ctx.mcxGoldMemoryStore = store; // so the report route, telegram-alerts, leaderboard and the mirror can read it even without a pool

    const cfgNow = await loadMcxGoldConfig(mainStore);
    const source = createYahooFuturesSource({ axios: require('axios'), symbol: cfgNow.yahoo_symbol, unit: goldUsdOzToInrPerGram, log, fxFallback: cfgNow.usdinr_fallback });
    require('../../ops/health').registerMcxFeed('mcx_gold', source.stats);
    const bot = createMcxBot({ label: 'mcx_gold', symbol: SYMBOL, lotKey: 'lot_size_grams', store, source, loadCfg: () => loadMcxGoldConfig(mainStore), log });

    const scanFn = guarded('mcx_gold scan', track('mcxGoldScan', bot.scan), log);
    const monitorFn = guarded('mcx_gold monitor', track('mcxGoldMonitor', bot.monitor), log);
    cron.schedule('20 */5 * * * *', scanFn, tz);
    cron.schedule('44 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { mcxGoldScan: scanFn, mcxGoldMonitor: monitorFn });
    monitorFn().then((r) => log(`[mcx_gold] startup resume: checked ${r.checked}, closed ${r.closed}`)).catch((e) => log(`[mcx_gold] startup resume failed: ${e.message}`));
    log(`[mcx_gold] ready (PAPER ONLY, proxy GC=F->INR/gram, market hours 09:00-23:30 IST Mon-Fri; report: /api/paper/mcx-gold-report)`);
  },
};
