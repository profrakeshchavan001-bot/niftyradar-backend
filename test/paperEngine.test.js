'use strict';
// Paper bot: ranking, entry/exit rules, sizing, stats. Hand-verified values.
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../paperbot/engine');
const R = require('../paperbot/report');
const { newsCheck, createCandleAggregator } = require('../paperbot/sources');
const { istParts, nseSession, istDayStart } = require('../paperbot/time');
const { merge, DEFAULTS } = require('../paperbot/config');

test('crypto momentum score', () => {
  const c = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100, v: 100 }));
  c.push({ t: 20, o: 100, h: 103, l: 99, c: 102, v: 300 });
  // volume 300/100 = 3; range 4/2 = 2; EMA20 = 100 + 2 x 2/21 = 100.19; ATR14 = (13 x 2 + 4)/14 = 2.142857
  // trend = 1.809524 / 2.142857 = 0.8444; score = 0.4 x 3 + 0.3 x 2 + 0.3 x 0.8444 = 2.0533
  assert.deepEqual(E.momentumScore(c), { score: 2.05, volumeSpike: 3, rangeExpansion: 2, trendStrength: 0.84 });
  assert.equal(E.momentumScore(c.slice(0, 20)), null);
});

test('closedOnly drops the candle still forming; aggregate builds 15-min candles', () => {
  const five = 300000;
  const c = [0, 1, 2, 3, 4].map((i) => ({ t: i * five, o: 10 + i, h: 12 + i, l: 9 + i, c: 11 + i, v: 10 }));
  assert.equal(E.closedOnly(c, five, 4 * five + 1000).length, 4);
  // first 15 min: open 10, high 14, low 9, close 13, volume 30; the second bucket has only 2 candles so it is left out
  assert.deepEqual(E.aggregate(c), [{ t: 0, o: 10, h: 14, l: 9, c: 13, v: 30 }]);
});

test('entry rule: trend + VWAP must agree, reversal exempt, mixed directions blocked', () => {
  const p = (name, direction, kind) => ({ name, direction, kind, candles: [], note: '' });
  const upCtx = { trend15: 'up', vwapSide: 'up' };
  assert.equal(E.decideEntry([], upCtx).enter, false);
  assert.equal(E.decideEntry([p('hammer', 'up', 'classic')], upCtx).direction, 'up');
  assert.equal(E.decideEntry([p('hammer', 'up', 'classic')], { trend15: 'down', vwapSide: 'up' }).enter, false);
  assert.equal(E.decideEntry([p('hammer', 'up', 'classic')], { trend15: 'up', vwapSide: 'down' }).enter, false);
  assert.equal(E.decideEntry([p('hammer', 'up', 'classic')], { trend15: 'unknown', vwapSide: 'up' }).enter, false);
  // exhaustion reversal may go against the trend
  const rev = E.decideEntry([p('exhaustion_reversal', 'up', 'reversal')], { trend15: 'down', vwapSide: 'down' });
  assert.equal(rev.enter, true);
  // a with-trend down pattern and an up reversal together: no trade
  const mixed = E.decideEntry([p('exhaustion_reversal', 'up', 'reversal'), p('bearish_engulfing', 'down', 'classic')], { trend15: 'down', vwapSide: 'down' });
  assert.equal(mixed.enter, false);
  assert.match(mixed.reason, /disagree/);
  // an against-trend classic pattern is dropped, the reversal still trades alone
  assert.deepEqual(E.decideEntry([p('exhaustion_reversal', 'up', 'reversal'), p('shooting_star', 'down', 'classic')], { trend15: 'up', vwapSide: 'up' }).patterns.map((x) => x.name), ['exhaustion_reversal']);
});

