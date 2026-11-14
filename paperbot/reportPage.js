'use strict';
// Read-only report page of the paper bot (GET /api/paper/report). Plain HTML,
// inline CSS, no script, no external file. It only reads the bot's own tables
// and describes what happened; it changes nothing and fetches no prices.
const { patternStats } = require('./report');
const { DEFAULTS, merge } = require('./config');
const { istParts } = require('./time');

const MARKETS = [['nse', 'NSE'], ['crypto', 'Crypto']];

const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const sign = (x) => (x > 0 ? '+' : x < 0 ? '-' : '');
const istTime = (iso) => { const ms = Date.parse(iso || ''); return Number.isFinite(ms) ? `${istParts(ms).hhmm} IST` : ''; };

// P&L of one closed trade in the unit the owner reads it in: INR for NSE,
// USDT for crypto (stored P&L in INR divided by the FX rate stored with the
// trade). A crypto trade without a stored rate stays in INR; nothing is assumed.
function pnlOf(t) {
  if (t.status !== 'closed' || !Number.isFinite(t.pnl_inr)) return null;
  if (t.market === 'crypto' && t.fx_rate > 0) return { value: round(t.pnl_inr / t.fx_rate, 2), unit: 'USDT' };
  return { value: round(t.pnl_inr, 2), unit: 'INR' };
}

