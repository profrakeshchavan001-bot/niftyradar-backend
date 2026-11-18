'use strict';
// Crypto exits from price levels (paperbot/cryptoLevels.js) and their use in the bot.
// Expected numbers are worked out by hand in the comments (see also test/fixtures/cryptoScenario.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../paperbot/cryptoLevels');
const E = require('../paperbot/engine');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');
const { renderReport, chartData } = require('../paperbot/reportPage');
const { DEFAULTS } = require('../paperbot/config');
const S = require('./fixtures/cryptoScenario');

const k = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });

test('previous day and previous week high / low (UTC, week = Monday to Sunday)', () => {
  const H = 3600000;
  const now = Date.UTC(2026, 10, 13, 10, 0); // Friday 13 Nov 2026
  const candles = [
    k(Date.UTC(2026, 10, 3, 12, 0), 80, 95, 70, 90), // Tue of the previous week (Mon 2 Nov - Sun 8 Nov)
    k(Date.UTC(2026, 10, 8, 23, 0), 90, 93, 75, 91), // Sun of the previous week
    k(Date.UTC(2026, 10, 9, 0, 0), 91, 130, 60, 100), // Monday of THIS week: not part of the previous week
    k(Date.UTC(2026, 10, 12, 0, 0), 100, 110, 98, 105), // Thu = previous day
    k(Date.UTC(2026, 10, 12, 23, 0), 105, 112, 101, 108),
    k(Date.UTC(2026, 10, 13, 0, 0), 108, 150, 50, 109), // today: ignored
  ];
  assert.deepEqual(L.previousPeriods(candles, now), [
    { price: 112, type: 'previous day high' }, { price: 98, type: 'previous day low' },
    { price: 95, type: 'previous week high' }, { price: 70, type: 'previous week low' },
  ]);
  assert.deepEqual(L.previousPeriods([k(now - H, 1, 2, 1, 2)], now), []); // no candle of those periods: no level made up
});

test('order block and fair value gap levels', () => {
  // five candles with body 1, a red one (zone 99.8-101.2), then an up candle with body 4 (>= 2 x 1): the red candle's high is support
  const ob = [k(0, 100, 101.2, 99.8, 101), k(1, 101, 101.2, 99.8, 100), k(2, 100, 101.2, 99.8, 101), k(3, 101, 101.2, 99.8, 100), k(4, 100, 101.2, 99.8, 101),
    k(5, 101, 101.2, 99.8, 100), k(6, 100, 104.2, 100, 104)];
  assert.deepEqual(L.orderBlockLevels(ob), [{ price: 101.2, type: 'order block', side: 'support' }]);
  // candle 1 high 101, candle 3 low 103: gap 101-103 left by an up move; support edge = its top 103
  const gap = [k(0, 100, 101, 99.8, 100.5), k(1, 100.5, 101, 100.3, 100.9), k(2, 101, 103.6, 100.9, 103.5), k(3, 103.5, 104.5, 103, 104.2), k(4, 104.2, 105, 103.5, 104.8)];
  assert.deepEqual(L.fvgLevels(gap), [{ price: 103, type: 'FVG edge', side: 'support' }]);
  gap.push(k(5, 104.8, 104.9, 100.5, 101)); // a later candle trades back through the whole gap: it no longer counts
  assert.deepEqual(L.fvgLevels(gap), []);
});

function scenario(opt) {
  const candles = S.build(opt);
  const now = S.scanTime(candles);
  const c5 = E.closedOnly(candles, S.FIVE, now).slice(0, S.TRIGGER_INDEX + 1);
  return { candles, now, c5, c15: E.aggregate(c5), c1h: E.aggregate(c5, S.FIVE, 12 * S.FIVE), patterns: [{ name: 'exhaustion_reversal', candles: c5.slice(-2) }] };
}

