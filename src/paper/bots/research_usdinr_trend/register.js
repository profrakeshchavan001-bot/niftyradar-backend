'use strict';
// research_usdinr_trend plugin wiring (CC2 demo bot for strategy S1's USDINR leg, the only S1 instrument
// that PASSed its train+test backtest - docs/RESEARCH-STRATEGIES-REPORT.md). Auto-loaded by
// src/paper/pluginLoader.js - nothing in paperbot/index.js or server.js needs to change.
//
// Live rule (same signal as the backtest, docs/RESEARCH-STRATEGIES-REPORT.md / research/strategies/
// s1_trend.py): once per calendar month, compute the trailing 12-month return on USDINR's monthly closes
// (Yahoo Finance USDINR=X, free, no key - src/paper/lib/dailyYahoo.js). >0 -> go LONG for the month,
// <0 -> go SHORT, ==0 -> stay flat. The previous month's position (if any) is closed first, at that
// month's own last known close - a demo/paper price, PAPER ONLY, never a real order.
//
// Switch: PAPER_RESEARCH_USDINR_TREND_ENABLED (default on).
const path = require('path');
const { createMemoryResearchStore, createPgResearchStore } = require('../../lib/researchStore');
const { createDailyYahooSource } = require('../../lib/dailyYahoo');
const { announceLiveOnce } = require('../../lib/liveAnnounce');
const { RESEARCH_USDINR_TREND_DEFAULTS: CFG } = require('./config');

function monthKey(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

function monthlyCloseSeries(closes) {
  const byMonth = new Map();
  for (const c of closes) byMonth.set(c.date.slice(0, 7), c.close); // last close of each month wins (closes are oldest-first)
  return [...byMonth.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)); // [[ 'YYYY-MM', close ], ...]
}

async function runRebalance({ store, yahoo, log, now = Date.now }) {
  const today = new Date(now());
  const period = monthKey(today);
  const open = await store.allOpenTrades();
  if (open.some((t) => t.rebalance_period === period)) return { skipped: 'already positioned this month' };

  const closes = await yahoo.dailyCloses(CFG.ticker, '3y');
  const monthly = monthlyCloseSeries(closes);
  if (monthly.length < 13) return { skipped: `not enough monthly history (${monthly.length} months)` };

  const livePrice = (await yahoo.livePrice(CFG.ticker)) || monthly[monthly.length - 1][1];

  for (const t of open) {
    const pnl = t.direction === 'LONG' ? (livePrice - t.entry_price) * t.qty : (t.entry_price - livePrice) * t.qty;
    await store.updateTrade(t.id, { status: 'closed', exit_price: livePrice, exit_time: new Date(now()).toISOString(), exit_reason: 'month_end', pnl_inr: Math.round(pnl * 100) / 100 });
    log(`[research_usdinr_trend] closed ${t.rebalance_period} position: ${t.direction} @ ${t.entry_price} -> ${livePrice}, pnl ${Math.round(pnl * 100) / 100}`);
  }

  const ret12m = monthly[monthly.length - 1][1] / monthly[monthly.length - 13][1] - 1;
  if (ret12m === 0) return { skipped: 'flat signal (12m return exactly 0)' };
  const direction = ret12m > 0 ? 'LONG' : 'SHORT';
  const qty = CFG.capital_inr / livePrice;
  await store.insertTrade({
    symbol: CFG.symbol, direction, rebalance_period: period, entry_price: livePrice,
    entry_time: new Date(now()).toISOString(), qty,
    basis: `S1 trend-following: trailing 12m return ${(ret12m * 100).toFixed(2)}% -> ${direction} for ${period} (research/strategies/s1_trend.py)`,
  });
  log(`[research_usdinr_trend] opened ${period}: ${direction} @ ${livePrice} (12m return ${(ret12m * 100).toFixed(2)}%)`);
  return { opened: direction };
}

module.exports = {
  runRebalanceForTest: runRebalance, // exported only for test/paperResearchBots.test.js
  name: 'research_usdinr_trend',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, guarded, tz, pool, axios = require('axios'), healthTracker = null, jobRegistry = null, now = Date.now } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_RESEARCH_USDINR_TREND_ENABLED !== 'false';

    app.get('/api/paper/research-usdinr-trend-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      const store = ctx.researchUsdinrTrendMemoryStore;
      if (!store) return res.status(503).type('text').send('research_usdinr_trend is starting');
      return res.json({ paperOnly: true, enabled: on, capitalInr: CFG.capital_inr, open: await store.allOpenTrades(), closed: await store.closedTrades() });
    });

    if (!on) { log('[research_usdinr_trend] disabled (PAPER_RESEARCH_USDINR_TREND_ENABLED=false)'); return; }

    const store = pool ? createPgResearchStore(pool, 'research_usdinr_trend_trades', 'research_usdinr_trend_meta') : createMemoryResearchStore();
    ctx.researchUsdinrTrendMemoryStore = store; // so the report route above, telegram-alerts and the 5am report can read it even without a pool

    const yahoo = ctx.dailyYahooSource || createDailyYahooSource({ axios, log, now });
    ctx.dailyYahooSource = yahoo; // shared across the three research_* bots: one Yahoo client, one cache

    const scanFn = guarded('research_usdinr_trend scan', track('researchUsdinrTrendScan', () => runRebalance({ store, yahoo, log, now })), log);
    cron.schedule('0 15 9 * * *', scanFn, tz); // once daily, 09:15 IST; idempotent (checks rebalance_period first)
    if (jobRegistry) Object.assign(jobRegistry, { researchUsdinrTrendScan: scanFn });
    scanFn().catch((e) => log('[research_usdinr_trend] startup scan failed: ' + e.message));

    announceLiveOnce({
      store, axios, env, log, botName: 'research_usdinr_trend',
      strategyLine: '12-month trend following (S1), long/short USDINR for 1 month at a time',
      market: 'USDINR', capitalInr: CFG.capital_inr,
    }).catch((e) => log('[research_usdinr_trend] live-announce failed: ' + e.message));

    log('[research_usdinr_trend] ready (PAPER ONLY, monthly USDINR trend-following; report: /api/paper/research-usdinr-trend-report)');
  },
};
