'use strict';
// research_nifty200_52whigh plugin wiring (CC2 demo bot for strategy S6, which PASSed its train+test
// backtest - docs/RESEARCH-STRATEGIES-REPORT.md). Auto-loaded by src/paper/pluginLoader.js.
//
// Live rule (same signal as the backtest, research/strategies/s6_52week_high.py): once per calendar
// month, rank the same Nifty200-like proxy universe (universe.js) by close / rolling-52-week-high
// (Yahoo Finance daily closes, free, no key - src/paper/lib/dailyYahoo.js), go LONG the top 30,
// equal-weight (capital / 30 per name), hold 1 month. The previous month's basket (if any) is closed
// first, at each stock's current live/last price - a demo/paper price, PAPER ONLY, never a real order.
//
// Switch: PAPER_RESEARCH_N200_52WH_ENABLED (default on).
const path = require('path');
const { createMemoryResearchStore, createPgResearchStore } = require('../../lib/researchStore');
const { createDailyYahooSource } = require('../../lib/dailyYahoo');
const { announceLiveOnce } = require('../../lib/liveAnnounce');
const { loadNifty200Like } = require('./universe');
const { RESEARCH_N200_52WH_DEFAULTS: CFG } = require('./config');

function monthKey(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`; }

function rollingHigh(closes, window = 252) {
  const highs = closes.map(() => NaN);
  for (let i = 0; i < closes.length; i += 1) {
    const start = Math.max(0, i - window + 1);
    let max = -Infinity;
    for (let j = start; j <= i; j += 1) max = Math.max(max, closes[j].close);
    highs[i] = max;
  }
  return highs;
}

async function rankTopN(yahoo, universe, log, topN) {
  const ratios = [];
  for (const sym of universe) {
    try {
      const closes = await yahoo.dailyCloses(`${sym}.NS`, '2y');
      if (closes.length < 100) continue;
      const highs = rollingHigh(closes);
      const last = closes[closes.length - 1].close;
      const high = highs[highs.length - 1];
      if (high > 0) ratios.push({ symbol: sym, ratio: last / high, price: last });
    } catch (e) {
      log(`[research_nifty200_52whigh] skipping ${sym}: ${e.message}`);
    }
  }
  ratios.sort((a, b) => b.ratio - a.ratio);
  return ratios.slice(0, topN);
}

async function runRebalance({ store, yahoo, universe, log, now = Date.now }) {
  const today = new Date(now());
  const period = monthKey(today);
  const open = await store.allOpenTrades();
  if (open.length && open[0].rebalance_period === period) return { skipped: 'already positioned this month' };

  const picks = await rankTopN(yahoo, universe, log, CFG.top_n);
  if (picks.length < CFG.top_n / 2) return { skipped: `not enough ranked names (${picks.length})` };

  for (const t of open) {
    let exitPrice = t.entry_price;
    try { exitPrice = (await yahoo.livePrice(`${t.symbol}.NS`)) || t.entry_price; } catch (e) { log(`[research_nifty200_52whigh] live price for ${t.symbol} failed, closing at entry price: ${e.message}`); }
    const pnl = (exitPrice - t.entry_price) * t.qty;
    await store.updateTrade(t.id, { status: 'closed', exit_price: exitPrice, exit_time: new Date(now()).toISOString(), exit_reason: 'month_end', pnl_inr: Math.round(pnl * 100) / 100 });
  }
  log(`[research_nifty200_52whigh] closed ${open.length} positions from the previous month`);

  const perStockCapital = CFG.capital_inr / CFG.top_n;
  for (const p of picks) {
    const qty = perStockCapital / p.price;
    await store.insertTrade({
      symbol: p.symbol, direction: 'LONG', rebalance_period: period, entry_price: p.price,
      entry_time: new Date(now()).toISOString(), qty,
      basis: `S6 52-week-high rotation: price/52w-high ratio ${p.ratio.toFixed(4)}, rank in top ${CFG.top_n} for ${period} (research/strategies/s6_52week_high.py)`,
    });
  }
  log(`[research_nifty200_52whigh] opened ${picks.length} positions for ${period}: ${picks.map((p) => p.symbol).join(', ')}`);
  return { opened: picks.length };
}

module.exports = {
  name: 'research_nifty200_52whigh',
  schemaSql: path.join(__dirname, 'schema.sql'),
  async register(ctx) {
    const { app, cron, env, log, guarded, tz, pool, axios = require('axios'), healthTracker = null, jobRegistry = null, now = Date.now } = ctx;
    const track = (name, fn) => (healthTracker ? healthTracker.wrap(name, fn) : fn);
    const on = env.PAPER_RESEARCH_N200_52WH_ENABLED !== 'false';

    app.get('/api/paper/research-n200-52wh-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      const store = ctx.researchN20052whMemoryStore;
      if (!store) return res.status(503).type('text').send('research_nifty200_52whigh is starting');
      return res.json({ paperOnly: true, enabled: on, capitalInr: CFG.capital_inr, topN: CFG.top_n, open: await store.allOpenTrades(), closed: await store.closedTrades() });
    });

    if (!on) { log('[research_nifty200_52whigh] disabled (PAPER_RESEARCH_N200_52WH_ENABLED=false)'); return; }

    const store = pool ? createPgResearchStore(pool, 'research_nifty200_52whigh_trades', 'research_nifty200_52whigh_meta') : createMemoryResearchStore();
    ctx.researchN20052whMemoryStore = store;

    const yahoo = ctx.dailyYahooSource || createDailyYahooSource({ axios, log, now });
    ctx.dailyYahooSource = yahoo; // shared across the three research_* bots

    const universe = loadNifty200Like();
    const scanFn = guarded('research_nifty200_52whigh scan', track('researchN20052whScan', () => runRebalance({ store, yahoo, universe, log, now })), log);
    // Once daily, 09:25 IST, well after the other two research_* bots' own daily checks - ranking ~130
    // names through one 1-req/sec Yahoo queue takes a couple of minutes, so it is staggered on purpose.
    cron.schedule('0 25 9 * * *', scanFn, tz);
    if (jobRegistry) Object.assign(jobRegistry, { researchN20052whScan: scanFn });
    scanFn().catch((e) => log('[research_nifty200_52whigh] startup scan failed: ' + e.message));

    announceLiveOnce({
      store, axios, env, log, botName: 'research_nifty200_52whigh',
      strategyLine: '52-week-high rotation (S6): monthly, long the top 30 Nifty200-like names by price/52w-high, equal-weight',
      market: 'Nifty 200 (proxy universe)', capitalInr: CFG.capital_inr,
    }).catch((e) => log('[research_nifty200_52whigh] live-announce failed: ' + e.message));

    log(`[research_nifty200_52whigh] ready (PAPER ONLY, monthly top-${CFG.top_n} 52w-high rotation; report: /api/paper/research-n200-52wh-report)`);
  },
};