test('plan: target just before the nearest support, stop beyond the pattern high + 1 x ATR, reward/risk', () => {
  const s = scenario();
  const r = L.planTrade({ entry: 102.18, direction: 'down', patterns: s.patterns, c5: s.c5, c15: s.c15, c1h: s.c1h, nowMs: s.now });
  assert.equal(r.ok, true);
  // ATR14 (15-min) = (12 x 0.4 + 2 x 1.8) / 14 = 0.6; stop = 102.52 + 0.6 = 103.12
  // target = 99 x 1.001 = 99.099; reward 3.081 / risk 0.94 = 3.28
  assert.deepEqual(r.plan, { target: 99.099, targetLevel: 99, targetType: 'swing low 15m', stop: 103.12, stopBase: 102.52, stopType: 'pattern high + 1 x ATR', atr15: 0.6, rr: 3.28,
    riskPct: 0.9199, rewardPct: 3.0153 }); // 0.94 / 102.18 and 3.081 / 102.18, in %
});

test('plan: skipped when reward/risk is under the minimum, when there is no level, or when ATR cannot be worked out', () => {
  const s = scenario();
  const base = { entry: 102.18, direction: 'down', patterns: s.patterns, c5: s.c5, c15: s.c15, c1h: s.c1h, nowMs: s.now };
  const low = L.planTrade({ ...base, opt: { minRr: 5 } });
  assert.equal(low.ok, false);
  assert.equal(low.reason, 'reward/risk 3.28 is below 5 (target 99.099 before swing low 15m 99, stop 103.12)');
  const none = scenario({ dip: null });
  assert.deepEqual(L.planTrade({ ...base, c5: none.c5, c15: none.c15, c1h: none.c1h }), { ok: false, reason: 'no support level found below the entry, so no target' });
  assert.match(L.planTrade({ ...base, c15: s.c15.slice(-14) }).reason, /not enough 15-min candles for ATR14/);
});

test('plan: the nearest level wins, and a 1-hour swing / previous-day level is named', () => {
  const s = scenario();
  // real 1-hour candles with a swing low at 100.9 (nearer than 99) and a previous day whose low was 101.5 (nearer still)
  const H = 3600000;
  const day = Date.UTC(2026, 10, 12, 0, 0);
  const c1h = [k(day, 103, 104, 101.5, 103), k(day + H, 103, 104, 102, 103), k(S.START, 103, 104, 102, 103), k(S.START + H, 103, 104, 102, 103), k(S.START + 2 * H, 103, 104, 100.9, 103),
    k(S.START + 3 * H, 103, 104, 102, 103), k(S.START + 4 * H, 103, 104, 102, 103)];
  const r = L.planTrade({ entry: 102.18, direction: 'down', patterns: s.patterns, c5: s.c5, c15: s.c15, c1h, nowMs: s.now, opt: { minRr: 0 } });
  // short: nearest support below 102.18 is the previous day low 101.5 -> exit 101.5 x 1.001 = 101.6015
  assert.deepEqual([r.plan.targetType, r.plan.targetLevel, r.plan.target], ['previous day low', 101.5, 101.6015]);
  // without that day, the 1-hour swing low 100.9 is next: 100.9 x 1.001 = 101.0009
  const r2 = L.planTrade({ entry: 102.18, direction: 'down', patterns: s.patterns, c5: s.c5, c15: s.c15, c1h: c1h.slice(2), nowMs: s.now, opt: { minRr: 0 } });
  assert.deepEqual([r2.plan.targetType, r2.plan.targetLevel, r2.plan.target], ['swing low 1h', 100.9, 101.0009]);
});

