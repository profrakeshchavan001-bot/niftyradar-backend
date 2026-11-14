'use strict';
// Sector momentum module. Every expected number is worked out by hand in the comment next to it, not copied from the code's output.
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/paper/context/sector');
const fixture = () => JSON.parse(JSON.stringify(require('./fixtures/sector_quotes.json')));
const ctx = (data = fixture(), extra = {}) => S.createSectorContext({ adapter: S.createFixtureAdapter(data), ...extra });

test('scale: -range = 0, 0 = 50, +range = 100, clamped outside', () => {
  assert.equal(S.scale(-2, 2), 0);
  assert.equal(S.scale(0, 2), 50);
  assert.equal(S.scale(1, 2), 75); // (1 + 2) / 4 = 0.75
  assert.equal(S.scale(2, 2), 100);
  assert.equal(S.scale(9, 2), 100);
  assert.equal(S.scale(-9, 2), 0);
});

test('map: every stock belongs to exactly one sector; lookups accept the usual spellings', () => {
  const map = S.loadSectorMap();
  const all = Object.values(map.sectors).flatMap((d) => d.stocks);
  assert.equal(new Set(all).size, all.length);
  assert.equal(Object.keys(map.sectors).length, 16);
  assert.equal(S.sectorOf('TCS', map), 'IT');
  assert.equal(S.sectorOf(' tcs.ns ', map), 'IT');
  assert.equal(S.sectorOf('NSE:M&M', map), 'Auto');
  assert.equal(S.sectorOf('BAJAJ-AUTO', map), 'Auto');
  assert.equal(S.sectorOf('NOTASTOCK', map), null);
  assert.equal(S.sectorOf("x'; drop", map), null);
  assert.equal(S.sectorOf(null, map), null);
});

test('sectorScore IT: STRONG 75 (hand-checked)', async () => {
  // change today +1 %            -> (1 + 2) / 4 * 100       = 75
  // vs Nifty 1 - 0.4 = +0.6      -> (0.6 + 1.5) / 3 * 100   = 70
  // breadth: TCS, INFY, WIPRO, HCLTECH above previous close, TECHM below -> 4 of 5 = 80 (the map has 6 IT stocks, 5 have data: enough)
  // 3-day trend 40800 / 40000 - 1 = +2 % -> (2 + 4) / 8 * 100 = 75
  // score = (30*75 + 30*70 + 20*80 + 20*75) / 100 = (2250 + 2100 + 1600 + 1500) / 100 = 74.5 -> 75
  const s = await ctx().sectorScore('IT');
  assert.deepEqual(s, { sector: 'IT', score: 75, label: 'STRONG', vsNifty: 0.6, changePct: 1, niftyPct: 0.4, breadthPct: 80, trend3Pct: 2, basis: 'index', missing: [], asOf: '2026-11-13T10:00:00.000Z' });
});

test('sectorScore Metal: WEAK 4 (hand-checked, VWAP used when given)', async () => {
  // change today -1.6 %          -> (-1.6 + 2) / 4 * 100    = 10
  // vs Nifty -1.6 - 0.4 = -2.0   -> below -1.5              = 0
  // breadth: TATASTEEL 147 < 150, HINDALCO 640 < vwap 645, JSWSTEEL 890 < 900, VEDL 441 < 450, SAIL 121 < vwap 122 (above prev close 120, but VWAP wins) -> 0 of 5 = 0
  // 3-day trend 9643.2 / 10000 - 1 = -3.568 % -> (-3.568 + 4) / 8 * 100 = 5.4
  // score = (30*10 + 30*0 + 20*0 + 20*5.4) / 100 = (300 + 108) / 100 = 4.08 -> 4
  const s = await ctx().sectorScore('Metal');
  assert.equal(s.score, 4);
  assert.equal(s.label, 'WEAK');
  assert.equal(s.vsNifty, -2);
  assert.equal(s.breadthPct, 0);
  assert.equal(s.trend3Pct, -3.57);
});

