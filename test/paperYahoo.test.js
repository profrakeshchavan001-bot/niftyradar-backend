'use strict';
// Free Yahoo fallback for NSE candles (paperbot/yahoo.js). No network: a fake
// axios answers with the files in test/fixtures/yahoo (hand-built in Yahoo's
// answer shape, see the README there) and a fake clock drives the timing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createYahooSource, parseChart, loadUniverse, USER_AGENT } = require('../paperbot/yahoo');
const { createNseSource } = require('../paperbot/sources');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');
const { aggregate } = require('../paperbot/engine');

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'yahoo', name), 'utf8'));
const CHART_5M = fixture('chart-RELIANCE.NS-5m-5d.json');
const T0935 = 1794542700000; // Fri 13 Nov 2026 09:35:00 IST
const NOW = 1794542820000; // 09:37:00 IST, 5 s after the last trade in the fixture
const httpError = (status, headers = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });

// Fake clock + fake axios. `answer(symbolWithNS, params)` returns the body or throws.
function rig(answer, { start = NOW, universe = ['RELIANCE', 'TCS', 'INFY', 'M&M'], ...opt } = {}) {
  const clock = { t: start };
  const calls = [];
  const sleeps = [];
  const logs = [];
  const axios = { get: async (url, cfg) => {
    const ticker = decodeURIComponent(url.split('/chart/')[1]);
    calls.push({ url, ticker, at: clock.t, params: cfg.params, headers: cfg.headers });
    return { data: await answer(ticker, cfg.params, calls.length) };
  } };
  const sleep = async (ms) => { sleeps.push(ms); clock.t += ms; };
  const yahoo = createYahooSource({ axios, log: (m) => logs.push(m), now: () => clock.t, sleep, universe, ...opt });
  return { clock, calls, sleeps, logs, yahoo, axios };
}

test('parseChart: real rows only; the null row and the off-grid live row are dropped, nothing is filled in', () => {
  const { candles, meta } = parseChart(CHART_5M, '5m');
  // 9 rows in the file: 3 of the previous day + 4 good rows of today + 1 null row (09:25) + 1 live row (09:36:55)
  assert.equal(candles.length, 7);
  assert.deepEqual(candles[3], { t: 1794541500000, o: 1502, h: 1506, l: 1501, c: 1505, v: 200000 }); // 09:15 IST
  assert.deepEqual(candles.map((k) => k.t).slice(3), [1794541500000, 1794541800000, 1794542400000, 1794542700000]); // no 09:25 candle invented
  assert.ok(candles.every((k) => k.t % 300000 === 0));
  assert.deepEqual(meta, { price: 1512, marketTime: 1794542815000, dayVolume: 500000, exchangeDelayMin: 0 });
  const c15 = parseChart(fixture('chart-RELIANCE.NS-15m-5d.json'), '15m').candles;
  assert.deepEqual(c15.map((k) => k.c), [1500, 1507, 1512]);
  assert.throws(() => parseChart(fixture('chart-not-found.json')), /No data found, symbol may be delisted/);
  assert.throws(() => parseChart({ chart: { result: [{ meta: {} }] } }), /no candles/);
});

