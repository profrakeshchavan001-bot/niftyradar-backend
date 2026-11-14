'use strict';
// Read-only report page: GET /api/paper/report (paperbot/reportPage.js).
// All expected numbers are worked out by hand in the comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPaperBot } = require('../paperbot');
const { renderReport, dayTotals, patternRows, pnlOf, money } = require('../paperbot/reportPage');

const NOW = Date.UTC(2026, 10, 13, 9, 0); // Fri 13 Nov 2026 14:30 IST
const base = { trade_date: '2026-11-13', qty: 2000, entry_time: '2026-11-13T05:35:20.000Z' };
const T = {
  nseWin: { ...base, id: 1, market: 'nse', symbol: 'RELIANCE', direction: 'CALL', status: 'closed', patterns: ['exhaustion_reversal'], entry_price: 20, exit_price: 22.1,
    exit_time: '2026-11-13T05:38:50.000Z', exit_reason: 'target', pnl_inr: 4200, data_source: 'yahoo', data_delay_sec: 20, simulated_option: true,
    basis: 'Bought a CALL on RELIANCE because it was in the top R-factor list (risk-reward R 3).' },
  nseLoss: { ...base, id: 2, market: 'nse', symbol: 'M&M', direction: 'PUT', status: 'closed', patterns: ['exhaustion_reversal', 'inside_bar'], entry_price: 30, exit_price: 28.5,
    exit_time: '2026-11-13T07:00:50.000Z', exit_reason: 'stop', pnl_inr: -1500, data_source: 'dhan', data_delay_sec: 20, basis: 'Bought a PUT on M&M <script>alert(1)</script>.' },
  cryptoWin: { ...base, id: 3, market: 'crypto', symbol: 'BTCUSDT', direction: 'LONG', status: 'closed', patterns: ['order_block'], qty: 0.01, entry_price: 100000, exit_price: 101000,
    exit_time: '2026-11-13T08:00:55.000Z', exit_reason: 'target', pnl_inr: 880, fx_rate: 88, basis: 'Went LONG on BTCUSDT because its momentum score was 2.' },
  cryptoOpen: { ...base, id: 4, market: 'crypto', symbol: 'ETHUSDT', direction: 'SHORT', status: 'open', patterns: ['order_block'], qty: 0.1, entry_price: 3000, basis: 'Went SHORT on ETHUSDT.' },
};

test('P&L unit: INR for NSE, USDT for crypto (stored INR / stored FX rate); open trade has no P&L', () => {
  assert.deepEqual(pnlOf(T.nseWin), { value: 4200, unit: 'INR' });
  assert.deepEqual(pnlOf(T.cryptoWin), { value: 10, unit: 'USDT' }); // 880 / 88 = 10
  assert.equal(pnlOf(T.cryptoOpen), null);
  assert.deepEqual(pnlOf({ ...T.cryptoWin, fx_rate: null }), { value: 880, unit: 'INR' }); // no stored rate: stays in INR, nothing assumed
  assert.equal(money(4200, 'INR'), '+₹4,200');
  assert.equal(money(-1500, 'INR'), '-₹1,500');
  assert.equal(money(10, 'USDT'), '+10.00 USDT');
});

test('day totals per market', () => {
  // NSE: 4200 - 1500 = 2700, 1 win, 1 loss
  assert.deepEqual(dayTotals([T.nseWin, T.nseLoss]), { trades: 2, closed: 2, open: 0, wins: 1, losses: 1, pnl: { INR: 2700 } });
  assert.deepEqual(dayTotals([T.cryptoWin, T.cryptoOpen]), { trades: 2, closed: 1, open: 1, wins: 1, losses: 0, pnl: { USDT: 10 } });
  assert.deepEqual(dayTotals([]), { trades: 0, closed: 0, open: 0, wins: 0, losses: 0, pnl: {} });
});

test('per pattern since start: win rate, average P&L, "too few trades" under 20', () => {
  const rows = patternRows([T.nseWin, T.nseLoss, T.cryptoWin], 20);
  const pick = (market, pattern) => rows.find((r) => r.market === market && r.pattern === pattern);
  // exhaustion_reversal: 2 trades (4200, -1500) -> 1 win = 50 %, average (4200 - 1500) / 2 = 1350
  assert.deepEqual(pick('nse', 'exhaustion_reversal'), { market: 'nse', label: 'NSE', unit: 'INR', pattern: 'exhaustion_reversal', trades: 2, wins: 1, winRatePct: 50, avgPnl: 1350, enough: false });
  // inside_bar: only the losing trade -> 0 %, average -1500
  assert.deepEqual([pick('nse', 'inside_bar').trades, pick('nse', 'inside_bar').winRatePct, pick('nse', 'inside_bar').avgPnl], [1, 0, -1500]);
  assert.deepEqual([pick('crypto', 'order_block').unit, pick('crypto', 'order_block').avgPnl], ['USDT', 10]);
  // 20 trades: 15 x +100 and 5 x -200 -> 75 % wins, average (1500 - 1000) / 20 = 25, enough for a conclusion
  const many = Array.from({ length: 20 }, (_, i) => ({ market: 'nse', status: 'closed', patterns: ['engulfing'], pnl_inr: i < 15 ? 100 : -200 }));
  const big = patternRows(many, 20)[0];
  assert.deepEqual([big.trades, big.winRatePct, big.avgPnl, big.enough], [20, 75, 25, true]);
  assert.equal(patternRows(many.slice(0, 19), 20)[0].enough, false);
});

