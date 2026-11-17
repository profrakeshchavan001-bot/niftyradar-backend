'use strict';
// Read-only report page: GET /api/paper/report (paperbot/reportPage.js).
// All expected numbers are worked out by hand in the comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPaperBot } = require('../paperbot');
const { renderReport, chartData, levelsOf, tradingViewSymbol, dayTotals, patternRows, pnlOf, money, CHART_LIB } = require('../paperbot/reportPage');
const { createMemoryStore } = require('../paperbot/store');
const { DEFAULTS } = require('../paperbot/config');

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

const page = (extra = {}) => renderReport({ date: '2026-11-13', generatedAt: new Date(NOW).toISOString(), storage: 'postgres', minTrades: 20,
  today: { nse: [T.nseWin, T.nseLoss], crypto: [T.cryptoWin, T.cryptoOpen] }, open: [T.cryptoOpen], closed: [T.nseWin, T.nseLoss, T.cryptoWin],
  trades: [T.cryptoOpen, T.cryptoWin, T.nseLoss, T.nseWin], ...extra });

test('page: readable HTML with trades, totals, open trades and the pattern table; mobile friendly', () => {
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
  // user-controlled text is escaped everywhere, also inside the data block the page script reads
  assert.match(html, /M&amp;M &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)/);
  const block = html.match(/<script id="paper-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.ok(!block.includes('<'));
  assert.match(JSON.parse(block).trades.find((t) => t.symbol === 'M&M').basis, /<script>alert\(1\)<\/script>/); // intact as data, set with textContent
  // the only external file is the pinned open-source chart library; the only link is the TradingView button
  const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, ['https://www.tradingview.com/', CHART_LIB]);
  assert.match(CHART_LIB, /^https:\/\/unpkg\.com\/lightweight-charts@\d+\.\d+\.\d+\//);
});

test('page: top tiles, trades table newest first with SL / target, skipped list, "How the bot decides"', () => {
  const skips = [{ market: 'nse', symbol: 'TCS', reason: 'news filter: news today: "TCS <b>results</b>"', patterns: ['hammer'], created_at: '2026-11-13T05:00:20.000Z', data_source: 'yahoo_delayed', data_delay_sec: 920 }];
  const html = page({ trades: [T.cryptoOpen, T.cryptoWin, T.nseLoss, T.nseWin], skips, cfg: DEFAULTS });
  // today: 4 trades, 3 closed, 2 wins; INR total = 4200 - 1500 + 880 = 3580
  assert.match(html, /<b>4<\/b><span>trades today<\/span>/);
  assert.match(html, /<b>2<\/b><span>wins today \(of 3 closed\)<\/span>/);
  assert.match(html, /<b class="win">\+₹3,580<\/b><span>total P&amp;L today, INR<\/span>/);
  assert.match(html, /<th>Market<\/th><th>Symbol<\/th><th>Direction<\/th><th>Entry<\/th><th>SL<\/th><th>Target<\/th><th>Exit<\/th><th>Exit reason<\/th><th>P&amp;L \(INR\)<\/th><th>Status<\/th>/);
  // NSE option trade without stored levels: SL 20 x 0.95 = 19, target 20 x 1.10 = 22
  assert.match(html, /<tr data-id="1"[^>]*><td>NSE<\/td><td>RELIANCE<\/td><td>CALL<\/td><td>20<\/td><td>19<\/td><td>22<\/td><td>22\.1<\/td><td>target<\/td><td><b class="win">\+₹4,200<\/b><\/td><td>closed<\/td>/);
  // crypto SHORT at 3000: SL 1% above = 3030, target 2% below = 2940; still open
  assert.match(html, /<tr data-id="4"[^>]*><td>Crypto<\/td><td>ETHUSDT<\/td><td>SHORT<\/td><td>3000<\/td><td>3030<\/td><td>2940<\/td><td><\/td><td><\/td><td><b class=""><\/b><\/td><td>open<\/td>/);
  assert.ok(html.indexOf('data-id="4"') < html.indexOf('data-id="1"')); // order as given: newest first
  assert.match(html, /Skipped today \(1\)/);
  assert.match(html, /<td>TCS<\/td><td class="w">news filter: news today: &quot;TCS &lt;b&gt;results&lt;\/b&gt;&quot;<br><small>pattern seen: hammer<\/small><br><small>data: yahoo_delayed, 920 s old<\/small>/);
  assert.match(html, /<summary>How the bot decides<\/summary>/);
  for (const word of ['Data source', 'Pattern rules', 'Trend and VWAP', 'Momentum', 'News', 'yahoo_delayed', 'no daily limit']) assert.ok(html.includes(word), word);
  assert.match(html, /Open in TradingView/);
});