test('NSE sizing: 2% risk, 5% stop, whole lots, free cash cap', () => {
  // risk Rs 2,000; position = 2000 / 0.05 = Rs 40,000; one lot = 50 x 250 = 12,500 -> 3 lots = 750 qty = 37,500; risk at stop 1,875
  assert.deepEqual(E.sizeNse({ capital: 100000, riskPct: 2, stopPct: 5, freeCash: 100000, premium: 50, lot: 250 }), { lots: 3, qty: 750, value: 37500, riskInr: 1875 });
  assert.equal(E.sizeNse({ capital: 100000, riskPct: 2, stopPct: 5, freeCash: 20000, premium: 50, lot: 250 }).lots, 1);
  assert.equal(E.sizeNse({ capital: 100000, riskPct: 2, stopPct: 5, freeCash: 100000, premium: 200, lot: 250 }), null); // one lot = 50,000 > 40,000
  assert.equal(E.sizeNse({ capital: 100000, riskPct: 2, stopPct: 5, freeCash: 100000, premium: 0, lot: 250 }), null);
});

test('crypto sizing: equal share per coin, no leverage', () => {
  // 1000 x 2% / 1% = 2000, share 1000/3 = 333.33, free 1000 -> 333.33 USDT; at price 100 -> 3.3333 units
  const s = E.sizeCrypto({ capital: 1000, riskPct: 2, stopPct: 1, freeCash: 1000, price: 100, coins: 3 });
  assert.equal(s.value, 333.33);
  assert.ok(Math.abs(s.qty - 3.33333) < 1e-4);
  assert.equal(E.sizeCrypto({ capital: 1000, riskPct: 2, stopPct: 1, freeCash: 0, price: 100, coins: 3 }), null);
});

test('simulated option price: delta 0.5 of the stock move, in the trade direction', () => {
  // stock +10 -> call 30 + 5 = 35, put 30 - 5 = 25
  assert.equal(E.simOptionPrice({ entryPremium: 30, entrySpot: 1200, spot: 1210, direction: 'up', delta: 0.5 }), 35);
  assert.equal(E.simOptionPrice({ entryPremium: 30, entrySpot: 1200, spot: 1210, direction: 'down', delta: 0.5 }), 25);
  assert.equal(E.simOptionPrice({ entryPremium: 2, entrySpot: 1200, spot: 1100, direction: 'up', delta: 0.5 }), 0.05); // floor
});

test('exit rule: target +10%, stop -5%, forced time exit', () => {
  const base = { entry: 100, targetPct: 10, stopPct: 5 };
  assert.equal(E.evaluateExit({ ...base, current: 110 }).reason, 'target');
  assert.equal(E.evaluateExit({ ...base, current: 95 }).reason, 'stop');
  assert.equal(E.evaluateExit({ ...base, current: 104 }).exit, false);
  assert.equal(E.evaluateExit({ ...base, current: 104, forceReason: 'time_exit_15:15' }).reason, 'time_exit_15:15');
  // short: price down 2% = +2% for the trade
  assert.equal(E.evaluateExit({ entry: 100, current: 98, targetPct: 2, stopPct: 1, short: true }).reason, 'target');
  assert.equal(E.evaluateExit({ entry: 100, current: 101, targetPct: 2, stopPct: 1, short: true }).reason, 'stop');
});

test('IST clock and NSE session', () => {
  const t = Date.UTC(2026, 10, 13, 3, 45); // Fri 13 Nov 2026 09:15 IST
  assert.deepEqual(istParts(t), { date: '2026-11-13', hhmm: '09:15', minutes: 555, dow: 5 });
  assert.equal(istDayStart(t), Date.UTC(2026, 10, 12, 18, 30));
  assert.equal(nseSession(t, []).open, true);
  assert.equal(nseSession(t - 60000, []).open, false); // 09:14
  assert.equal(nseSession(Date.UTC(2026, 10, 13, 10, 1), []).open, false); // 15:31
  assert.equal(nseSession(t + 86400000, []).reason, 'weekend');
  assert.equal(nseSession(t, ['2026-11-13']).reason, 'NSE holiday');
});