const page = () => renderReport({ date: '2026-11-13', generatedAt: new Date(NOW).toISOString(), storage: 'postgres', minTrades: 20,
  today: { nse: [T.nseWin, T.nseLoss], crypto: [T.cryptoWin, T.cryptoOpen] }, open: [T.cryptoOpen], closed: [T.nseWin, T.nseLoss, T.cryptoWin] });

test('page: readable HTML with trades, totals, open trades and the pattern table; mobile friendly, nothing external', () => {
  const html = page();
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /NSE · RELIANCE · CALL/);
  assert.match(html, /<span>Pattern<\/span> exhaustion reversal/);
  assert.match(html, /<span>Entry<\/span> 20 x 2000 at 11:05 IST/); // 05:35 UTC = 11:05 IST
  assert.match(html, /<span>Exit<\/span> 22\.1 at 11:08 IST \(target\)/);
  assert.match(html, /<b class="win">\+₹4,200<\/b>/);
  assert.match(html, /<b class="loss">-₹1,500<\/b>/);
  assert.match(html, /<b class="win">\+10\.00 USDT<\/b>/);
  assert.match(html, /Bought a CALL on RELIANCE because it was in the top R-factor list/); // basis sentence
  assert.match(html, /<span>Data<\/span> yahoo, latest candle 20 s old at entry · option price SIMULATED/);
  assert.match(html, /<tr><td>NSE<\/td><td>2<\/td><td>1 \/ 1<\/td><td>0<\/td><td>\+₹2,700<\/td><\/tr>/);
  assert.match(html, /<tr><td>Crypto<\/td><td>2<\/td><td>1 \/ 0<\/td><td>1<\/td><td>\+10\.00 USDT<\/td><\/tr>/);
  assert.match(html, /Open trades \(1\)/);
  assert.match(html, /Crypto · ETHUSDT · SHORT/);
  assert.match(html, /<td class="w">NSE · exhaustion reversal<br><small>too few trades<\/small><\/td><td>2<\/td><td>50%<\/td><td>\+₹1,350<\/td>/);
  assert.match(html, /PAPER trading only/);
  // user-controlled text is escaped; no script, no external file
  assert.match(html, /M&amp;M &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script|<link|<img|src=|href=|https?:\/\//i);
});

test('page with no trades at all says so', () => {
  const html = renderReport({ date: '2026-11-13', generatedAt: new Date(NOW).toISOString(), storage: 'memory', minTrades: 20, today: { nse: [], crypto: [] }, open: [], closed: [] });
  assert.match(html, /No trades today\./);
  assert.match(html, /No open trades\./);
  assert.match(html, /No closed trades yet\./);
  assert.match(html, /Storage is memory only/);
});

function mount(env) {
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  const state = attachPaperBot({ app, cron: { schedule() {} }, axios: {}, deps: {}, env, log: () => {}, wakeDelayMs: 2 ** 30 });
  const call = async (pathname, { query = {}, headers = {} } = {}) => {
    const out = { status: 200, headers: {}, type: null, body: null };
    const res = {
      set(a, b) { if (typeof a === 'object') Object.assign(out.headers, a); else out.headers[a] = b; return res; },
      status(c) { out.status = c; return res; }, type(t) { out.type = t; return res; },
      send(b) { out.body = b; return res; }, json(b) { out.body = b; out.type = 'json'; return res; },
    };
    await routes[pathname]({ query, get: (h) => headers[h] }, res);
    return out;
  };
  return { state, routes, call };
}

test('GET /api/paper/report: needs the PAPER_ADMIN_SECRET as ?key=, answers HTML, changes nothing', async () => {
  const m = mount({ PAPER_ADMIN_SECRET: 'right-key' });
  assert.equal((await m.call('/api/paper/report')).status, 401);
  assert.equal((await m.call('/api/paper/report', { query: { key: 'wrong' } })).status, 401);
  assert.equal((await m.call('/api/paper/report', { query: { key: ['right-key', 'right-key'] } })).status, 401);
  const denied = await m.call('/api/paper/report', { query: { key: 'wrong' } });
  assert.doesNotMatch(String(denied.body), /<html|trade/i);

  const real = Date.now;
  try {
    Date.now = () => NOW;
    await m.state.store.insertTrade({ ...T.nseWin, id: undefined });
    await m.state.store.insertTrade({ ...T.cryptoOpen, id: undefined });
    const before = JSON.stringify(m.state.store._db);
    const ok = await m.call('/api/paper/report', { query: { key: 'right-key' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.type, 'html');
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    assert.equal(ok.headers['Referrer-Policy'], 'no-referrer');
    assert.match(ok.body, /NSE · RELIANCE · CALL/);
    assert.match(ok.body, /Open trades \(1\)/);
    assert.match(ok.body, /2026-11-13 \(IST\) · made 14:30 IST · storage: memory/);
    assert.equal(JSON.stringify(m.state.store._db), before); // read-only: not even the config rows are written
    assert.equal((await m.call('/api/paper/report', { headers: { 'x-paper-secret': 'right-key' } })).status, 200);
  } finally { Date.now = real; }
  // the JSON routes that were there before still answer JSON
  assert.equal((await m.call('/api/paper/trades', { query: { key: 'right-key' } })).body.rows.length, 2);
});

test('GET /api/paper/report: 503 without a configured secret or with the bot switched off', async () => {
  assert.equal((await mount({}).call('/api/paper/report', { query: { key: '' } })).status, 503);
  const off = await mount({ PAPER_ADMIN_SECRET: 'right-key', PAPER_BOT_ENABLED: 'false' }).call('/api/paper/report', { query: { key: 'right-key' } });
  assert.equal(off.status, 503);
  assert.match(off.body, /disabled/);
});