test('levels and TradingView symbol', () => {
  assert.deepEqual(levelsOf({ market: 'nse', direction: 'PUT', entry_price: 30 }, DEFAULTS), { sl: 28.5, target: 33, fromRules: true }); // option bought: -5% / +10%
  assert.deepEqual(levelsOf({ market: 'crypto', direction: 'LONG', entry_price: 100000 }, DEFAULTS), { sl: 99000, target: 102000, fromRules: true });
  assert.deepEqual(levelsOf({ market: 'nse', entry_price: 20, sl_price: 18.8, target_price: 22.4 }, DEFAULTS), { sl: 18.8, target: 22.4, fromRules: false }); // stored at entry wins
  assert.equal(tradingViewSymbol({ market: 'crypto', symbol: 'ETHUSDT' }), 'BINANCE:ETHUSDT');
  assert.equal(tradingViewSymbol({ market: 'nse', symbol: 'RELIANCE' }), 'NSE:RELIANCE');
  assert.equal(tradingViewSymbol({ market: 'nse', symbol: 'M&M' }), 'NSE:M_M');
  assert.equal(tradingViewSymbol({ market: 'nse', symbol: 'BAJAJ-AUTO' }), 'NSE:BAJAJ_AUTO');
});

test('chart data: candles around the trade, entry / exit markers, SL and target lines', async () => {
  const store = createMemoryStore();
  const FIVE = 300000;
  const entry = Date.UTC(2026, 10, 13, 5, 35, 20); // 11:05:20 IST
  const mk = (t, c) => ({ t, o: c - 1, h: c + 1, l: c - 2, c, v: 10 });
  // NSE CALL, simulated option: entry 20 (SL 19, target 22) with the stock at 492
  const nseId = await store.insertTrade({ market: 'nse', symbol: 'RELIANCE', direction: 'CALL', trade_date: '2026-11-13', entry_price: 20, sl_price: 19, target_price: 22, entry_underlying: 492,
    entry_time: new Date(entry).toISOString(), simulated_option: true, patterns: [], qty: 1, basis: 'b' });
  await store.updateTrade(nseId, { status: 'closed', exit_time: new Date(entry + 10 * FIVE).toISOString(), exit_price: 22.1, exit_underlying: 496.2, exit_reason: 'target' });
  const stock = [mk(entry - 4 * 3600000, 480), mk(entry - 20000 - FIVE, 491), mk(entry - 20000, 492), mk(entry - 20000 + 10 * FIVE, 496), mk(entry + 5 * 3600000, 500)];
  const nse = { chartCandles: async () => ({ candles: stock, dataSource: 'yahoo_delayed' }) };
  const now = () => entry + 6 * 3600000;
  const d = await chartData({ store, nse, crypto: null, id: nseId, now });
  // window = entry - 3 h ... exit + 1 h: the first and the last candle fall outside
  assert.deepEqual(d.candles.map((k) => k.close), [491, 492, 496]);
  // IST on the axis: the candle that opened at 11:05:00 IST -> seconds of 11:05:00 as if UTC
  assert.equal(d.candles[1].time, Date.UTC(2026, 10, 13, 11, 5, 0) / 1000);
  assert.deepEqual(d.candles[1], { time: d.candles[1].time, open: 491, high: 493, low: 490, close: 492 });
  // stock-price lines at delta 0.5: SL 492 - (20 - 19) / 0.5 = 490, target 492 + (22 - 20) / 0.5 = 496
  assert.deepEqual(d.lines.map((l) => [l.kind, l.price]), [['entry', 492], ['sl', 490], ['target', 496]]);
  assert.deepEqual(d.markers.map((m) => [m.kind, m.below, m.text]), [['entry', true, 'Entry'], ['exit', false, 'Exit']]);
  assert.match(d.note, /Chart shows the STOCK; the trade was on its option/);

  // crypto SHORT, still open: levels from the rules (SL +1%, target -2%); Binance is asked for the trade's window only
  const cId = await store.insertTrade({ market: 'crypto', symbol: 'ETHUSDT', direction: 'SHORT', trade_date: '2026-11-13', entry_price: 3000, entry_underlying: 3000, entry_time: new Date(entry).toISOString(), patterns: [], qty: 1, basis: 'b' });
  const asked = [];
  const crypto = { candles: async (symbol, limit, range) => { asked.push([symbol, limit, range]); return [mk(entry - 20000, 3000)]; } };
  const c = await chartData({ store, nse, crypto, id: cId, now: () => entry + FIVE });
  assert.deepEqual(asked[0], ['ETHUSDT', 500, { startMs: entry - 3 * 3600000, endMs: entry + FIVE }]);
  assert.deepEqual(c.lines.map((l) => [l.kind, l.price]), [['entry', 3000], ['sl', 3030], ['target', 2940]]);
  assert.deepEqual(c.markers.map((m) => [m.kind, m.below]), [['entry', false]]); // short: entry arrow above the candle, no exit yet

  // no market candles any more (old trade or feed down): the candles stored with the trade are drawn, and the note says so
  const oldId = await store.insertTrade({ market: 'nse', symbol: 'TCS', direction: 'PUT', trade_date: '2026-11-13', entry_price: 30, entry_underlying: 3000, entry_time: new Date(entry).toISOString(), patterns: ['hammer'], qty: 1, basis: 'b',
    trigger_candles: [{ pattern: 'hammer', candles: [mk(entry - 20000 - FIVE, 3001), mk(entry - 20000, 3000)] }] });
  const o = await chartData({ store, nse: { chartCandles: async () => { throw new Error('down'); } }, crypto, id: oldId, now });
  assert.deepEqual(o.candles.map((k) => k.close), [3001, 3000]);
  assert.match(o.note, /Live candles could not be read right now\. Showing only the candles stored with the trade/);
  assert.equal(await chartData({ store, nse, crypto, id: 999, now }), null);
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
    // Scoped to trades/skips, not the whole _db: other bots/ plugins (auto-loaded fire-and-forget -
    // paperbot/index.js's own comment calls this out) lazily write their OWN config rows in the
    // background on their own schedule, unrelated to this route and not synchronized with this test -
    // comparing the whole _db would make this assertion race against that unrelated background work
    // (how many plugins happen to exist) instead of testing what it actually means to: this ROUTE never
    // inserts/updates a trade or a skip.
    const before = JSON.stringify({ trades: m.state.store._db.trades, skips: m.state.store._db.skips });
    const ok = await m.call('/api/paper/report', { query: { key: 'right-key' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.type, 'html');
    assert.equal(ok.headers['Cache-Control'], 'no-store');
    assert.equal(ok.headers['Referrer-Policy'], 'no-referrer');
    assert.match(ok.body, /NSE · RELIANCE · CALL/);
    assert.match(ok.body, /Open trades \(1\)/);
    assert.match(ok.body, /2026-11-13 \(IST\) · made 14:30 IST · storage: memory/);
    assert.equal(JSON.stringify({ trades: m.state.store._db.trades, skips: m.state.store._db.skips }), before); // read-only: never inserts/updates a trade or a skip
    assert.equal((await m.call('/api/paper/report', { headers: { 'x-paper-secret': 'right-key' } })).status, 200);
  } finally { Date.now = real; }
  // the JSON routes that were there before still answer JSON
  assert.equal((await m.call('/api/paper/trades', { query: { key: 'right-key' } })).body.rows.length, 2);
  // chart route: key needed, id checked, unknown trade = 404
  assert.equal((await m.call('/api/paper/chart', { query: { id: '1' } })).status, 401);
  assert.equal((await m.call('/api/paper/chart', { query: { key: 'right-key', id: '1; drop table' } })).status, 400);
  assert.equal((await m.call('/api/paper/chart', { query: { key: 'right-key', id: '77' } })).status, 404);
  const chart = await m.call('/api/paper/chart', { query: { key: 'right-key', id: '1' } });
  assert.equal(chart.status, 200);
  assert.deepEqual([chart.body.symbol, chart.body.market, chart.body.tz], ['RELIANCE', 'nse', 'IST']);
});

test('GET /api/paper/report: 503 without a configured secret or with the bot switched off', async () => {
  assert.equal((await mount({}).call('/api/paper/report', { query: { key: '' } })).status, 503);
  const off = await mount({ PAPER_ADMIN_SECRET: 'right-key', PAPER_BOT_ENABLED: 'false' }).call('/api/paper/report', { query: { key: 'right-key' } });
  assert.equal(off.status, 503);
  assert.match(off.body, /disabled/);
});

test('GET /api/paper/universe: same lists as docs/UNIVERSE.md, key needed', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');
  // the live list is the Nifty 50 basket written in server.js (the site's Movers basket)
  const live = fs.readFileSync(path.join(root, 'server.js'), 'utf8').match(/const NIFTY50_SYMBOLS = \[([\s\S]*?)\];/)[1].match(/'[^']+'/g).map((x) => x.slice(1, -1));
  const fallback = JSON.parse(fs.readFileSync(path.join(root, 'data', 'nse-fno-top60.json'), 'utf8')).symbols;
  assert.deepEqual([live.length, fallback.length], [50, 60]);
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  attachPaperBot({ app, cron: { schedule() {} }, axios: {}, deps: { universe: live }, env: { PAPER_ADMIN_SECRET: 'k' }, log: () => {}, wakeDelayMs: 2 ** 30 });
  const ask = async (query) => { const out = { status: 200 }; const res = { set() { return res; }, status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; } }; await routes['/api/paper/universe']({ query, get: () => undefined }, res); return out; };
  assert.equal((await ask({})).status, 401);
  const u = (await ask({ key: 'k' })).body;
  assert.deepEqual(u.nse.whenDhanIsLive.symbols, live);
  assert.deepEqual(u.nse.whenDhanIsDown.symbols, fallback);
  assert.deepEqual(u.crypto.symbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.match(u.nse.liquidityFilter, /Rs 1,00,00,000/);
  assert.match(u.nse.picked, /^top 5 by R factor/);
  // docs/UNIVERSE.md lists exactly the same symbols, in the same order
  const doc = fs.readFileSync(path.join(root, 'docs', 'UNIVERSE.md'), 'utf8');
  const listed = (title) => doc.split(title)[1].split('```')[1].trim().split(/[\s,]+/).filter(Boolean);
  assert.deepEqual(listed('## List 1'), live);
  assert.deepEqual(listed('## List 2'), fallback);
});