test('plan: a level closer than minLevelDistAtr x ATR14 to the entry is skipped for the next one out (CC2 item 4)', () => {
  const s = scenario();
  const H = 3600000;
  const day = Date.UTC(2026, 10, 12, 0, 0);
  const c1h = [k(day, 103, 104, 101.5, 103), k(day + H, 103, 104, 102, 103), k(S.START, 103, 104, 102, 103), k(S.START + H, 103, 104, 102, 103), k(S.START + 2 * H, 103, 104, 100.9, 103),
    k(S.START + 3 * H, 103, 104, 102, 103), k(S.START + 4 * H, 103, 104, 102, 103)];
  // ATR14(15m) = 0.6 (same scenario as the "nearest level wins" test above). Nearest support is the
  // previous day low 101.5, distance 0.68 - within 2 x ATR (1.2), so with minLevelDistAtr: 2 it is
  // skipped and the 1-hour swing low 100.9 (distance 1.28, outside 1.2) is used instead.
  const r = L.planTrade({ entry: 102.18, direction: 'down', patterns: s.patterns, c5: s.c5, c15: s.c15, c1h, nowMs: s.now, opt: { minRr: 0, minLevelDistAtr: 2 } });
  assert.deepEqual([r.ok, r.plan.targetType, r.plan.targetLevel], [true, 'swing low 1h', 100.9]);
  // the default (minLevelDistAtr: 1) is far enough below 0.68's actual distance that the previous day low still wins
  const r2 = L.planTrade({ entry: 102.18, direction: 'down', patterns: s.patterns, c5: s.c5, c15: s.c15, c1h, nowMs: s.now, opt: { minRr: 0 } });
  assert.deepEqual([r2.ok, r2.plan.targetType, r2.plan.targetLevel], [true, 'previous day low', 101.5]);
});

test('plan: every level within minLevelDistAtr x ATR14 of the entry -> no target, named reason', () => {
  const s = scenario();
  const r = L.planTrade({ entry: 102.18, direction: 'down', patterns: s.patterns, c5: s.c5, c15: s.c15, c1h: s.c1h, nowMs: s.now, opt: { minLevelDistAtr: 10 } });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'every support level found is within 10 x ATR14 (0.6) of the entry, no room for a target');
});

test('manage: target, stop, breakeven at half way, then breakeven stop', () => {
  const short = { entry: 102.18, target: 99.099, stop: 103.12, short: true };
  // half way = 102.18 - 0.5 x 3.081 = 100.6395
  assert.deepEqual(L.manageTrade({ ...short, price: 101 }), { action: 'hold' });
  assert.deepEqual(L.manageTrade({ ...short, price: 100.6 }), { action: 'breakeven', stop: 102.18 });
  assert.deepEqual(L.manageTrade({ ...short, price: 100.7 }), { action: 'hold' });
  assert.deepEqual(L.manageTrade({ ...short, price: 99.09 }), { action: 'exit', reason: 'target' });
  assert.deepEqual(L.manageTrade({ ...short, price: 103.12 }), { action: 'exit', reason: 'stop' });
  assert.deepEqual(L.manageTrade({ ...short, stop: 102.18, breakevenDone: true, price: 102.2 }), { action: 'exit', reason: 'breakeven_stop' });
  assert.deepEqual(L.manageTrade({ ...short, stop: 102.18, breakevenDone: true, price: 100.6 }), { action: 'hold' }); // moved once only
  const long = { entry: 100, target: 104, stop: 98, short: false };
  assert.deepEqual(L.manageTrade({ ...long, price: 102 }), { action: 'breakeven', stop: 100 });
  assert.deepEqual(L.manageTrade({ ...long, price: 104 }), { action: 'exit', reason: 'target' });
  assert.deepEqual(L.manageTrade({ ...long, price: 97.9 }), { action: 'exit', reason: 'stop' });
});

test('old fixed rule, for comparison only: +2% / -1% from the entry', () => {
  // short at 102.18: target 102.18 x 0.98 = 100.1364, stop 102.18 x 1.01 = 103.2018
  assert.deepEqual(L.legacyLevels({ entry: 102.18, short: true, targetPct: 2, stopPct: 1 }), { target: 100.1364, stop: 103.2018 });
  assert.deepEqual(L.legacyLevels({ entry: 100, short: false, targetPct: 2, stopPct: 1 }), { target: 102, stop: 99 });
  const lv = { target: 100.1364, stop: 103.2018, short: true };
  assert.equal(L.legacyOutcome({ ...lv, price: 101 }), null);
  assert.equal(L.legacyOutcome({ ...lv, price: 100.1 }), 'target');
  assert.equal(L.legacyOutcome({ ...lv, price: 103.21 }), 'stop');
});

