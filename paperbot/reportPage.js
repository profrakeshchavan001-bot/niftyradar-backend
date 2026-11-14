'use strict';
// Read-only report page of the paper bot (GET /api/paper/report) and the data
// of its trade chart (GET /api/paper/chart). The page only reads the bot's own
// tables; the chart endpoint also reads market candles (never writes, never
// places anything). One external file: the open-source lightweight-charts
// library from a CDN, pinned to one version, for the candle chart.
const { patternStats } = require('./report');
const { DEFAULTS, merge } = require('./config');
const { istParts, IST_OFFSET_MS } = require('./time');

const CHART_LIB = 'https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js';
const FIVE_MIN = 300000;

// Browser script of the page (plain ES5, no build step). All text is set with textContent, never as HTML.
const CLIENT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('paper-data').textContent);
  var key = new URLSearchParams(location.search).get('key') || '';
  var panel = document.getElementById('detail');
  var byId = {};
  data.trades.forEach(function (t) { byId[t.id] = t; });
  var chart = null;
  function el(id) { return document.getElementById(id); }
  function text(id, v) { el(id).textContent = v == null ? '' : String(v); }
  function nearest(times, t) {
    var best = null;
    for (var i = 0; i < times.length; i++) if (best == null || Math.abs(times[i] - t) < Math.abs(best - t)) best = times[i];
    return best;
  }
  function draw(d) {
    var box = el('chart');
    box.textContent = '';
    if (chart) { chart.remove(); chart = null; }
    text('chart-note', d.note || '');
    if (!d.candles.length) { box.textContent = 'No candles to draw for this trade.'; return; }
    if (!window.LightweightCharts) { box.textContent = 'The chart library did not load (no internet to the CDN?). The numbers above are still correct.'; return; }
    chart = LightweightCharts.createChart(box, { height: 320, layout: { background: { color: '#ffffff' }, textColor: '#1c1f24' }, timeScale: { timeVisible: true, secondsVisible: false }, rightPriceScale: { borderVisible: false } });
    var s = chart.addCandlestickSeries({ upColor: '#1a7f45', downColor: '#b3261e', wickUpColor: '#1a7f45', wickDownColor: '#b3261e', borderVisible: false });
    s.setData(d.candles);
    var times = d.candles.map(function (c) { return c.time; });
    var marks = d.markers.map(function (m) {
      var entry = m.kind === 'entry';
      return { time: nearest(times, m.time), position: m.below ? 'belowBar' : 'aboveBar', color: entry ? '#2f6fde' : '#6b21a8', shape: m.below ? 'arrowUp' : 'arrowDown', text: m.text };
    }).sort(function (a, b) { return a.time - b.time; });
    s.setMarkers(marks);
    d.lines.forEach(function (l) {
      s.createPriceLine({ price: l.price, color: l.kind === 'target' ? '#1a7f45' : l.kind === 'sl' ? '#b3261e' : '#2f6fde', lineWidth: 1, lineStyle: l.kind === 'entry' ? 0 : 2, axisLabelVisible: true, title: l.label });
    });
    chart.timeScale().fitContent();
  }
  function show(id) {
    var t = byId[id];
    if (!t) return;
    panel.hidden = false;
    text('d-title', t.marketLabel + ' · ' + t.symbol + ' · ' + t.direction + ' · ' + t.status);
    text('d-facts', 'Entry ' + t.entry + ' · SL ' + t.sl + ' · Target ' + t.target + ' · Exit ' + (t.exit || 'still open') + (t.exitReason ? ' (' + t.exitReason + ')' : '') + (t.pnl ? ' · P&L ' + t.pnl : ''));
    text('d-basis', t.basis);
    text('d-data', t.dataLine);
    var tv = el('d-tv');
    tv.href = t.tradingView;
    text('chart-note', '');
    el('chart').textContent = 'Loading candles...';
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-id]'), function (r) { r.classList.toggle('sel', r.getAttribute('data-id') === String(id)); });
    fetch('/api/paper/chart?id=' + encodeURIComponent(id) + '&key=' + encodeURIComponent(key), { cache: 'no-store', referrerPolicy: 'no-referrer' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); })
      .then(draw)
      .catch(function (e) { el('chart').textContent = 'Could not load candles: ' + e.message; });
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  Array.prototype.forEach.call(document.querySelectorAll('tr[data-id]'), function (r) {
    r.addEventListener('click', function () { show(r.getAttribute('data-id')); });
    r.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(r.getAttribute('data-id')); } });
  });
})();
`;

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

// Exit levels of a trade. Stored at entry (sl_price / target_price); for older
// rows without them, worked out from the rules in force now and marked so.
function levelsOf(t, cfg) {
  if (t.sl_price != null && t.target_price != null) return { sl: t.sl_price, target: t.target_price, fromRules: false };
  if (!(t.entry_price > 0)) return { sl: null, target: null, fromRules: true };
  if (t.market === 'crypto') {
    const up = t.direction === 'LONG' ? 1 : -1;
    return { sl: round(t.entry_price * (1 - up * cfg.crypto.stop_pct / 100), 6), target: round(t.entry_price * (1 + up * cfg.crypto.target_pct / 100), 6), fromRules: true };
  }
  return { sl: round(t.entry_price * (1 - cfg.nse.stop_pct / 100), 2), target: round(t.entry_price * (1 + cfg.nse.target_pct / 100), 2), fromRules: true };
}

// TradingView symbol: BINANCE:ETHUSDT for crypto, NSE:SYMBOL for stocks (TradingView writes & and - as _).
const tradingViewSymbol = (t) => (t.market === 'crypto' ? `BINANCE:${t.symbol}` : `NSE:${String(t.symbol).replace(/[&-]/g, '_')}`);
const tradingViewUrl = (t) => `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tradingViewSymbol(t))}`;
const inr = (x) => (Number.isFinite(x) ? money(round(x, 2), 'INR') : '');
const reasonText = (r) => String(r || '').replace(/_/g, ' ');

// One row of the trades table + the facts the detail panel shows on a click.
function tradeView(t, cfg) {
  const lv = levelsOf(t, cfg);
  return {
    id: t.id, market: t.market, marketLabel: t.market === 'nse' ? 'NSE' : 'Crypto', symbol: t.symbol, direction: t.direction, status: t.status,
    entry: t.entry_price, sl: lv.sl, target: lv.target, levelsFromRules: lv.fromRules, exit: t.exit_price ?? null, exitReason: reasonText(t.exit_reason),
    pnl: t.status === 'closed' ? inr(t.pnl_inr) : '', pnlSign: t.status === 'closed' ? Math.sign(t.pnl_inr || 0) : 0,
    when: `${t.trade_date || ''} ${istTime(t.entry_time)}`.trim(),
    basis: t.basis || 'No basis sentence stored.',
    dataLine: `Patterns: ${(t.patterns || []).join(', ').replace(/_/g, ' ') || 'none recorded'} · data: ${t.data_source || 'not recorded'}${t.data_delay_sec != null ? `, latest candle ${t.data_delay_sec} s old at entry` : ''}${t.simulated_option ? ' · option price SIMULATED (delta 0.5), not a real quote' : ''}${t.market === 'nse' ? ' · entry / SL / target are OPTION prices' : ''}${t.target_type ? ` · target: before ${t.target_type} · stop: ${t.stop_type} · reward/risk ${t.rr}${t.breakeven_time ? ' · stop moved to entry (breakeven)' : ''}` : ''}${t.legacy_target != null ? ` · old fixed rule (target ${t.legacy_target}, stop ${t.legacy_stop}) would have ended: ${t.legacy_result || 'not decided yet'}` : ''}`,
    tradingView: tradingViewUrl(t),
  };
}

function tradeTable(views) {
  if (!views.length) return '<div class="empty">No trades stored yet.</div>';
  const row = (v) => `<tr data-id="${esc(v.id)}" tabindex="0" role="button" aria-label="Show chart for ${esc(v.symbol)}"><td>${esc(v.marketLabel)}</td><td>${esc(v.symbol)}</td><td>${esc(v.direction)}</td><td>${esc(v.entry)}</td><td>${esc(v.sl ?? '')}</td><td>${esc(v.target ?? '')}</td><td>${esc(v.exit ?? '')}</td><td>${esc(v.exitReason)}</td><td><b class="${v.pnlSign > 0 ? 'win' : v.pnlSign < 0 ? 'loss' : ''}">${esc(v.pnl)}</b></td><td>${esc(v.status)}</td><td>${esc(v.when)}</td></tr>`;
  return `<div class="wrap"><table class="trades"><thead><tr><th>Market</th><th>Symbol</th><th>Direction</th><th>Entry</th><th>SL</th><th>Target</th><th>Exit</th><th>Exit reason</th><th>P&amp;L (INR)</th><th>Status</th><th>Entered</th></tr></thead><tbody>
