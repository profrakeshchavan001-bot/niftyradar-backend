'use strict';
// confluence (Bot A) plugin wiring (docs/BOT-INTERFACE.md, docs/CONFLUENCE-BOT.md). Auto-loaded by
// src/paper/pluginLoader.js - nothing in paperbot/index.js or server.js needs to change for this bot to
// exist. Switch: PAPER_CONFLUENCE_ENABLED (default on).
const path = require('path');
const fs = require('fs');
const { createConfluenceBot, MARKET } = require('./bot');
const { createMemoryConfluenceStore, createPgConfluenceStore } = require('./store');
const { loadConfluenceConfig, CONFLUENCE_DEFAULTS } = require('./config');
const { createMemoryShadowStore, createPgShadowStore } = require('../../shadow/store');
const { announceLiveOnce } = require('../../lib/liveAnnounce');
const { formatEntry, formatExit, DEFAULT_COST_PCT } = require('../../ops/telegramAlerts/format');

const BOT_NAME = 'confluence';

async function sendAlert(ctx, trade, store, kind) {
  const { axios, env, log } = ctx;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log(`[${BOT_NAME}] Telegram not configured - alert not sent`); return; }
  const [closedTrades, openTrades] = await Promise.all([store.closedTrades(), Promise.all(CONFLUENCE_DEFAULTS.symbols.map((s) => store.openTrades(s))).then((r) => r.flat())]);
  const opts = { costPct: DEFAULT_COST_PCT, nativeInr: false, usdInrFallback: env.USDINR_FALLBACK, capitalTotal: CONFLUENCE_DEFAULTS.capital_usdt, closedTrades, openTrades };
  const text = kind === 'entry' ? formatEntry(trade, BOT_NAME, opts) : formatExit(trade, BOT_NAME, opts);
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text }, { timeout: 5000 });
  } catch (e) {
    log(`[${BOT_NAME}] Telegram ${kind} alert failed: ${e.response?.status || e.message}`);
  }
}

module.exports = {
  name: 'confluence',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_CONFLUENCE_ENABLED !== 'false';

    app.get('/api/paper/confluence-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const cStore = pool ? createPgConfluenceStore(pool, 'confluence_trades', 'confluence_meta', 'confluence_skips') : ctx.confluenceMemoryStore;
        if (!cStore) return res.status(503).type('text').send('confluence is starting');
        const closed = await cStore.closedTrades();
        const open = await Promise.all(CONFLUENCE_DEFAULTS.symbols.map((s) => cStore.openTrades(s)));
        const skips = await cStore.skipsSince('1970-01-01');
        return res.json({ paperOnly: true, enabled: on, closed, open: open.flat(), skips, recent: await cStore.listTrades(20) });
      } catch (e) {
        return res.status(500).type('text').send('could not read confluence data');
      }
    });

    if (!on) { log('[confluence] disabled (PAPER_CONFLUENCE_ENABLED=false)'); return; }

    const crypto = ctx.cachedCrypto || (() => {
      const axios = require('axios');
      const { createCryptoSource } = require('../../../../paperbot/sources');
      return createCryptoSource({ axios, log });
    })();
    const cStore = pool ? createPgConfluenceStore(pool, 'confluence_trades', 'confluence_meta', 'confluence_skips') : createMemoryConfluenceStore();
    ctx.confluenceMemoryStore = cStore;

    const shadowStore = pool ? createPgShadowStore(pool) : createMemoryShadowStore();
    const shadowSchemaReady = pool ? pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'shadow', 'schema.sql'), 'utf8')).catch((e) => log(`[confluence] shadow schema failed: ${e.message}`)) : Promise.resolve();

    const bot = createConfluenceBot({
      store: cStore, crypto, loadCfg: () => loadConfluenceConfig(mainStore), shadowStore, log, botName: BOT_NAME,
      onEntry: (trade) => sendAlert(ctx, trade, cStore, 'entry'),
      onExit: (trade) => sendAlert(ctx, trade, cStore, 'exit'),
    });
    const scanFn = guarded('confluence scan', track('confluenceScan', () => bot.scan()), log);
    const monitorFn = guarded('confluence monitor', track('confluenceMonitor', bot.monitor), log);
    cron.schedule('20 */5 * * * *', scanFn, tz);
    cron.schedule('50 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { confluenceScan: scanFn, confluenceMonitor: monitorFn });
    shadowSchemaReady.then(() => bot.backfillShadows()).catch((e) => log(`[confluence] shadow backfill failed: ${e.message}`));
    bot.monitor().then((r) => log(`[confluence] startup resume: checked ${r.checked}, closed ${r.closed}`)).catch((e) => log(`[confluence] startup resume failed: ${e.message}`));
    announceLiveOnce({
      store: cStore, axios: ctx.axios || require('axios'), env, log, botName: 'confluence',
      strategyLine: 'location (order block / liquidity sweep) + trigger (candle pattern), stop/target from real chart levels only, min R:R 1.5',
      market: 'BTC/ETH/SOL (paper)', capitalInr: CONFLUENCE_DEFAULTS.capital_usdt * (Number(env.USDINR_FALLBACK) || 88),
    }).catch((e) => log(`[confluence] live-announce failed: ${e.message}`));
    log(`[confluence] ready (PAPER ONLY, market ${MARKET}; report: /api/paper/confluence-report)`);
  },
};