// ---- the real bot on the scenario ----
// CC2 round 2 item 1: h.at(spec) now appends a real CLOSED 5-minute candle - a flat "doji"
// (o=h=l=c) when `spec` is a plain number, or the exact [o,h,l,c] given - and runs cryptoMonitor,
// which checks the stop/target against that candle's high AND low (src/paper/lib/exitSim.js), not
// a bare tick. h.wait(ms) advances the clock with no new candle, for the legacy rule's own
// time-based giveup check, which does not depend on candles at all.
function rig({ dip, after, config } = {}) {
  const candles = S.build({ dip, after });
  const clock = { t: S.scanTime(candles) };
  const store = createMemoryStore();
  const logs = [];
  const state = { price: 102.18 };
  const crypto = {
    candles: async (s) => (s === 'BTCUSDT' ? candles.filter((c) => c.t <= clock.t) : []),
    price: async () => state.price,
    usdtInr: async () => ({ rate: 88, source: 'test' }),
  };
  const bot = createBot({ store, nse: null, crypto, now: () => clock.t, log: (m) => logs.push(m) });
  const ready = config ? store.setConfigIfMissing('crypto', config) : Promise.resolve();
  const at = async (spec, jumpMs = S.FIVE + 25000) => {
    const [o, h, l, c] = Array.isArray(spec) ? spec : [spec, spec, spec, spec];
    candles.push({ t: clock.t, o, h, l, c, v: 100 });
    state.price = c;
    clock.t += jumpMs;
    await bot.cryptoMonitor();
    return store._db.trades[0];
  };
  const wait = async (jumpMs) => { clock.t += jumpMs; await bot.cryptoMonitor(); return store._db.trades[0]; };
  return { candles, clock, store, logs, bot, ready, at, wait };
}

test('bot: SHORT with level-based target and stop, breakeven, candle-accurate target exit; old rule tracked beside it', async () => {
  const h = rig({ after: [[102.18, 102.3, 101.5, 101.6]] });
  await h.bot.cryptoScan();
  assert.equal(h.store._db.trades.length, 1);
  let t = h.store._db.trades[0];
  assert.deepEqual([t.symbol, t.direction, t.entry_price, t.sl_price, t.target_price, t.stop_active, t.rr], ['BTCUSDT', 'SHORT', 102.18, 103.12, 99.099, 103.12, 3.28]);
  assert.equal(t.target_type, 'swing low 15m at 99');
  assert.equal(t.stop_type, 'pattern high + 1 x ATR (102.52 + 0.6)');
  assert.deepEqual([t.legacy_target, t.legacy_stop, t.legacy_result], [100.1364, 103.2018, null]);
  assert.match(t.basis, /Target 99\.099: 0\.1% before the swing low 15m at 99\. Stop 103\.12: pattern high \+ 1 x ATR \(102\.52 \+ 0\.6\)\. Reward\/risk 3\.28\. Stop moves to the entry after 50% of the way to the target\./);
  // size: risk 0.9199% -> 1000 x 2% / 0.9199% = 2174 USDT, capped at one third of the balance = 333.33 USDT
  assert.ok(Math.abs(t.qty * 102.18 - 333.3333) < 0.001);

  t = await h.at(101); // doji low 101: not half way yet (half way = entry - 0.5 x 3.081 = 100.6395)
  assert.deepEqual([t.status, t.stop_active, t.breakeven_time ?? null], ['open', 103.12, null]);
  t = await h.at(100.6); // doji low 100.6: 102.18 - 100.6 = 1.58 >= 1.5405 -> half way covered, stop moves to the entry
  assert.deepEqual([t.status, t.stop_active], ['open', 102.18]);
  assert.equal(t.breakeven_time, new Date(h.clock.t).toISOString());
  assert.equal(t.sl_price, 103.12); // the level set at entry stays on record
  t = await h.at(100.1); // old rule's target 100.1364 is reached: only noted, the trade stays open
  assert.deepEqual([t.status, t.legacy_result], ['open', 'target']);

  // every scan: best / worst % from EVERY candle since entry (the "after" candle 101.5-102.3 plus the
  // three doji candles above). Highest high overall is still 102.3 (the "after" candle):
  // worst = -(102.3 - 102.18) / 102.18 = -0.12%. Lowest low overall is now 100.1 (the last doji):
  // best = (102.18 - 100.1) / 102.18 = 2.04% - the same value the per-tick tracking above already
  // recorded, so the stored max does not move either way.
  await h.bot.cryptoScan();
  t = h.store._db.trades[0];
  assert.deepEqual([t.max_fav_pct, t.max_adv_pct], [2.04, -0.12]);
  assert.equal(h.store._db.trades.length, 1); // still one open trade per coin

  // A doji at 99 (no wick): its low (99) is already past the target (99.099), but the exit books AT
  // THE TARGET LEVEL, not the tick that reached it - the whole point of CC2 round 2 item 1.
  t = await h.at(99);
  assert.deepEqual([t.status, t.exit_reason, t.exit_price], ['closed', 'target', 99.099]);
  // gross P&L booked at the level, not the overshoot: (102.18 - 99.099) x 333.3333 / 102.18 = 10.050890
  // USDT (gross_pnl_inr 884.48). Group 3a (2026-11): intraday now pays scalp_wide's fee + slippage model
  // too - entryVal/exitVal x qty, cost = 0.1% x (entryVal+exitVal) + 0.03% x entryVal = 0.756616 USDT;
  // net = 10.050890 - 0.756616 = 9.294274 USDT x 88 = Rs 817.90
  assert.equal(t.pnl_inr, 817.9);
  assert.equal(t.legacy_result, 'target');
});

