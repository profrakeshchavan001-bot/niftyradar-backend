'use strict';
// Leaderboard of every CC3/CC2 bot (docs/BOTS.md): GET /api/paper/bots-report (+ ?format=json), auto-loaded by src/paper/pluginLoader.js.
// Read-only: reads whatever each bot already stored, never writes, never trades. A bot under 20 trades is shown but not ranked.
const { computeBotStats, dailyWinners, NO_CONCLUSION } = require('./stats');
// Root-cause fix: every raw pool.query() below used to hand back node-pg's RAW row (NUMERIC/DECIMAL
// columns as strings), so computeBotStats()'s plain `+`/`-` on pnl_inr/cost_usdt/... either silently
// string-concatenated or produced NaN for every own-table bot and every mirror bot read through this
// function on real Postgres - the exact bug already fixed for each bot's OWN store (exhaustion_only,
// trend_smc, currencyStore, mirrorStore, mcxStore) but never applied here, where the leaderboard, the
// daily 05:00 report (src/paper/ops/dailyReport/) and the mix report all get their numbers from. Every
// row from `queryClosed` below now goes through the same shared helper those stores use.
const { castNumericColumns } = require('../../lib/numericCast');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (v) => (v == null ? '-' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);

/** Closed trades of one own-table bot straight from Postgres, numeric columns cast to real numbers. "Table not there yet" (fresh database, bot disabled) is empty, never an error. */
async function queryClosed(pool, table) {
  try {
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE status = 'closed' ORDER BY id`);
    return rows.map((r) => castNumericColumns(r));
  } catch (e) { return []; }
}

// One row per known bot: how to read its closed trades. `pool`/`mainStore`/`ctx` are read live at request time, not captured at
// register() time, so this works whatever order the plugins happened to load in (see docs/decisions/CC3.md).
async function closedTradesByBot(ctx) {
  const { store: mainStore, pool } = ctx;
  const scalp = await mainStore.closedTrades('crypto_scalp');
  const scalp_wide = await mainStore.closedTrades('crypto_wide_scalp');
  const intraday = await mainStore.closedTrades(null); // nse + crypto, excludes every "*_scalp" market
  const exhaustion_only = pool ? await queryClosed(pool, 'exhaustion_only_trades')
    : (ctx.exhaustionMemoryStore ? await ctx.exhaustionMemoryStore.closedTrades().catch(() => []) : []);
  const trend_smc = pool ? await queryClosed(pool, 'trend_smc_trades')
    : (ctx.trendSmcMemoryStore ? await ctx.trendSmcMemoryStore.closedTrades().catch(() => []) : []);
  // MIRROR bots (docs/BOTS.md "Mirror bots"): own tables, read the same way, same "not there yet = empty
  // row, never an error" rule - so the leaderboard (and mix, which reuses this function) show the mirrors
  // right alongside the originals they shadow.
  const exhaustion_only_mirror = pool ? await queryClosed(pool, 'exhaustion_only_mirror_trades')
    : (ctx.exhaustionMirrorMemoryStore ? await ctx.exhaustionMirrorMemoryStore.closedTrades().catch(() => []) : []);
  const trend_smc_mirror = pool ? await queryClosed(pool, 'trend_smc_mirror_trades')
    : (ctx.trendSmcMirrorMemoryStore ? await ctx.trendSmcMirrorMemoryStore.closedTrades().catch(() => []) : []);
  const scalp_mirror = pool ? await queryClosed(pool, 'scalp_mirror_trades')
    : (ctx.scalpMirrorMemoryStore ? await ctx.scalpMirrorMemoryStore.closedTrades().catch(() => []) : []);
  const scalp_wide_mirror = pool ? await queryClosed(pool, 'scalp_wide_mirror_trades')
    : (ctx.scalpWideMirrorMemoryStore ? await ctx.scalpWideMirrorMemoryStore.closedTrades().catch(() => []) : []);
  // intraday-MIRROR: own table, mirrors ONLY the 'crypto' market of `intraday` above
  // (src/paper/bots/intraday_mirror/register.js) - same "not there yet = empty row, never an error" rule.
  const intraday_mirror = pool ? await queryClosed(pool, 'intraday_mirror_trades')
    : (ctx.intradayMirrorMemoryStore ? await ctx.intradayMirrorMemoryStore.closedTrades().catch(() => []) : []);
  // ccy_*: NSE currency futures USDINR/EURINR/GBPINR/JPYINR, own tables (src/paper/bots/ccy_*/schema.sql)
  // + their _mirror siblings - same "not there yet = empty row, never an error" rule as every bot above.
  const ccyPairs = ['usdinr', 'eurinr', 'gbpinr', 'jpyinr'];
  const ccy = {};
  for (const pair of ccyPairs) {
    const ctxKey = `ccy${pair[0].toUpperCase()}${pair.slice(1)}MemoryStore`;
    const mirrorCtxKey = `ccy${pair[0].toUpperCase()}${pair.slice(1)}MirrorMemoryStore`;
    ccy[`ccy_${pair}`] = pool ? await queryClosed(pool, `ccy_${pair}_trades`)
      : (ctx[ctxKey] ? await ctx[ctxKey].closedTrades().catch(() => []) : []);
    ccy[`ccy_${pair}_mirror`] = pool ? await queryClosed(pool, `ccy_${pair}_mirror_trades`)
      : (ctx[mirrorCtxKey] ? await ctx[mirrorCtxKey].closedTrades().catch(() => []) : []);
  }
  // mcx_gold / mcx_crude (src/paper/bots/mcx_gold, mcx_crude) + their mirrors: own tables, same
  // "not there yet = empty row, never an error" rule.
  const mcx_gold = pool ? await queryClosed(pool, 'mcx_gold_trades')
    : (ctx.mcxGoldMemoryStore ? await ctx.mcxGoldMemoryStore.closedTrades().catch(() => []) : []);
  const mcx_crude = pool ? await queryClosed(pool, 'mcx_crude_trades')
    : (ctx.mcxCrudeMemoryStore ? await ctx.mcxCrudeMemoryStore.closedTrades().catch(() => []) : []);
  const mcx_gold_mirror = pool ? await queryClosed(pool, 'mcx_gold_mirror_trades')
    : (ctx.mcxGoldMirrorMemoryStore ? await ctx.mcxGoldMirrorMemoryStore.closedTrades().catch(() => []) : []);
  const mcx_crude_mirror = pool ? await queryClosed(pool, 'mcx_crude_mirror_trades')
    : (ctx.mcxCrudeMirrorMemoryStore ? await ctx.mcxCrudeMirrorMemoryStore.closedTrades().catch(() => []) : []);
  return {
    intraday, scalp, scalp_wide, exhaustion_only, trend_smc,
    exhaustion_only_mirror, trend_smc_mirror, scalp_mirror, scalp_wide_mirror, intraday_mirror,
    ...ccy,
    mcx_gold, mcx_crude, mcx_gold_mirror, mcx_crude_mirror,
  };
}

function basisOf(t) { return t.basis || null; }

function block(bot, s, closed) {
  const recent = [...closed].sort((a, b) => (b.id || 0) - (a.id || 0)).slice(0, 20)
    .map((t) => ({ symbol: t.symbol, direction: t.direction, entry_price: t.entry_price, exit_price: t.exit_price, exit_reason: t.exit_reason, pnl_inr: t.pnl_inr ?? null, basis: basisOf(t) }));
  const trades = recent.map((t) => `<tr><td>${esc(t.symbol)}</td><td>${esc(t.direction)}</td><td>${t.entry_price}</td><td>${t.exit_price ?? '-'}</td><td>${esc(t.exit_reason)}</td><td>${inr(t.pnl_inr)}</td><td class="basis">${esc(t.basis)}</td></tr>`).join('');
  return `<details class="bot"><summary><b>${esc(bot)}</b> &middot; ${s.trades} trades &middot; ${s.winRatePct == null ? '-' : s.winRatePct + '%'} win &middot; ${inr(s.netPnlInr)} net`
    + `${s.ranked ? '' : ` <span class="m">(${esc(NO_CONCLUSION)})</span>`}${s.lossAfterCosts ? ' <span class="loss">LOSES after costs</span>' : ''}</summary>`
    + `<div class="grid"><div><b>${inr(s.grossPnlInr)}</b><span>gross P&amp;L</span></div><div><b>${inr(s.netPnlInr)}</b><span>net P&amp;L (after costs)</span></div>`
    + `<div><b>${s.costPctOfGrossPnl == null ? '-' : s.costPctOfGrossPnl + '%'}</b><span>cost as % of gross</span></div>`
    + `<div><b>${inr(s.avgWinInr)}</b><span>average win</span></div><div><b>${inr(s.avgLossInr)}</b><span>average loss</span></div>`
    + `<div><b>${inr(-s.maxDrawdownInr)}</b><span>max drawdown</span></div><div><b>${s.avgMinutes == null ? '-' : s.avgMinutes + ' min'}</b><span>average time in trade</span></div></div>`
    + (recent.length ? `<table><tr><th>Symbol</th><th>Dir</th><th>Entry</th><th>Exit</th><th>Reason</th><th>P&amp;L</th><th>Basis</th></tr>${trades}</table>` : '<p class="m">No closed trades yet.</p>')
    + '</details>';
}

function renderReport(d) {
  const rows = Object.entries(d.stats).map(([bot, s]) => `<tr><td>${esc(bot)}</td><td>${s.ranked ? s.trades : `${s.trades} (${esc(NO_CONCLUSION)})`}</td><td>${s.winRatePct == null ? '-' : s.winRatePct + '%'}</td><td>${inr(s.netPnlInr)}</td>${s.lossAfterCosts ? '<td class="loss">loses after costs</td>' : '<td></td>'}</tr>`).join('');
  const ranked = Object.entries(d.stats).filter(([, s]) => s.ranked).sort((a, b) => b[1].netPnlInr - a[1].netPnlInr).map(([bot]) => bot);
  const daily = d.daily.map((r) => `<tr><td>${r.date}</td><td>${esc(r.winner)}</td><td>${inr(r.netInr)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Paper: Bots leaderboard</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;padding:12px;color:#1c1f24;background:#fff}h1{font-size:18px;margin:0 0 4px}h3{font-size:15px;margin:16px 0 6px}.m{color:#5b6470}.loss{color:#b3261e;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:8px 0}.grid div{border:1px solid #d9dde3;border-radius:8px;padding:8px}.grid b{display:block;font-size:16px}.grid span{color:#5b6470;font-size:12px}
table{border-collapse:collapse;width:100%;margin-top:6px}th,td{border-bottom:1px solid #e5e8ec;padding:5px 6px;text-align:left;font-size:13px;vertical-align:top}.basis{color:#3b4350;font-size:12px}
.bot{border:1px solid #d9dde3;border-radius:8px;padding:8px;margin-bottom:10px}summary{cursor:pointer;font-size:14px}</style></head><body>
<h1>NiftyRadar PAPER bots: leaderboard</h1><p class="m">Demo only, no real money. Updated ${esc(d.generatedAt)}. Net P&amp;L is after costs. A bot under 20 trades is shown but not ranked.</p>
<h3>Ranked by net P&amp;L (20+ trades)</h3>${ranked.length ? `<ol>${ranked.map((b) => `<li>${esc(b)}: ${inr(d.stats[b].netPnlInr)}</li>`).join('')}</ol>` : '<p class="m">No bot has 20 trades yet.</p>'}
<h3>Every bot</h3><table><tr><th>Bot</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th><th></th></tr>${rows}</table>
<h3>Daily winner</h3>${daily ? `<table><tr><th>Date</th><th>Winner</th><th>Net P&amp;L that day</th></tr>${daily}</table>` : '<p class="m">No closed trades yet.</p>'}
<h3>Expandable trade list</h3>${Object.entries(d.stats).map(([bot, s]) => block(bot, s, d.closed[bot] || [])).join('')}
</body></html>`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Self-check (no DB write, never throws): for every bot, computeBotStats()'s own netPnlInr/costsInr must
 * equal the plain sum of that bot's closed trades' own pnl_inr/cost (Number(...) on the raw value, the
 * same "what would this be without any cast at all" check the task asked for), and must never be
 * NaN/non-finite. A mismatch here means a column castNumericColumns does not know about slipped through
 * uncast - logs one line, never crashes the server.
 */
async function numericSelfCheck(ctx, log = ctx.log || console.log, getClosed = closedTradesByBot) {
  let closed;
  try { closed = await getClosed(ctx); } catch (e) { log(`[leaderboard] numeric self-check could not read trades: ${e.message}`); return; }
  const bad = [];
  for (const [bot, rows] of Object.entries(closed)) {
    const s = computeBotStats(rows);
    const expectedNet = round2(rows.reduce((sum, t) => sum + (Number(t.pnl_inr ?? t.net_pnl_inr) || 0), 0));
    if (!Number.isFinite(s.netPnlInr) || Math.abs(s.netPnlInr - expectedNet) > 0.01) bad.push(`${bot} (net: got ${s.netPnlInr}, expected ${expectedNet})`);
    if (s.trades > 0 && !Number.isFinite(s.costsInr)) bad.push(`${bot} (fees: ${s.costsInr})`);
  }
  if (bad.length) log(`[leaderboard] numeric self-check FAILED: ${bad.join('; ')} - a Postgres NUMERIC column is reaching computeBotStats() uncast (src/paper/lib/numericCast.js)`);
  else log('[leaderboard] numeric self-check passed for every bot (net P&L matches a plain sum, no NaN)');
}

module.exports = {
  name: 'leaderboard',
  closedTradesByBot, numericSelfCheck, // reused by src/paper/bots/mix/ (closedTradesByBot) and tests
  async register(ctx) {
    const { app, env, log } = ctx;
    numericSelfCheck(ctx, log).catch((e) => log(`[leaderboard] numeric self-check error (non-fatal): ${e.message}`)); // startup check (item 3), fire-and-forget like every other plugin's startup work
    app.get('/api/paper/bots-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        const closed = await closedTradesByBot(ctx);
        const stats = Object.fromEntries(Object.entries(closed).map(([bot, rows]) => [bot, computeBotStats(rows)]));
        const daily = dailyWinners(closed);
        const data = { paperOnly: true, generatedAt: new Date().toISOString(), stats, daily, closed };
        if (req.query.format === 'json') return res.json(data);
        return res.type('html').send(renderReport(data));
      } catch (e) {
        log(`[leaderboard] could not build the report: ${e.message}`);
        return res.status(500).type('text').send('could not read paper bot data');
      }
    });
    log('[leaderboard] ready (PAPER ONLY, read-only; report: /api/paper/bots-report)');
  },
};