test('request: SYMBOL.NS, interval and range, polite User-Agent; only the listed universe (max 60) is ever asked', async () => {
  const r = rig(() => CHART_5M);
  const got = await r.yahoo.get('M&M');
  assert.equal(r.calls[0].url, 'https://query1.finance.yahoo.com/v8/finance/chart/M%26M.NS');
  assert.deepEqual(r.calls[0].params, { interval: '5m', range: '5d', includePrePost: false });
  assert.equal(r.calls[0].headers['User-Agent'], USER_AGENT);
  assert.match(USER_AGENT, /^niftyradar-paperbot\//);
  assert.equal(got.quoteLagSec, 5); // 09:37:00 - 09:36:55
  await r.yahoo.get('RELIANCE', '15m', '1d');
  assert.deepEqual(r.calls[1].params, { interval: '15m', range: '1d', includePrePost: false });
  await assert.rejects(r.yahoo.get('ZZZNOTLISTED'), /not in the Yahoo fallback universe/);
  await assert.rejects(r.yahoo.get('RELIANCE', '1m'), /not supported/);
  assert.equal(r.calls.length, 2);
  const list = loadUniverse();
  assert.equal(list.length, 60);
  assert.equal(new Set(list).size, 60);
  assert.equal(createYahooSource({ axios: {}, universe: Array.from({ length: 180 }, (_, i) => `S${i}`) }).universe.length, 60);
});

test('staggered about 1 per second, shared cache, one request per stock per 5-minute window', async () => {
  const r = rig(() => CHART_5M);
  const all = await r.yahoo.refreshAll();
  assert.deepEqual(all, { ok: 4, failed: [] });
  assert.deepEqual(r.calls.map((c) => c.at - NOW), [0, 1000, 2000, 3000]); // 1 s between request starts
  await r.yahoo.refreshAll();
  await Promise.all([r.yahoo.get('TCS'), r.yahoo.get('TCS'), r.yahoo.get('RELIANCE')]);
  assert.equal(r.calls.length, 4); // same window: everything from the cache
  r.clock.t = NOW + 300000; // next 5-minute window
  await Promise.all([r.yahoo.get('TCS'), r.yahoo.get('TCS')]);
  assert.equal(r.calls.length, 5); // two callers, one request
  assert.equal(r.yahoo.stats.requests, 5);
});

test('quote from the Yahoo answer: previous close = last candle of the previous day, no quote without real data', async () => {
  const r = rig((ticker) => { if (ticker === 'TCS.NS') throw httpError(404); return CHART_5M; });
  await r.yahoo.refreshAll();
  const q = r.yahoo.quote('RELIANCE');
  // price 1512, previous day's last close 1500 -> (1512 - 1500) / 1500 = +0.8 %; day volume from Yahoo's meta
  assert.deepEqual([q.price, q.prevClose, q.pct, q.volume, q.source, q.quoteLagSec], [1512, 1500, 0.8, 500000, 'yahoo', 5]);
  assert.equal(r.yahoo.quote('TCS'), null); // failed read: no quote
  assert.deepEqual(r.yahoo.quotes().map((x) => x.symbol), ['RELIANCE', 'INFY', 'M&M']);
  r.clock.t = NOW + 86400000; // a day later the old answer is not a quote any more
  assert.equal(r.yahoo.quote('RELIANCE'), null);
});

test('429 / 5xx: exponential backoff (2 s, 4 s, 8 s), Retry-After respected, then success', async () => {
  const r = rig((ticker, params, n) => {
    if (n === 1) throw httpError(429);
    if (n === 2) throw httpError(503);
    if (n === 3) throw httpError(429, { 'retry-after': '30' });
    return CHART_5M;
  });
  const got = await r.yahoo.get('RELIANCE');
  assert.equal(got.candles.length, 7);
  assert.equal(r.calls.length, 4);
  assert.deepEqual(r.sleeps, [2000, 4000, 30000]); // third wait: max(8 s, Retry-After 30 s)
  assert.equal(r.logs.filter((l) => /waiting .* before retry/.test(l)).length, 3);
});

test('still 429 after the retries: throws, cools down, asks nothing more in that window; 404 is not retried', async () => {
  const r = rig((ticker) => { throw httpError(ticker === 'INFY.NS' ? 404 : 429); });
  await assert.rejects(r.yahoo.get('RELIANCE'), /Yahoo 5m candles for RELIANCE failed: HTTP 429/);
  assert.equal(r.calls.length, 4); // 1 try + 3 retries
  assert.deepEqual(r.sleeps, [2000, 4000, 8000]);
  await assert.rejects(r.yahoo.get('TCS'), /rate-limiting \(HTTP 429\); no request until the cool-down ends/);
  await assert.rejects(r.yahoo.get('RELIANCE'), /HTTP 429/); // remembered for this window, not asked again
  assert.equal(r.calls.length, 4);
  r.clock.t = NOW + 600000; // cool-down over, new window
  await assert.rejects(r.yahoo.get('INFY'), /HTTP 404/);
  assert.equal(r.calls.length, 5); // one request, no retry on 404
  assert.equal(r.yahoo.quotes().length, 0); // never a made-up quote
});

// ---- wiring: createNseSource falls back to Yahoo when Dhan has nothing ----
function deadDhan(extra = {}) {
  const dhanCalls = [];
  return {
    dhanCalls,
    deps: {
      queueDhanCall: async () => { dhanCalls.push(1); throw httpError(401); }, // expired token
      DHAN_BASE: 'https://dhan.invalid', DHAN_HEADERS: {}, getSecurityId: () => 1,
      getMovers: () => ({ data: null, time: 0 }), getLotSize: () => 500, fetchNews: async () => [], ...extra,
    },
  };
}

test('source: Dhan candles fail -> Yahoo is used automatically, marked "yahoo_delayed", and Dhan is left alone for 15 minutes', async () => {
  const r = rig(() => CHART_5M);
  const d = deadDhan();
  const nse = createNseSource({ axios: r.axios, yahoo: r.yahoo, log: (m) => r.logs.push(m), now: () => r.clock.t, ...d.deps });
  assert.equal(nse.ranking(), null); // nothing read yet: no quotes, none invented
  const prep = await nse.prepare();
  assert.deepEqual([prep.source, prep.ok, prep.failed.length], ['yahoo', 4, 0]);
  assert.ok(r.logs.some((l) => /NSE data source: yahoo .*4 of 4 stocks read.*Observed delay of the Yahoo quote: \d+ s/.test(l)));
  assert.deepEqual(nse.ranking().map((q) => [q.symbol, q.pct, q.source])[0], ['RELIANCE', 0.8, 'yahoo']);
  const a = await nse.candles('RELIANCE');
  assert.deepEqual([a.source, a.dataSource, a.candles.length, a.exchangeDelayMin], ['yahoo_chart_5m', 'yahoo_delayed', 7, 0]);
  await nse.candles('TCS');
  assert.equal(d.dhanCalls.length, 1); // one failed Dhan read, then no more for 15 minutes
  assert.ok(r.logs.some((l) => /Dhan intraday candles not available \(401\); using the free Yahoo chart fallback/.test(l)));
  assert.equal(nse.spot('RELIANCE'), 1512);
  r.clock.t = 1794542815000 + 10 * 60000 + 1000; // last trade is now older than 2 candles
  assert.equal(nse.spot('RELIANCE'), null);
  assert.equal(nse.spot('RELIANCE', { maxDelaySec: 900 }), 1512); // the delayed feed is allowed 15 more minutes ...
  r.clock.t = 1794542815000 + 25 * 60000 + 1000;
  assert.equal(nse.spot('RELIANCE', { maxDelaySec: 900 }), null); // ... and not a second longer
  r.clock.t = NOW + 16 * 60000; // first failure was at NOW + 3 s (after the staggered refresh)
  await nse.candles('RELIANCE');
  assert.equal(d.dhanCalls.length, 2); // Dhan is tried again after 15 minutes, so it takes over by itself when the token is renewed
});

test('source: Dhan alive -> Dhan data, Yahoo is never asked', async () => {
  const r = rig(() => CHART_5M);
  const movers = { data: { all: [{ symbol: 'RELIANCE', price: 1510, pct: 0.5, volume: 1000 }] }, time: NOW };
  const d = deadDhan({
    getMovers: () => movers,
    queueDhanCall: async () => ({ data: { timestamp: [T0935 / 1000], open: [1], high: [2], low: [1], close: [2], volume: [5] } }),
  });
  const nse = createNseSource({ axios: r.axios, yahoo: r.yahoo, log: () => {}, now: () => r.clock.t, ...d.deps });
  assert.deepEqual(await nse.prepare(), { source: 'dhan' });
  const a = await nse.candles('RELIANCE');
  assert.deepEqual([a.source, a.dataSource], ['dhan_intraday_5m', 'dhan']);
  assert.equal(nse.ranking()[0].price, 1510);
  assert.equal(nse.spot('RELIANCE'), 1510);
  assert.equal(r.calls.length, 0);
});

// ---- the real bot on Yahoo-shaped candles (the replay fixture, served through the adapter) ----
const replay = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'paper_replay.json'), 'utf8'));
const MIN = 60000;
const FIVE = 5 * MIN;
const ist = (h, m, s = 0) => Date.UTC(2026, 10, 13, h - 5, m - 30, s);