test('bot: stop exit booked at the stop level (not the overshoot tick), and the old rule decided later', async () => {
  const h = rig();
  await h.bot.cryptoScan();
  // A doji at 103.2: above the level-based stop (103.12) but still under the old rule's stop (103.2018).
  let t = await h.at(103.2);
  assert.deepEqual([t.status, t.exit_reason, t.exit_price, t.legacy_result], ['closed', 'stop', 103.12, null]);
  // gross loss booked at the stop level: (103.12 - 102.18) x 333.3333 / 102.18 = 3.066484 USDT
  // (gross_pnl_inr -269.85). Group 3a: cost = 0.1% x (entryVal+exitVal) + 0.03% x entryVal = 0.769733
  // USDT; net = -3.066484 - 0.769733 = -3.836217 USDT x 88 = Rs -337.59
  assert.equal(t.pnl_inr, -337.59);
  t = await h.at(103.3); // the closed trade is still followed for the comparison
  assert.equal(t.legacy_result, 'stop');
  const before = JSON.stringify(h.store._db.trades);
  await h.at(90); // decided once: nothing changes any more
  assert.equal(JSON.stringify(h.store._db.trades), before);
});

test('bot: breakeven stop booked exactly at the entry (zero P&L), and an undecided old rule gives up after 48 hours', async () => {
  const h = rig();
  await h.bot.cryptoScan();
  await h.at(100.6); // breakeven; old target 100.1364 not reached
  // A doji at 102.2 (back above the entry): its high crosses the NEW stop (the entry, 102.18) and is
  // booked exactly there, so the GROSS P&L is exactly zero - which is what "breakeven" means. Group 3a
  // (2026-11): intraday now pays scalp_wide's fee + slippage model too, so a breakeven exit still costs
  // something: entryVal = exitVal = 102.18 x 3.2622... = 333.3333; cost = 0.1% x (333.3333+333.3333) +
  // 0.03% x 333.3333 = 0.666667 + 0.1 = 0.766667 USDT; net = 0 - 0.766667 = -0.766667 USDT x 88 = Rs -67.47
  let t = await h.at(102.2);
  assert.deepEqual([t.status, t.exit_reason, t.exit_price, t.pnl_inr, t.legacy_result], ['closed', 'breakeven_stop', 102.18, -67.47, null]);
  t = await h.wait(48 * 3600000);
  assert.equal(t.legacy_result, 'undecided after 48 h');
});