test('sectorScore Power (no index): stocks average is used, the 3-day trend is named as missing (hand-checked)', async () => {
  // stock moves: +1 %, -1 %, +1 %, +1 % -> average +0.5 %   -> (0.5 + 2) / 4 * 100   = 62.5
  // vs Nifty 0.5 - 0.4 = +0.1                               -> (0.1 + 1.5) / 3 * 100 = 53.33
  // breadth 3 of 4 = 75
  // trend missing -> weights 30 + 30 + 20 = 80
  // score = (30*62.5 + 30*53.33 + 20*75) / 80 = (1875 + 1600 + 1500) / 80 = 62.19 -> 62
  const s = await ctx().sectorScore('Power');
  assert.equal(s.score, 62);
  assert.equal(s.label, 'AVERAGE');
  assert.equal(s.basis, 'stocks_average');
  assert.deepEqual(s.missing, ['trend']);
  assert.equal(s.vsNifty, 0.1);
});

test('labels: 65 and above STRONG, 35 and below WEAK, between AVERAGE', () => {
  assert.deepEqual([100, 65, 64, 36, 35, 0].map(S.labelOf), ['STRONG', 'STRONG', 'AVERAGE', 'AVERAGE', 'WEAK', 'WEAK']);
});

test('stockSectorView: only the four fields the bot needs', async () => {
  const c = ctx();
  assert.deepEqual(await c.stockSectorView('INFY'), { sector: 'IT', score: 75, label: 'STRONG', vsNifty: 0.6 });
  assert.deepEqual(await c.stockSectorView('tatasteel.ns'), { sector: 'Metal', score: 4, label: 'WEAK', vsNifty: -2 });
  assert.equal(await c.stockSectorView('NOTASTOCK'), null); // not in the map
});

test('never fake data: null when the source fails, when Nifty is missing, when the sector has too little data', async () => {
  assert.equal(await ctx(null).sectorScore('IT'), null);
  assert.equal(await S.createSectorContext({ adapter: { getSectorQuotes: async () => { throw new Error('HTTP 403'); } } }).stockSectorView('TCS'), null);
  const noNifty = fixture(); delete noNifty.nifty;
  assert.equal(await ctx(noNifty).sectorScore('IT'), null);
  assert.equal(await ctx().sectorScore('Pharma'), null); // no index and 1 of 5 stocks: no sector move can be stated
  assert.equal(await ctx().sectorScore('Realty'), null); // sector absent from the source answer
  assert.equal(await ctx().sectorScore('Crypto'), null); // unknown sector name
  assert.throws(() => S.createSectorContext({}), /adapter/);
});

test('missing parts: no breadth data and a short history are named, the rest is re-weighted (hand-checked)', () => {
  // change +1 -> 75, vs Nifty +0.6 -> 70, breadth missing (no stocks), trend missing (3 closes) -> (30*75 + 30*70) / 60 = 72.5 -> 73
  const s = S.scoreSector({ index: { pct: 1, closes: [100, 101, 102] }, stocks: [] }, { pct: 0.4 }, 6);
  assert.equal(s.score, 73);
  assert.deepEqual(s.missing, ['breadth', 'trend']);
  assert.equal(S.scoreSector({ index: { pct: 1, closes: [] }, stocks: [] }, { pct: null }), null);
});

test('cache: one source call inside 5 minutes, a new one after; a failure is retried after 1 minute', async () => {
  let t = 0;
  const adapter = S.createFixtureAdapter(fixture());
  const c = S.createSectorContext({ adapter, now: () => t });
  await c.sectorScore('IT'); await c.stockSectorView('TCS'); await c.sectorScore('Metal');
  assert.equal(adapter.calls(), 1);
  t = 5 * 60 * 1000 - 1; await c.sectorScore('IT');
  assert.equal(adapter.calls(), 1);
  t = 5 * 60 * 1000; await c.sectorScore('IT');
  assert.equal(adapter.calls(), 2);

  let u = 0;
  const flaky = S.createFixtureAdapter((n) => (n === 1 ? null : fixture()));
  const f = S.createSectorContext({ adapter: flaky, now: () => u });
  assert.equal(await f.sectorScore('IT'), null);
  u = 59_000; assert.equal(await f.sectorScore('IT'), null);
  assert.equal(flaky.calls(), 1);
  u = 60_000; assert.equal((await f.sectorScore('IT')).score, 75);
  assert.equal(flaky.calls(), 2);
  assert.equal(S.CACHE_TTL_MS, 300000);
});

