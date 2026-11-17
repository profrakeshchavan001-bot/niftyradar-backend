'use strict';
// Leaderboard of every CC3/CC2 bot (docs/BOTS.md): GET /api/paper/bots-report (+ ?format=json), auto-loaded by src/paper/pluginLoader.js.
// Read-only: reads whatever each bot already stored, never writes, never trades. A bot under 20 trades is shown but not ranked.
const { computeBotStats, dailyWinners, NO_CONCLUSION } = require('./stats');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (v) => (v == null ? '-' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);

// One row per known bot: how to read its closed trades. `pool`/`mainStore`/`ctx` are read live at request time, not captured at
// register() time, so this works whatever order the plugins happened to load in (see docs/decisions/CC3.md).
async function closedTradesByBot(ctx) {
  const { store: mainStore, pool } = ctx;
  const scalp = await mainStore.closedTrades('crypto_scalp');
  const scalp_wide = await mainStore.closedTrades('crypto_wide_scalp');
  const intraday = await mainStore.closedTrades(null); // nse + crypto, excludes every "*_scalp" market
  let exhaustion_only = [];
  try {
    exhaustion_only = pool ? (await pool.query("SELECT * FROM exhaustion_only_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.exhaustionMemoryStore ? await ctx.exhaustionMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet (fresh database before exhaustion_only's own schema has run) - treat as no trades */ }
  let trend_smc = [];
  try {
    trend_smc = pool ? (await pool.query("SELECT * FROM trend_smc_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.trendSmcMemoryStore ? await ctx.trendSmcMemoryStore.closedTrades() : []);
  } catch (e) { /* trend_smc may not exist yet at all (docs/decisions/CC3.md) - an empty leaderboard row, not an error */ }
  // MIRROR bots (docs/BOTS.md "Mirror bots"): own tables, read the same way, same "not there yet = empty
  // row, never an error" rule - so the leaderboard (and mix, which reuses this function) show the mirrors
  // right alongside the originals they shadow.
  let exhaustion_only_mirror = [];
  try {
    exhaustion_only_mirror = pool ? (await pool.query("SELECT * FROM exhaustion_only_mirror_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.exhaustionMirrorMemoryStore ? await ctx.exhaustionMirrorMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  let trend_smc_mirror = [];
  try {
    trend_smc_mirror = pool ? (await pool.query("SELECT * FROM trend_smc_mirror_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.trendSmcMirrorMemoryStore ? await ctx.trendSmcMirrorMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  let scalp_mirror = [];
  try {
    scalp_mirror = pool ? (await pool.query("SELECT * FROM scalp_mirror_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.scalpMirrorMemoryStore ? await ctx.scalpMirrorMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  let scalp_wide_mirror = [];
  try {
    scalp_wide_mirror = pool ? (await pool.query("SELECT * FROM scalp_wide_mirror_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.scalpWideMirrorMemoryStore ? await ctx.scalpWideMirrorMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  // intraday-MIRROR (new, this task): own table, mirrors ONLY the 'crypto' market of `intraday` above
  // (src/paper/bots/intraday_mirror/register.js) - same "not there yet = empty row, never an error" rule.
  let intraday_mirror = [];
  try {
    intraday_mirror = pool ? (await pool.query("SELECT * FROM intraday_mirror_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.intradayMirrorMemoryStore ? await ctx.intradayMirrorMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  // mcx_gold / mcx_crude (this task, src/paper/bots/mcx_gold, mcx_crude) + their mirrors: own tables, same
  // "not there yet = empty row, never an error" rule.
  let mcx_gold = [];
  try {
    mcx_gold = pool ? (await pool.query("SELECT * FROM mcx_gold_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.mcxGoldMemoryStore ? await ctx.mcxGoldMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  let mcx_crude = [];
  try {
    mcx_crude = pool ? (await pool.query("SELECT * FROM mcx_crude_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.mcxCrudeMemoryStore ? await ctx.mcxCrudeMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  let mcx_gold_mirror = [];
  try {
    mcx_gold_mirror = pool ? (await pool.query("SELECT * FROM mcx_gold_mirror_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.mcxGoldMirrorMemoryStore ? await ctx.mcxGoldMirrorMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  let mcx_crude_mirror = [];
  try {
    mcx_crude_mirror = pool ? (await pool.query("SELECT * FROM mcx_crude_mirror_trades WHERE status = 'closed' ORDER BY id")).rows
      : (ctx.mcxCrudeMirrorMemoryStore ? await ctx.mcxCrudeMirrorMemoryStore.closedTrades() : []);
  } catch (e) { /* table not there yet - treat as no trades */ }
  return {
    intraday, scalp, scalp_wide, exhaustion_only, trend_smc,
    exhaustion_only_mirror, trend_smc_mirror, scalp_mirror, scalp_wide_mirror, intraday_mirror,
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

module.exports = {
  name: 'leaderboard',
  closedTradesByBot, // reused by src/paper/bots/mix/ so the suggestion engine reads the SAME trade lists, nothing re-fetched
  async register(ctx) {
    const { app, env, log } = ctx;
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