// delayMs: how far behind the market the fake Yahoo answers (0 = live, 900000 = the 15 minutes Yahoo may be late for NSE).
function botOnYahoo({ feedStopsAt = Infinity, fail = false, delayMs = 0 } = {}) {
  const clock = { t: replay.nse.sessionStart };
  const logs = [];
  const store = createMemoryStore();
  const axios = { get: async (url, cfg) => {
    if (fail) throw httpError(500);
    const seen = Math.min(clock.t - delayMs, feedStopsAt);
    const five = replay.nse.candles.filter((k) => k.t <= seen); // includes the candle still forming, like the live answer
    const closed = five.filter((k) => k.t + FIVE <= seen);
    const rows = cfg?.params?.interval === '15m' ? aggregate(closed) : five; // 15m answer: real 15-minute candles of the same prices
    return { data: { chart: { error: null, result: [{
      meta: { symbol: 'TESTSTK.NS', regularMarketPrice: closed.at(-1).c, regularMarketTime: Math.floor(seen / 1000), regularMarketVolume: 1000000, exchangeDataDelayedBy: 0 },
      timestamp: rows.map((k) => k.t / 1000),
      indicators: { quote: [{ open: rows.map((k) => k.o), high: rows.map((k) => k.h), low: rows.map((k) => k.l), close: rows.map((k) => k.c), volume: rows.map((k) => k.v) }] },
    }] } } };
  } };
  const log = (m) => logs.push(m);
  const yahoo = createYahooSource({ axios, log, now: () => clock.t, sleep: async () => {}, universe: ['TESTSTK'] });
  const nse = createNseSource({ axios, yahoo, log, now: () => clock.t, ...deadDhan().deps });
  // Group 2 (2026-11): a real Dhan option price is now REQUIRED to take any NSE trade, even when the
  // STOCK candles themselves come from the free Yahoo fallback (Dhan quotes gone) - option pricing and
  // equity-candle pricing are two independent feeds. So this fake stands in for a live Dhan option-chain
  // answer (never null while the underlying has a closed candle), reusing the exact same delta-based
  // premium model paperbot/engine.js's simOptionPrice uses, so every hand-worked number below is
  // unchanged from before this fix - only simulated_option/price_source differ (false / real, not
  // flagged), because this fake is standing in for a REAL quote, not a simulated fallback.
  let optBase = null; // { entrySpot, entryPremium } - fixed the first time a quote is asked for
  nse.optionQuote = async (symbol, dir, fixed) => {
    const seen = Math.min(clock.t - delayMs, feedStopsAt);
    const closed = replay.nse.candles.filter((k) => k.t + FIVE <= seen);
    if (!closed.length) return null;
    const spot = closed.at(-1).c;
    if (!optBase) optBase = { entrySpot: spot, entryPremium: Math.round(spot * 2.5) / 100 };
    const ltp = Math.max(0.05, Math.round((optBase.entryPremium + 0.5 * (spot - optBase.entrySpot) * (dir === 'up' ? 1 : -1)) * 100) / 100);
    return { ltp, strike: fixed?.strike ?? 490, expiry: fixed?.expiry ?? '2026-11-20', spot };
  };
  const bot = createBot({ store, nse, crypto: null, now: () => clock.t, log });
  async function runSession() {
    for (let m = 0; m <= 375; m++) {
      const base = replay.nse.sessionStart + m * MIN;
      if (m % 5 === 0) { clock.t = base + 20000; await bot.nseScan(); }
      clock.t = base + 50000;
      await bot.nseMonitor();
    }
  }
  return { clock, logs, store, yahoo, bot, runSession };
}