test('news filter: blocks a stock named in a headline today, says so when the feed is down', () => {
  const now = Date.UTC(2026, 10, 13, 5, 0);
  const items = [
    { title: 'Infosys Q2 results: profit rises 5%', pubDate: 'Fri, 13 Nov 2026 09:00:00 +0530' },
    { title: 'SBI Life announces dividend', pubDate: 'Fri, 13 Nov 2026 09:30:00 +0530' },
    { title: 'TCS wins a large deal', pubDate: 'Thu, 12 Nov 2026 09:00:00 +0530' },
  ];
  assert.equal(newsCheck('INFY', items, now).status, 'blocked');
  assert.equal(newsCheck('SBILIFE', items, now).status, 'blocked');
  assert.equal(newsCheck('TCS', items, now).status, 'clear'); // yesterday's headline
  assert.equal(newsCheck('ITC', items, now).status, 'clear');
  assert.equal(newsCheck('ITC', null, now).status, 'unavailable');
});

test('candle builder from live prices: real samples only', () => {
  const agg = createCandleAggregator();
  const five = 300000;
  agg.record([{ symbol: 'X', price: 100, volume: 1000 }], 10);
  agg.record([{ symbol: 'X', price: 103, volume: 1400 }], 60000);
  agg.record([{ symbol: 'X', price: 99, volume: 1500 }], 120000);
  agg.record([{ symbol: 'X', price: 101, volume: 1900 }], five + 5);
  // first candle: open 100, high 103, low 99, close 99, volume 1500 - 1000 = 500
  assert.deepEqual(agg.candles('X'), [{ t: 0, o: 100, h: 103, l: 99, c: 99, v: 500 }, { t: five, o: 101, h: 101, l: 101, c: 101, v: 400 }]);
  assert.deepEqual(agg.candles('NOPE'), []);
});

test('per-pattern stats and the "too few trades" rule', () => {
  const closed = [
    { patterns: ['hammer'], pnl_inr: 1000 }, { patterns: ['hammer'], pnl_inr: -400 }, { patterns: ['hammer', 'fvg_retest'], pnl_inr: 600 },
    { patterns: ['fvg_retest'], pnl_inr: -200 },
  ];
  // hammer: 3 trades, 2 wins = 66.7%, avg (1000 - 400 + 600)/3 = 400; fvg: 2 trades, 1 win = 50%, avg (600 - 200)/2 = 200
  assert.deepEqual(R.patternStats(closed, 3), [
    { pattern: 'hammer', trades: 3, wins: 2, winRatePct: 66.7, avgPnlInr: 400, totalPnlInr: 1200, enough: true },
    { pattern: 'fvg_retest', trades: 2, wins: 1, winRatePct: 50, avgPnlInr: 200, totalPnlInr: 400, enough: false },
  ]);
});

test('weekly suggestions: under 20 trades = no conclusion, and nothing is applied', () => {
  const few = Array.from({ length: 19 }, () => ({ market: 'nse', patterns: ['hammer'], pnl_inr: -100, exit_reason: 'stop' }));
  const w = R.weeklySuggestions({ date: '2026-11-15', closed: few, skips: [{ reason: 'news filter: news today: "X"' }], minTrades: 20, config: DEFAULTS });
  assert.match(w.text, /hammer: 19 trades\. Too few trades, no conclusion\./);
  assert.match(w.text, /Nothing below is applied/);
  assert.deepEqual(w.data.drop, []);
  const many = [...few, { market: 'nse', patterns: ['hammer'], pnl_inr: -100, exit_reason: 'stop' }];
  const w2 = R.weeklySuggestions({ date: '2026-11-15', closed: many, skips: [], minTrades: 20, config: DEFAULTS });
  assert.deepEqual(w2.data.drop, ['hammer']);
  assert.match(w2.text, /consider dropping/);
});

test('config: table values override defaults, defaults fill the gaps', () => {
  const cfg = merge(DEFAULTS, { nse: { target_pct: 12 } });
  assert.equal(cfg.nse.target_pct, 12);
  assert.equal(cfg.nse.stop_pct, 5);
  assert.equal(cfg.nse.max_trades_per_day, 5);
  assert.equal(cfg.crypto.target_pct, 2);
});
