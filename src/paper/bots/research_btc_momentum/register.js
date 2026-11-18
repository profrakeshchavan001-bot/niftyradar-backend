'use strict';
// research_btc_momentum plugin wiring (CC2 demo bot for strategy S2, which PASSed its train+test
// backtest - docs/RESEARCH-STRATEGIES-REPORT.md). Auto-loaded by src/paper/pluginLoader.js.
//
// Live rule (same signal as the backtest, research/strategies/s2_btc_momentum.py): once per ISO week
// (Monday), compute the trailing 7-day return on BTC-USD's daily closes (Yahoo Finance, free, no key -
// src/paper/lib/dailyYahoo.js). > 0 ("strongly positive", same threshold the backtest tuned on train:
// simply positive) -> go LONG for the week; else stay in cash (no short, matching the strategy's own
// "else cash" rule). The previous week's position (if any) is closed first, at the current live/last
// price - a demo/paper price, PAPER ONLY, never a real order.
//
// Switch: PAPER_RESEARCH_BTC_MOMENTUM_ENABLED (default on).
const path = require('path');
const { createMemoryResearchStore, createPgResearchStore } = require('../../lib/researchStore');
const { createDailyYahooSource } = require('../../lib/dailyYahoo');
const { announceLiveOnce } = require('../../lib/liveAnnounce');
const { RESEARCH_BTC_MOMENTUM_DEFAULTS: CFG } = require('./config');

// Monday (UTC) of the ISO week containing `d`, as 'YYYY-MM-DD'.
function weekStart(d) {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diffToMonday);
  return monday.toISOString().slice(0, 10);
}

async function runRebalance({ store, yahoo, log, now = Date.now }) {
  const today = new Date(now());
  const period = weekStart(today);
  const open = await store.allOpenTrades();
  if (open.some((t) => t.rebalance_period === period)) return { skipped: 'already positioned this week' };

  const closes = await yahoo.dailyCloses(CFG.ticker, '1y');
  if (closes.length < 8) return { skipped: `not enough daily history (${closes.length} days)` };
  const livePrice = (await yahoo.livePrice(CFG.ticker)) || closes[closes.length - 1].close;

  for (const t of open) {
    const pnl = (livePrice - t.entry_price) * t.qty; // LONG only, per the strategy's own "else cash" rule
    await store.updateTrade(t.id, { status: 'closed', exit_price: livePrice, exit_time: new Date(now()).toISOString(), exit_reason: 'week_end', pnl_inr: Math.round(pnl * 100) / 100 });
    log(`[research_btc_momentum] closed ${t.rebalance_period} position: LONG @ ${t.entry_price} -> ${livePrice}, pnl ${Math.round(pnl * 100) / 100}`);
  }

  const last = closes[closes.length - 1].close;
  const weekAgo = closes[closes.length - 8].close;
  const ret7d = last / weekAgo - 1;
  if (ret7d <= 0) return { skipped: `flat/negative 7d momentum (${(ret7d * 100).toFixed(2)}%) -> cash this week` };

  const qty = CFG.capital_inr / livePrice;
  await store.insertTrade({
    symbol: CFG.symbol, direction: 'LONG', rebalance_period: period, entry_price: livePrice,
    entry_time: new Date(now()).toISOString(), qty,
    basis: `S2 BTC weekly momentum: trailing 7d return ${(ret7d * 100).toFixed(2)}% > 0 -> LONG for ${period} (research/strategies/s2_btc_momentum.py)`,
  });
  log(`[research_btc_momentum] opened ${period}: LONG @ ${livePrice} (7d return ${(ret7d * 100).toFixed(2)}%)`);
  return { opened: 'LONG' };
}

module.exports = {
  runRebalanceForTest: runRebalance, // exported only for test/paperResearchBots.test.js
  name: 'research_btc_momentum',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, guarded, tz, pool, axios = require('axios'), healthTracker = null, jobRegistry = null, now = Date.now } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_RESEARCH_BTC_MOMENTUM_ENABLED !== 'false';

    app.get('/api/paper/research-btc-momentum-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      const store = ctx.researchBtcMomentumMemoryStore;
      if (!store) return res.status(503).type('text').send('research_btc_momentum is starting');
      return res.json({ paperOnly: true, enabled: on, capitalInr: CFG.capital_inr, open: await store.allOpenTrades(), closed: await store.closedTrades() });
    });

    if (!on) { log('[research_btc_momentum] disabled (PAPER_RESEARCH_BTC_MOMENTUM_ENABLED=false)'); return; }

    const store = pool ? createPgResearchStore(pool, 'research_btc_momentum_trades', 'research_btc_momentum_meta') : createMemoryResearchStore();
    ctx.researchBtcMomentumMemoryStore = store;

    const yahoo = ctx.dailyYahooSource || createDailyYahooSource({ axios, log, now });
    ctx.dailyYahooSource = yahoo; // shared across the three research_* bots

    const scanFn = guarded('research_btc_momentum scan', track('researchBtcMomentumScan', () => runRebalance({ store, yahoo, log, now })), log);
    cron.schedule('0 20 9 * * *', scanFn, tz); // once daily, 09:20 IST; idempotent (checks rebalance_period first)
    if (jobRegistry) Object.assign(jobRegistry, { researchBtcMomentumScan: scanFn });
    scanFn().catch((e) => log('[research_btc_momentum] startup scan failed: ' + e.message));

    announceLiveOnce({
      store, axios, env, log, botName: 'research_btc_momentum',
      strategyLine: 'weekly momentum (S2): long BTC for 1 week when the trailing 7-day return is positive, else cash',
      market: 'BTC', capitalInr: CFG.capital_inr,
    }).catch((e) => log('[research_btc_momentum] live-announce failed: ' + e.message));

    log('[research_btc_momentum] ready (PAPER ONLY, weekly BTC momentum; report: /api/paper/research-btc-momentum-report)');
  },
};
