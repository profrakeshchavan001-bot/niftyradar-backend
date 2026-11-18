'use strict';
// confluence_flow (Bot B) plugin wiring (docs/BOT-INTERFACE.md, docs/CONFLUENCE-BOT.md). Auto-loaded by
// src/paper/pluginLoader.js. Switch: PAPER_CONFLUENCE_FLOW_ENABLED (default on).
const path = require('path');
const fs = require('fs');
const { createConfluenceFlowBot, MARKET } = require('./bot');
const { createMemoryConfluenceFlowStore, createPgConfluenceFlowStore } = require('./store');
const { loadConfluenceFlowConfig, CONFLUENCE_FLOW_DEFAULTS } = require('./config');
const { createMemoryShadowStore, createPgShadowStore } = require('../../shadow/store');
const { createOrderFlow } = require('../../lib/orderFlow');
const { announceLiveOnce } = require('../../lib/liveAnnounce');
const { formatEntry, formatExit, DEFAULT_COST_PCT } = require('../../ops/telegramAlerts/format');

const BOT_NAME = 'confluence_flow';

async function sendAlert(ctx, trade, store, kind) {
  const { axios, env, log } = ctx;
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { log(`[${BOT_NAME}] Telegram not configured - alert not sent`); return; }
  const [closedTrades, openTrades] = await Promise.all([store.closedTrades(), Promise.all(CONFLUENCE_FLOW_DEFAULTS.symbols.map((s) => store.openTrades(s))).then((r) => r.flat())]);
  const opts = { costPct: DEFAULT_COST_PCT, nativeInr: false, usdInrFallback: env.USDINR_FALLBACK, capitalTotal: CONFLUENCE_FLOW_DEFAULTS.capital_usdt, closedTrades, openTrades };
  const base = kind === 'entry' ? formatEntry(trade, BOT_NAME, opts) : formatExit(trade, BOT_NAME, opts);
  // Extra lines beyond scalp_wide's own format (the task's own requirement for these two bots): where
  // (location), why (pattern), the order-flow reading, the target level/type and any path obstacles.
  const extra = kind === 'entry'
    ? [
      '', `Where: ${trade.location_type || 'n/a'}`, `Why: ${trade.pattern || 'n/a'}`,
      `Order flow: ${trade.flow_direction || 'n/a'} (strength ${trade.flow_strength ?? 'n/a'})`,
      `Target level: ${trade.target_price} (${trade.target_type || 'n/a'})`,
      `Obstacles on path: ${(() => { try { const o = JSON.parse(trade.obstacles_on_path || '[]'); return o.length ? o.map((x) => x.type).join(', ') : 'none'; } catch (e) { return 'none'; } })()}`,
    ].join('\n')
    : '';
  const text = extra ? `${base}\n${extra}` : base;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text }, { timeout: 5000 });
  } catch (e) {
    log(`[${BOT_NAME}] Telegram ${kind} alert failed: ${e.response?.status || e.message}`);
  }
}

module.exports = {
  name: 'confluence_flow',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, store: mainStore, guarded, tz, pool, healthTracker = null, jobRegistry = null } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_CONFLUENCE_FLOW_ENABLED !== 'false';

    app.get('/api/paper/confluence-flow-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const fStore = pool ? createPgConfluenceFlowStore(pool, 'confluence_flow_trades', 'confluence_flow_meta', 'confluence_flow_skips', 'confluence_flow_samples') : ctx.confluenceFlowMemoryStore;
        if (!fStore) return res.status(503).type('text').send('confluence_flow is starting');
        const closed = await fStore.closedTrades();
        const open = await Promise.all(CONFLUENCE_FLOW_DEFAULTS.symbols.map((s) => fStore.openTrades(s)));
        const skips = await fStore.skipsSince('1970-01-01');
        const samples = await fStore.flowSamplesSince('1970-01-01');
        return res.json({ paperOnly: true, enabled: on, note: 'Bot B cannot be replayed historically - no historical order-book feed, see docs/CONFLUENCE-BOT.md', closed, open: open.flat(), skips, samples: samples.slice(-50), recent: await fStore.listTrades(20) });
      } catch (e) {
        return res.status(500).type('text').send('could not read confluence_flow data');
      }
    });

    if (!on) { log('[confluence_flow] disabled (PAPER_CONFLUENCE_FLOW_ENABLED=false)'); return; }

    const axios = ctx.axios || require('axios');
    const crypto = ctx.cachedCrypto || (() => {
      const { createCryptoSource } = require('../../../../paperbot/sources');
      return createCryptoSource({ axios, log });
    })();
    const orderFlow = createOrderFlow({ axios, log });
    const fStore = pool ? createPgConfluenceFlowStore(pool, 'confluence_flow_trades', 'confluence_flow_meta', 'confluence_flow_skips', 'confluence_flow_samples') : createMemoryConfluenceFlowStore();
    ctx.confluenceFlowMemoryStore = fStore;

    const shadowStore = pool ? createPgShadowStore(pool) : createMemoryShadowStore();
    const shadowSchemaReady = pool ? pool.query(fs.readFileSync(path.join(__dirname, '..', '..', 'shadow', 'schema.sql'), 'utf8')).catch((e) => log(`[confluence_flow] shadow schema failed: ${e.message}`)) : Promise.resolve();

    const bot = createConfluenceFlowBot({
      store: fStore, crypto, orderFlow, loadCfg: () => loadConfluenceFlowConfig(mainStore), shadowStore, log, botName: BOT_NAME,
      onEntry: (trade) => sendAlert(ctx, trade, fStore, 'entry'),
      onExit: (trade) => sendAlert(ctx, trade, fStore, 'exit'),
    });
    const scanFn = guarded('confluence_flow scan', track('confluenceFlowScan', () => bot.scan()), log);
    const monitorFn = guarded('confluence_flow monitor', track('confluenceFlowMonitor', bot.monitor), log);
    cron.schedule('40 */5 * * * *', scanFn, tz); // offset from confluence's own :20 so the two never race the same second
    cron.schedule('55 * * * * *', monitorFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { confluenceFlowScan: scanFn, confluenceFlowMonitor: monitorFn });
    shadowSchemaReady.then(() => bot.backfillShadows()).catch((e) => log(`[confluence_flow] shadow backfill failed: ${e.message}`));
    bot.monitor().then((r) => log(`[confluence_flow] startup resume: checked ${r.checked}, closed ${r.closed}`)).catch((e) => log(`[confluence_flow] startup resume failed: ${e.message}`));
    announceLiveOnce({
      store: fStore, axios, env, log, botName: 'confluence_flow',
      strategyLine: 'confluence (location + trigger + real-level stop/target) PLUS order-flow agreement (bid/ask imbalance + CVD) - min R:R 1.5',
      market: 'BTC/ETH/SOL (paper)', capitalInr: CONFLUENCE_FLOW_DEFAULTS.capital_usdt * (Number(env.USDINR_FALLBACK) || 88),
    }).catch((e) => log(`[confluence_flow] live-announce failed: ${e.message}`));
    log(`[confluence_flow] ready (PAPER ONLY, market ${MARKET}; report: /api/paper/confluence-flow-report; Bot B has no replay - no historical order book)`);
  },
};