test('cache: calls made at the same moment share one source request', async () => {
  const adapter = S.createFixtureAdapter(fixture());
  const c = S.createSectorContext({ adapter });
  await Promise.all([c.sectorScore('IT'), c.sectorScore('Metal'), c.stockSectorView('TCS')]);
  assert.equal(adapter.calls(), 1);
});

// A Yahoo chart answer cut down to the fields that are read.
const chart = (closes, price, time = 1794650400) => ({ chart: { result: [{ meta: { regularMarketPrice: price, regularMarketTime: time }, indicators: { quote: [{ close: closes }] } }], error: null } });

test('parseYahooChart: latest price against the previous session close; gaps (null) are dropped (hand-checked)', () => {
  // closes 100, null, 102, 104, 105.5(bar) with live price 106.08 -> previous close 104 -> 106.08 / 104 - 1 = +2 %
  const q = S.parseYahooChart(chart([100, null, 102, 104, 105.5], 106.08));
  assert.equal(q.price, 106.08);
  assert.equal(q.prevClose, 104);
  assert.equal(Math.round(q.pct * 1e6) / 1e6, 2);
  assert.deepEqual(q.closes, [100, 102, 104, 106.08]);
  assert.equal(q.asOf, '2026-11-14T10:00:00.000Z'); // 1794650400 s = 2026-11-14 10:00 UTC
  assert.equal(S.parseYahooChart(chart([100], 100)), null); // one bar: no previous close
  assert.equal(S.parseYahooChart({ chart: { result: null, error: { code: 'Not Found' } } }), null);
  assert.equal(S.parseYahooChart(null), null);
});

test('Yahoo adapter (fake network): asks ^NSEI, each index and each SYMBOL.NS; failed tickers are left out; no Nifty = null', async () => {
  const map = { benchmark: { yahooIndex: '^NSEI' }, sectors: { IT: { yahooIndex: '^CNXIT', stocks: ['TCS', 'INFY'] }, Auto: { yahooIndex: null, stocks: ['M&M'] } } };
  const asked = [];
  const answers = { '%5ENSEI': chart([100, 100, 100, 100, 100], 100.4), '%5ECNXIT': chart([400, 400, 402, 404, 408], 408.04), 'TCS.NS': chart([4000, 4000], 4040), 'M%26M.NS': chart([3000, 3000], 3030) };
  const fetchJson = async (url) => {
    const ticker = url.split('/chart/')[1].split('?')[0];
    asked.push(ticker);
    if (!answers[ticker]) throw new Error('HTTP 404');
    return answers[ticker];
  };
  const out = await S.createYahooAdapter({ map, fetchJson, concurrency: 2 }).getSectorQuotes();
  assert.deepEqual([...asked].sort(), ['%5ECNXIT', '%5ENSEI', 'INFY.NS', 'M%26M.NS', 'TCS.NS']);
  assert.equal(Math.round(out.nifty.pct * 1e6) / 1e6, 0.4);
  assert.equal(Math.round(out.sectors.IT.index.pct * 1e6) / 1e6, 1); // 408.04 / 404 - 1 = 1 %
  assert.deepEqual(out.sectors.IT.stocks, [{ symbol: 'TCS', price: 4040, prevClose: 4000 }]); // INFY failed: left out, not invented
  assert.deepEqual(out.sectors.Auto, { index: null, stocks: [{ symbol: 'M&M', price: 3030, prevClose: 3000 }] });
  // end to end on that answer: IT change +1 -> 75; vs Nifty +0.6 -> 70; breadth 1 of 1 known (2 expected, half is enough) = 100; trend 408.04 / 400 - 1 = 2.01 % -> 75.125
  // (2250 + 2100 + 2000 + 1502.5) / 100 = 78.525 -> 79
  const c = S.createSectorContext({ adapter: { getSectorQuotes: async () => out }, map });
  assert.deepEqual(await c.stockSectorView('TCS'), { sector: 'IT', score: 79, label: 'STRONG', vsNifty: 0.6 });
  assert.equal(await S.createYahooAdapter({ map, fetchJson: async () => { throw new Error('HTTP 403'); } }).getSectorQuotes(), null);
});

test('index file exposes the module', () => {
  assert.equal(require('../src/paper/context').sector, S);
});
