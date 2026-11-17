'use strict';
// ccy_usdinr plugin wiring (USDINR NSE currency futures, PAPER ONLY, docs/BOTS.md): auto-loaded by
// src/paper/pluginLoader.js - nothing in paperbot/index.js or server.js needs to change for this bot to
// exist. Reuses the scalp_wide entry/exit rule (src/paper/scalp/engine.js) unchanged via
// src/paper/lib/currencyBot.js, and the free Yahoo Finance FX feed (src/paper/lib/currencyFx.js) as a
// spot-FX proxy for the futures (no free futures candle feed is wired into this repo - task's own note).
// Gated to the NSE currency segment session, 09:00-17:00 IST, on the SAME NSE holiday calendar the main
// NSE equity bot uses (src/paper/lib/currencySession.js, paperbot/config.js DEFAULTS.nse.holidays) - never
// a "has not scanned" alert outside hours. Switch: PAPER_CCY_USDINR_ENABLED (default on).
const path = require('path');
const { createBot, PAIR } = require('./bot');
const { loadConfig } = require('./config');
const { createMemoryCurrencyStore, createPgCurrencyStore } = require('../../lib/currencyStore');
const { createCurrencyFxSource } = require('../../lib/currencyFx');
const { loadConfig: loadMainConfig } = require('../../../../paperbot/config');
const { summarise } = require('../../scalp/report');
const { createMemoryShadowStore, createPgShadowStore } = require('../../shadow/store');
const fs = require('fs');

module.exports = {
  name: 'ccy_usdinr',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, axios = require('axios'), healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_CCY_USDINR_ENABLED !== 'false';

    app.get('/api/paper/ccy-usdinr-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cStore = pool ? createPgCurrencyStore(pool, 'ccy_usdinr_trades', 'ccy_usdinr_skips') : ctx.ccyUsdinrMemoryStore;
        if (!cStore) return res.status(503).type('text').send('ccy_usdinr is starting');
        const cfg = await loadConfig(mainStore);
        const closed = await cStore.closedTrades();
        const open = await cStore.allOpenTrades();
        const skips = await cStore.skipsSince('1970-01-01');
        const data = { paperOnly: true, enabled: on, pair: PAIR, minTrades: cfg.min_trades_for_conclusion, summary: summarise({ closed, open, skips, minTrades: cfg.min_trades_for_conclusion }), recent: await cStore.listTrades(20) };
        return res.json(data);
      } catch (e) {
        return res.status(500).type('text').send('could not read ccy_usdinr data');
      }
    });

    if (!on) { log('[ccy_usdinr] disabled (PAPER_CCY_USDINR_ENABLED=false)'); return; }

    const cStore = pool ? createPgCurrencyStore(pool, 'ccy_usdinr_trades', 'ccy_usdinr_skips') : createMemoryCurrencyStore();
    ctx.ccyUsdinrMemoryStore = cStore; // so the report route above, telegram-alerts and leaderboard can read it even without a pool

    const fx = ctx.currencyFxSource || createCurrencyFxSource({ axios, log });
    ctx.currencyFxSource = fx; // shared across the four ccy_* bots: one Yahoo client, one cache, not four

    const shadowStore = pool ? createPgShadowStore(pool) : createMemoryShadowStore();
    const shadowSchemaReady = pool ? pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'shadow', 'schema.sql'), 'utf8')).catch((e) => log('[ccy_usdinr] shadow schema failed: ' + e.message)) : Promise.resolve();

    const loadHolidays = async () => (await loadMainConfig(mainStore)).nse.holidays;
    const bot = createBot({ store: cStore, fx, loadCfg: () => loadConfig(mainStore), loadHolidays, shadowStore, now: ctx.now || Date.now, log });
    const scanFn = guarded('ccy_usdinr scan', track('ccyUsdinrScan', bot.scan), log);
    const monitorFn = guarded('ccy_usdinr monitor', track('ccyUsdinrMonitor', bot.monitor), log);
    cron.schedule('20 */5 * * * *', scanFn, tz);
    cron.schedule('50 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { ccyUsdinrScan: scanFn, ccyUsdinrMonitor: monitorFn });
    shadowSchemaReady.then(() => bot.backfillShadows()).catch((e) => log('[ccy_usdinr] shadow backfill failed: ' + e.message));
    bot.monitor().then((r) => log('[ccy_usdinr] startup resume: checked ' + r.checked + ', closed ' + r.closed)).catch((e) => log('[ccy_usdinr] startup resume failed: ' + e.message));
    log('[ccy_usdinr] ready (PAPER ONLY, NSE currency segment 09:00-17:00 IST, pair USDINR; report: /api/paper/ccy-usdinr-report)');
  },
};