test('bot on Yahoo candles: trade is marked data_source "yahoo_delayed" with the observed delay, R-factor ranking unchanged', async () => {
  const h = botOnYahoo();
  await h.runSession();
  const trades = h.store._db.trades;
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.deepEqual([t.symbol, t.direction, t.data_source, t.candle_source], ['TESTSTK', 'CALL', 'yahoo_delayed', 'yahoo_chart_5m']);
  // entry is on the SECOND confirming green candle (the owner's rule, docs/PAPER-BOT.md): scan runs
  // at 11:10:20; the latest closed candle ended at 11:10:00 -> 20 s
  assert.equal(t.entry_time, new Date(ist(11, 10, 20)).toISOString());
  assert.equal(t.data_delay_sec, 20);
  assert.equal(t.r_factor, 3); // same real R factor as on Dhan candles (test/paperReplay.test.js)
  assert.match(t.score_source, /^r_factor_v2/);
  assert.equal(t.simulated_option, false); // Group 2 (2026-11): real option price required, even when the stock candles come from Yahoo
  assert.equal(t.price_source, 'dhan_option_chain_ltp');
  assert.deepEqual([t.status, t.exit_reason], ['closed', 'time_exit_15:15']);
  assert.ok(h.logs.some((l) => /PAPER entry nse .*data_source yahoo_delayed, latest candle closed 20 s ago, quote lag 0 s, delay declared by the feed 0 min/.test(l)));
  // one 5m request per 5-minute window at most (75 windows), plus one 15m request in a window where the stock is analysed
  assert.ok(h.yahoo.stats.requests <= 152, `at most one request per interval per 5-minute window, got ${h.yahoo.stats.requests}`);
});