function money(value, unit) {
  if (value == null || !Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  return unit === 'USDT'
    ? `${sign(value)}${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT`
    : `${sign(value)}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

// Day totals of one market; P&L summed per unit (a crypto day can hold both).
function dayTotals(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  const pnl = {};
  for (const t of closed) { const p = pnlOf(t); if (p) pnl[p.unit] = round((pnl[p.unit] || 0) + p.value, 2); }
  return { trades: trades.length, closed: closed.length, open: trades.length - closed.length, wins: closed.filter((t) => t.pnl_inr > 0).length, losses: closed.filter((t) => t.pnl_inr < 0).length, pnl };
}

// Win rate and average P&L per pattern since the start, per market, in that market's unit.
function patternRows(closed, minTrades) {
  const rows = [];
  for (const [market, label] of MARKETS) {
    const mine = closed.filter((t) => t.market === market);
    const unit = market === 'crypto' && mine.every((t) => t.fx_rate > 0) ? 'USDT' : 'INR';
    const inUnit = mine.map((t) => ({ ...t, pnl_inr: unit === 'USDT' ? t.pnl_inr / t.fx_rate : t.pnl_inr }));
    for (const s of patternStats(inUnit, minTrades)) rows.push({ market, label, unit, pattern: s.pattern, trades: s.trades, wins: s.wins, winRatePct: s.winRatePct, avgPnl: s.avgPnlInr, enough: s.enough });
  }
  return rows;
}

function tradeCard(t) {
  const p = pnlOf(t);
  const cls = p ? (p.value > 0 ? 'win' : p.value < 0 ? 'loss' : '') : 'open';
  const out = t.status === 'closed'
    ? `<div><span>Exit</span> ${esc(t.exit_price)} at ${esc(istTime(t.exit_time))} (${esc(String(t.exit_reason || '').replace(/_/g, ' '))})</div><div><span>P&amp;L</span> <b class="${cls}">${esc(money(p?.value, p?.unit))}</b></div>`
    : '<div><span>Exit</span> still open</div>';
  const src = t.market === 'nse' ? `<div><span>Data</span> ${esc(t.data_source || 'not recorded')}${t.data_delay_sec != null ? `, latest candle ${esc(t.data_delay_sec)} s old at entry` : ''}${t.simulated_option ? ' · option price SIMULATED' : ''}</div>` : '';
  return `<article class="card ${cls}">
<h3>${esc(t.market === 'nse' ? 'NSE' : 'Crypto')} · ${esc(t.symbol)} · ${esc(t.direction)}</h3>
<div><span>Pattern</span> ${esc((t.patterns || []).join(', ').replace(/_/g, ' ') || 'none recorded')}</div>
<div><span>Entry</span> ${esc(t.entry_price)} x ${esc(t.qty)} at ${esc(istTime(t.entry_time))}${t.trade_date ? ` (${esc(t.trade_date)})` : ''}</div>
${out}
${src}<p>${esc(t.basis || 'No basis sentence stored.')}</p>
</article>`;
}

const totalsLine = (label, d) => `<tr><td>${esc(label)}</td><td>${d.trades}</td><td>${d.wins} / ${d.losses}</td><td>${d.open}</td><td>${esc(Object.entries(d.pnl).map(([u, v]) => money(v, u)).join(' and ') || (d.closed ? money(0, 'INR') : 'none closed'))}</td></tr>`;

// data: { date, generatedAt, storage, minTrades, today: { nse: [], crypto: [] }, open: [], closed: [] }
function renderReport(data) {
  const { date, minTrades } = data;
  const todays = MARKETS.flatMap(([m]) => data.today[m] || []);
  const stats = patternRows(data.closed, minTrades);
  const statRows = stats.map((s) => `<tr${s.enough ? '' : ' class="few"'}><td class="w">${esc(s.label)} · ${esc(s.pattern.replace(/_/g, ' '))}${s.enough ? '' : '<br><small>too few trades</small>'}</td><td>${s.trades}</td><td>${s.winRatePct}%</td><td>${esc(money(s.avgPnl, s.unit))}</td></tr>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Paper bot report ${esc(date)}</title>
<style>
body{font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:12px;background:#f4f5f7;color:#1c1f24}
main{max-width:760px;margin:0 auto}
h1{font-size:20px;margin:4px 0}h2{font-size:17px;margin:22px 0 8px}h3{font-size:15px;margin:0 0 6px}
.note{color:#555b66;font-size:13px;margin:2px 0}
.card{background:#fff;border:1px solid #d9dce2;border-left:5px solid #9aa1ad;border-radius:8px;padding:10px 12px;margin:8px 0}
.card.win{border-left-color:#1a7f45}.card.loss{border-left-color:#b3261e}.card.open{border-left-color:#2f6fde}
.card span{display:inline-block;min-width:62px;color:#555b66;font-size:13px}
.card p{margin:8px 0 0;font-size:14px;color:#333842}
b.win{color:#1a7f45}b.loss{color:#b3261e}
.wrap{overflow-x:auto;background:#fff;border:1px solid #d9dce2;border-radius:8px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:7px 6px;border-bottom:1px solid #e6e8ec;white-space:nowrap}
td.w{white-space:normal}small{font-size:12px}
th{background:#eceef2;font-size:13px}tr.few td{color:#6b7280}
.empty{background:#fff;border:1px dashed #c3c7cf;border-radius:8px;padding:10px 12px;color:#555b66}
</style></head><body><main>
<h1>Paper bot report</h1>
<p class="note">${esc(date)} (IST) · made ${esc(istTime(data.generatedAt))} · storage: ${esc(data.storage)}</p>
<p class="note">PAPER trading only: a demo with no real money and no orders. Statistics, not investment advice.</p>
${data.storage === 'memory' ? '<p class="note"><b>Storage is memory only: trades are lost when the server restarts.</b></p>' : ''}
<h2>Day totals</h2>
<div class="wrap"><table><thead><tr><th>Market</th><th>Trades</th><th>Won / lost</th><th>Open</th><th>P&amp;L</th></tr></thead><tbody>
${MARKETS.map(([m, label]) => totalsLine(label, dayTotals(data.today[m] || []))).join('\n')}
</tbody></table></div>
<h2>Today's trades (${todays.length})</h2>
${todays.length ? todays.map(tradeCard).join('\n') : '<div class="empty">No trades today.</div>'}
<h2>Open trades (${data.open.length})</h2>
${data.open.length ? data.open.map(tradeCard).join('\n') : '<div class="empty">No open trades.</div>'}
<h2>Per pattern since start</h2>
<p class="note">Closed trades only. A trade that fired two patterns counts under each. Under ${esc(minTrades)} trades a pattern is marked "too few trades": no conclusion yet.</p>
${stats.length ? `<div class="wrap"><table><thead><tr><th>Pattern</th><th>Trades</th><th>Win rate</th><th>Avg P&amp;L</th></tr></thead><tbody>
${statRows}
</tbody></table></div>` : '<div class="empty">No closed trades yet.</div>'}
</main></body></html>`;
}

// Reads everything the page shows. Uses getConfig (a read), never writes.
async function buildReport({ store, now = Date.now }) {
  const nowMs = now();
  const date = istParts(nowMs).date;
  const cfg = merge(DEFAULTS, await store.getConfig());
  const today = {};
  const open = [];
  for (const [m] of MARKETS) {
    today[m] = await store.tradesForDay(m, date);
    open.push(...await store.openTrades(m));
  }
  return renderReport({ date, generatedAt: new Date(nowMs).toISOString(), storage: store.kind, minTrades: cfg.learning.min_trades_for_conclusion, today, open, closed: await store.closedTrades() });
}

module.exports = { buildReport, renderReport, dayTotals, patternRows, pnlOf, money };