${views.map(row).join('\n')}
</tbody></table></div>`;
}

function skipTable(skips) {
  if (!skips.length) return '<div class="empty">Nothing was skipped today.</div>';
  const row = (s) => `<tr><td>${esc(istTime(s.created_at))}</td><td>${esc(s.market === 'nse' ? 'NSE' : 'Crypto')}</td><td>${esc(s.symbol)}</td><td class="w">${esc(s.reason)}${(s.patterns || []).length ? `<br><small>pattern seen: ${esc(s.patterns.join(', ').replace(/_/g, ' '))}</small>` : ''}${s.data_source ? `<br><small>data: ${esc(s.data_source)}${s.data_delay_sec != null ? `, ${esc(s.data_delay_sec)} s old` : ''}</small>` : ''}</td></tr>`;
  return `<div class="wrap"><table><thead><tr><th>Time</th><th>Market</th><th>Symbol</th><th>Why it was skipped</th></tr></thead><tbody>
${skips.map(row).join('\n')}
</tbody></table></div>`;
}

// "How the bot decides": plain words, numbers taken from the rules in force.
function howBox(cfg) {
  const n = cfg.nse;
  const c = cfg.crypto;
  return `<details class="how" open><summary>How the bot decides</summary>
<ul>
<li><b>Paper only.</b> No real money and no orders. Every price is a real market price or is marked SIMULATED.</li>
<li><b>Data source.</b> NSE: Dhan live data when its token works. If not, the free Yahoo Finance chart feed (marked <code>yahoo_delayed</code>, can be up to about ${esc(Math.round(n.yahoo_max_delay_sec / 60))} minutes late; option prices are then simulated). Crypto: Binance public candles. Data that is too old means no trade.</li>
<li><b>Which stocks.</b> Every 5 minutes (09:15 to ${esc(n.no_new_entry_after_ist)} IST, Mon-Fri) the liquid stocks are ranked by the risk-reward R factor (room to the next level divided by the stop distance). The top ${esc(n.top_n)} are checked.</li>
<li><b>Pattern rules.</b> On the last closed 5-minute candles: exhaustion reversal, engulfing, hammer, shooting star, morning / evening star, inside-bar breakout, liquidity sweep, order block, fair value gap retest. At least one must fire.</li>
<li><b>Trend and VWAP.</b> The pattern's direction must agree with the 15-minute trend AND the side of today's VWAP. Only the exhaustion reversal may go against the trend. Patterns pointing both ways mean no trade.</li>
<li><b>Momentum (crypto).</b> A coin needs a momentum score of at least ${esc(c.min_momentum_score)} (volume spike + bigger candle range + distance from the 20-candle average). One open trade per coin, no daily limit.</li>
<li><b>News.</b> An NSE stock named in a headline today is skipped. The judge (if on) also weighs sector, news score and time of day and can refuse a trade; the reason is in the skipped list.</li>
<li><b>Exits.</b> NSE option: target +${esc(n.target_pct)}%, stop -${esc(n.stop_pct)}%, forced exit ${esc(n.force_exit_ist)} IST, at most ${esc(n.max_trades_per_day)} trades a day.</li>
<li><b>Crypto exits come from price levels.</b> Target = ${esc(c.levels.targetBufferPct)}% before the nearest support / resistance (swing high or low on 15-minute and 1-hour candles, order block, fair value gap edge, previous day or week high / low). Stop = beyond the pattern's own high / low plus ${esc(c.levels.atrStopMult)} x ATR. A trade is taken only if reward / risk is at least ${esc(c.levels.minRr)}. After ${esc(Math.round(c.breakeven_at * 100))}% of the way to the target the stop moves to the entry. The old fixed +${esc(c.target_pct)}% / -${esc(c.stop_pct)}% rule is only tracked next to it for comparison.</li>
</ul></details>`;
}

// JSON placed inside a <script> block: "<" is written as < so no text can close the block.
const inlineJson = (x) => JSON.stringify(x).replace(/</g, '\\u003c');

// data: { date, generatedAt, storage, minTrades, today: { nse: [], crypto: [] }, open: [], closed: [], trades?: [], skips?: [], cfg? }
function renderReport(data) {
  const { date, minTrades } = data;
  const todays = MARKETS.flatMap(([m]) => data.today[m] || []);
  const stats = patternRows(data.closed, minTrades);
  const cfg = data.cfg || DEFAULTS;
  const views = (data.trades || []).map((t) => tradeView(t, cfg));
  const closedToday = todays.filter((t) => t.status === 'closed');
  const pnlToday = closedToday.reduce((s, t) => s + (Number.isFinite(t.pnl_inr) ? t.pnl_inr : 0), 0);
  const winsToday = closedToday.filter((t) => t.pnl_inr > 0).length;
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
td.w{white-space:normal;min-width:200px}small{font-size:12px}
.tiles{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}
.tile{flex:1 1 90px;background:#fff;border:1px solid #d9dce2;border-radius:8px;padding:8px 10px}
.tile b{display:block;font-size:19px}.tile span{font-size:12px;color:#555b66}
table.trades tbody tr{cursor:pointer}table.trades tbody tr:hover,table.trades tbody tr:focus,table.trades tbody tr.sel{background:#eaf1fd;outline:none}
#detail{background:#fff;border:1px solid #d9dce2;border-radius:8px;padding:10px 12px;margin:10px 0}
#chart{min-height:60px;margin:8px 0;color:#555b66;font-size:13px}
#d-basis{margin:8px 0;font-size:14px}#d-data,#chart-note{font-size:12px;color:#555b66;margin:4px 0}
.btn{display:inline-block;background:#2f6fde;color:#fff;text-decoration:none;border-radius:6px;padding:8px 12px;font-size:14px;margin-top:6px}
.how{background:#fff;border:1px solid #d9dce2;border-radius:8px;padding:8px 12px;margin:14px 0}
.how summary{font-weight:600;cursor:pointer}.how ul{margin:8px 0 2px;padding-left:18px}.how li{margin:5px 0;font-size:14px}
code{background:#eceef2;border-radius:4px;padding:0 4px;font-size:13px}
th{background:#eceef2;font-size:13px}tr.few td{color:#6b7280}
.empty{background:#fff;border:1px dashed #c3c7cf;border-radius:8px;padding:10px 12px;color:#555b66}
</style></head><body><main>
<h1>Paper bot report</h1>
<p class="note">${esc(date)} (IST) · made ${esc(istTime(data.generatedAt))} · storage: ${esc(data.storage)}</p>
<p class="note">PAPER trading only: a demo with no real money and no orders. Statistics, not investment advice.</p>
${data.storage === 'memory' ? '<p class="note"><b>Storage is memory only: trades are lost when the server restarts.</b></p>' : ''}
<div class="tiles">
<div class="tile"><b>${todays.length}</b><span>trades today</span></div>
<div class="tile"><b>${winsToday}</b><span>wins today (of ${closedToday.length} closed)</span></div>
<div class="tile"><b class="${pnlToday > 0 ? 'win' : pnlToday < 0 ? 'loss' : ''}">${esc(inr(pnlToday) || '₹0')}</b><span>total P&amp;L today, INR</span></div>
<div class="tile"><b>${(data.skips || []).length}</b><span>setups skipped today</span></div>
</div>
${howBox(cfg)}
<h2>All trades, newest first (${views.length})</h2>
<p class="note">Tap a row to see the chart, the entry and exit, the SL and target lines and why the trade was taken.${views.some((v) => v.levelsFromRules) ? ' SL / target of older trades are worked out from the current rules.' : ''}</p>
${tradeTable(views)}
<section id="detail" hidden>
<h3 id="d-title"></h3>
<div id="d-facts" class="note"></div>
<div id="chart"></div>
<div id="chart-note"></div>
<p id="d-basis"></p>
<div id="d-data"></div>
<a id="d-tv" class="btn" href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">Open in TradingView</a>
</section>
<h2>Skipped today (${(data.skips || []).length})</h2>
<p class="note">Setups the bot saw but did not trade, with the reason.</p>
${skipTable(data.skips || [])}
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
</main>
<script id="paper-data" type="application/json">${inlineJson({ trades: views })}</script>
<script src="${CHART_LIB}" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>${CLIENT}</script>
</body></html>`;
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
  const skips = (await store.skipsSince(date)).reverse(); // newest first
  return renderReport({ date, generatedAt: new Date(nowMs).toISOString(), storage: store.kind, minTrades: cfg.learning.min_trades_for_conclusion, today, open,
    closed: await store.closedTrades(), trades: await store.listTrades(100), skips, cfg });
}