test('bot: reward/risk under 1.5 or no level -> no trade, reason stored in paper_skips', async () => {
  const strict = rig({ config: { levels: { minRr: 5 } } });
  await strict.ready;
  await strict.bot.cryptoScan();
  assert.equal(strict.store._db.trades.length, 0);
  const s = strict.store._db.skips.find((x) => x.symbol === 'BTCUSDT');
  assert.equal(s.reason, 'reward/risk 3.28 is below 5 (target 99.099 before swing low 15m 99, stop 103.12)');
  assert.deepEqual([s.market, s.data_source, s.patterns.includes('exhaustion_reversal')], ['crypto', 'binance_public', true]);
  const bare = rig({ dip: null });
  await bare.bot.cryptoScan();
  assert.equal(bare.store._db.trades.length, 0);
  assert.ok(bare.store._db.skips.some((x) => x.reason === 'no support level found below the entry, so no target'));
});

test('bot: a trade opened under the old fixed rule (no levels stored) still exits on that rule', async () => {
  const h = rig();
  const id = await h.store.insertTrade({ market: 'crypto', symbol: 'BTCUSDT', direction: 'LONG', trade_date: '2026-11-13', entry_price: 100, qty: 1, entry_time: new Date(h.clock.t).toISOString(), patterns: [], basis: 'old' });
  let t = await h.at(101.5);
  assert.equal(t.status, 'open');
  t = await h.at(102); // +2%
  // gross 2 USDT x 88 = Rs 176. Group 3a: entryVal = 100, exitVal = 102; cost = 0.1% x 202 + 0.03% x 100
  // = 0.202 + 0.03 = 0.232 USDT; net = 2 - 0.232 = 1.768 USDT x 88 = Rs 155.58
  assert.deepEqual([t.id, t.status, t.exit_reason, t.pnl_inr], [id, 'closed', 'target', 155.58]);
});

test('report: target and stop levels with their type on the page and on the chart', async () => {
  const h = rig();
  await h.bot.cryptoScan();
  await h.at(100.6);
  const t = h.store._db.trades[0];
  const html = renderReport({ date: '2026-11-13', generatedAt: new Date(h.clock.t).toISOString(), storage: 'memory', minTrades: 20, today: { nse: [], crypto: [t] }, open: [t], closed: [], trades: [t], skips: [], cfg: DEFAULTS });
  assert.match(html, /<td>BTCUSDT<\/td><td>SHORT<\/td><td>102\.18<\/td><td>103\.12<\/td><td>99\.099<\/td>/);
  const view = JSON.parse(html.match(/<script id="paper-data" type="application\/json">([\s\S]*?)<\/script>/)[1]).trades[0];
  assert.match(view.dataLine, /target: before swing low 15m at 99 · stop: pattern high \+ 1 x ATR \(102\.52 \+ 0\.6\) · reward\/risk 3\.28 · stop moved to entry \(breakeven\)/);
  assert.match(view.dataLine, /old fixed rule \(target 100\.1364, stop 103\.2018\) would have ended: not decided yet/);
  assert.match(view.basis, /Target 99\.099: 0\.1% before the swing low 15m at 99/);
  assert.match(html, /Crypto exits come from price levels/);
  const d = await chartData({ store: h.store, nse: null, crypto: { candles: async () => h.candles }, id: t.id, now: () => h.clock.t });
  assert.deepEqual(d.lines.map((l) => [l.kind, l.price, l.label]), [
    ['entry', 102.18, 'Entry = stop now (breakeven)'],
    ['sl', 103.12, 'SL: pattern high + 1 x ATR'],
    ['target', 99.099, 'Target: swing low 15m'],
  ]);
  assert.match(d.note, /Target 99\.099 sits just before the swing low 15m at 99\. Stop 103\.12: pattern high \+ 1 x ATR \(102\.52 \+ 0\.6\)\. Stop was moved to the entry at/);
});