// Monday case: Dhan token expired, Yahoo answers 15 minutes late. The whole NSE flow must still work.
test('end to end on a 15-minute-late Yahoo feed: R factor, pattern, entry, SL / target, forced exit at 15:15', async () => {
  const h = botOnYahoo({ delayMs: 15 * MIN });
  await h.runSession();
  const trades = h.store._db.trades;
  assert.equal(trades.length, 1);
  const t = trades[0];
  // the signal candle (the SECOND confirming green candle) closed at 11:10; Yahoo shows it from
  // 11:25; the scan at 11:25:20 takes it: 920 s late
  assert.equal(t.entry_time, new Date(ist(11, 25, 20)).toISOString());
  assert.deepEqual([t.symbol, t.direction, t.data_source, t.data_delay_sec], ['TESTSTK', 'CALL', 'yahoo_delayed', 920]);
  assert.ok(t.patterns.includes('exhaustion_reversal'));
  assert.equal(t.r_factor, 3); // same R factor as on live candles
  assert.equal(t.news_filter, 'no headline about this stock today');
  // Group 2 (2026-11): real Dhan option price required even though the STOCK candles come from Yahoo -
  // the fake optionQuote above stands in for Dhan here. Premium = 2.5% of 492 = 12.3; 40,000 / (12.3 x 500) = 6 lots = 3000
  assert.deepEqual([t.simulated_option, t.entry_price, t.qty, t.entry_underlying], [false, 12.3, 3000, 492]);
  assert.equal(t.price_source, 'dhan_option_chain_ltp');
  // exit levels fixed at entry: stop 12.3 x 0.95 = 11.685, target 12.3 x 1.10 = 13.53
  assert.ok(Math.abs(t.sl_price - 11.685) <= 0.0051);
  assert.equal(t.target_price, 13.53);
  assert.match(t.basis, /Data: free Yahoo feed, about 15 min behind the market\./);
  // forced exit 15:15: Yahoo then shows the 15:00 candle, 46 candles after the signal (one fewer
  // than before - the reversal now takes 3 candles, not 2): stock 492 + 46 x 0.02 = 492.92,
  // option 12.3 + 0.5 x 0.92 = 12.76, P&L 0.46 x 3000 = 1380
  assert.deepEqual([t.status, t.exit_reason, t.exit_underlying, t.exit_price, t.pnl_inr], ['closed', 'time_exit_15:15', 492.92, 12.76, 1380]);
  assert.equal(t.exit_time, new Date(ist(15, 15, 50)).toISOString());
});

test('15-minute-late Yahoo feed: a skipped setup also stores data_source and data_delay_sec', async () => {
  const h = botOnYahoo({ delayMs: 15 * MIN });
  await h.store.setConfigIfMissing('nse', { max_trades_per_day: 0 });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  const s = h.store._db.skips.find((x) => /max 0 trades/.test(x.reason));
  assert.deepEqual([s.symbol, s.data_source, s.data_delay_sec], ['TESTSTK', 'yahoo_delayed', 920]);
});

test('Yahoo feed more than 15 minutes late (30 min): refused, no trade', async () => {
  const h = botOnYahoo({ delayMs: 30 * MIN });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
});

test('weekend: nothing is read from Yahoo and nothing is traded', async () => {
  const h = botOnYahoo();
  h.clock.t = replay.nse.sessionStart + 86400000 + 20000; // Saturday 14 Nov 2026 09:15:20 IST
  assert.deepEqual(await h.bot.nseScan(), { ran: false, reason: 'weekend' });
  assert.equal(h.yahoo.stats.requests, 0);
});

test('bot on Yahoo candles: feed stops (latest candle older than 2 candles + the allowed 15 minutes) -> no trade', async () => {
  const h = botOnYahoo({ feedStopsAt: ist(10, 40) }); // Yahoo keeps answering, but with nothing newer than 10:40
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  assert.ok(h.logs.some((l) => /NSE rank: 0 ranked, 0 below the liquidity floor, 1 without valid candles/.test(l)));
});

test('bot when Yahoo fails too: nothing is traded, the failure is logged, no data is made up', async () => {
  const h = botOnYahoo({ fail: true });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  assert.ok(h.logs.some((l) => /NSE data source: yahoo .*0 of 1 stocks read, 1 failed and are skipped \(Yahoo 5m candles for TESTSTK failed: HTTP 500\)/.test(l)));
  assert.ok(h.logs.some((l) => /NSE scan: no fresh live quotes, nothing done/.test(l)));
});