// Data of one trade's chart: candles around the trade, entry / exit markers,
// SL and target lines. Read-only. Times are shifted to IST for the chart axis.
// NSE trades are OPTION trades, but the candles are the STOCK's: the SL and
// target lines show the stock price at which the option would reach its level
// at the bot's delta (exact for simulated options, approximate for real ones).
async function chartData({ store, nse, crypto, id, now = Date.now }) {
  const t = await store.getTrade(id);
  if (!t) return null;
  const cfg = merge(DEFAULTS, await store.getConfig());
  const entryMs = Date.parse(t.entry_time);
  const exitMs = t.exit_time ? Date.parse(t.exit_time) : null;
  const from = entryMs - 3 * 3600000;
  const to = Math.min(now(), (exitMs || now()) + 3600000);
  let raw = [];
  let note = '';
  let source = '';
  try {
    if (t.market === 'crypto') {
      const startMs = Math.max(from, to - 500 * FIVE_MIN);
      raw = await crypto.candles(t.symbol, 500, { startMs, endMs: to });
      source = 'Binance public 5-minute candles';
    } else {
      const got = await nse.chartCandles(t.symbol);
      raw = got.candles || [];
      source = `${got.dataSource || 'unknown'} 5-minute candles of the stock`;
    }
  } catch (e) {
    note = 'Live candles could not be read right now. ';
  }
  let candles = raw.filter((k) => k.t >= from && k.t <= to && k.t + FIVE_MIN <= now());
  if (!candles.length) {
    // no market candles for that time any more: draw the candles stored with the trade (the ones that fired the pattern)
    const seen = new Map();
    for (const g of t.trigger_candles || []) for (const k of g.candles || []) seen.set(k.t, k);
    candles = [...seen.values()].sort((a, b) => a.t - b.t);
    note += candles.length ? 'Showing only the candles stored with the trade (older market candles are no longer available). ' : '';
    source = 'candles stored with the trade';
  }
  const sec = (ms) => Math.floor((ms + IST_OFFSET_MS) / 1000);
  const lv = levelsOf(t, cfg);
  const up = t.direction === 'CALL' || t.direction === 'LONG';
  const lines = [];
  let exitPrice = t.exit_price;
  if (t.market === 'crypto') {
    const moved = t.breakeven_time && t.stop_active != null;
    lines.push({ kind: 'entry', price: t.entry_price, label: moved ? 'Entry = stop now (breakeven)' : 'Entry' },
      // short labels on the chart (a phone is narrow); the full wording is in the note under it
      { kind: 'sl', price: lv.sl, label: t.stop_type ? `SL: ${t.r_detail?.plan?.stopType || t.stop_type}` : 'SL' },
      { kind: 'target', price: lv.target, label: t.target_type ? `Target: ${t.r_detail?.plan?.targetType || t.target_type}` : 'Target' });
    if (t.target_type) note += `Target ${lv.target} sits just before the ${t.target_type}. Stop ${lv.sl}: ${t.stop_type}.${moved ? ` Stop was moved to the entry at ${istTime(t.breakeven_time)}.` : ''} `;
  } else if (t.entry_underlying > 0 && lv.sl != null) {
    const d = cfg.nse.sim_delta;
    const sign = up ? 1 : -1;
    lines.push({ kind: 'entry', price: t.entry_underlying, label: `Entry (option ${t.entry_price})` },
      { kind: 'sl', price: round(t.entry_underlying - sign * (t.entry_price - lv.sl) / d, 2), label: `SL (option ${lv.sl})` },
      { kind: 'target', price: round(t.entry_underlying + sign * (lv.target - t.entry_price) / d, 2), label: `Target (option ${lv.target})` });
    exitPrice = t.exit_underlying;
    note += `Chart shows the STOCK; the trade was on its option. SL and target lines are the stock prices where the option reaches its level at delta ${d}${t.simulated_option ? '' : ' (approximate for a real option)'}. `;
  }
  const markers = [{ kind: 'entry', time: sec(entryMs), below: up, text: 'Entry' }]; // short labels: the facts line above the chart has the details
  if (exitMs) markers.push({ kind: 'exit', time: sec(exitMs), below: !up, text: 'Exit', price: exitPrice ?? null });
  return {
    id: t.id, market: t.market, symbol: t.symbol, tz: 'IST', source, note: `${note}Candles: ${source}. Times are IST.`.trim(),
    candles: candles.map((k) => ({ time: sec(k.t), open: k.o, high: k.h, low: k.l, close: k.c })),
    lines: lines.filter((l) => Number.isFinite(l.price)), markers,
  };
}

module.exports = { buildReport, renderReport, chartData, levelsOf, tradeView, tradingViewSymbol, dayTotals, patternRows, pnlOf, money, CHART_LIB };
