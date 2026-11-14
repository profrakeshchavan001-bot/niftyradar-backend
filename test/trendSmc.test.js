'use strict';
// trend_smc (docs/BOTS.md): 5m entry, 15m/1h trend, trade only with the trend; EMA9/21(5m) fresh cross OR a BOS/CHoCH-style retest
// of an order block/FVG, only in discount (longs)/premium (shorts); target beyond 1xATR, stop beyond the order block + 1xATR14(15m),
// reward/risk >= 1.5 after costs, breakeven at 50%. Numbers are worked out by hand below (plain arithmetic, not copied from decide()'s
// own output - the fixture itself was checked against the real collectLevels()/orderBlock()/emaCrossState() only to confirm there is
// exactly one candidate level and the pattern fires as expected, same as every other bot's tests this session).
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, evaluateExit, settle, costPct } = require('../src/paper/bots/trend_smc/engine');
const { TREND_SMC_DEFAULTS } = require('../src/paper/bots/trend_smc/config');
const { createTrendSmcBot, MARKET } = require('../src/paper/bots/trend_smc/bot');
const { createMemoryTrendSmcStore } = require('../src/paper/bots/trend_smc/store');
const { createMemoryShadowStore } = require('../src/paper/shadow/store');
const { findPluginDirs } = require('../src/paper/pluginLoader');

const FIVE = 300000; const FIFTEEN = 900000;

// 21 quiet padding candles (o=140,h=150,l=130,c=140 - establishes a wide recent range so the real move below reads as a DISCOUNT),
// then the exact order-block-retest fixture from test/paperPatterns.test.js ("order block: retest..."): entry (last close) 104.5,
// direction up. 21 + 9 = 30 = the default min_candles_5m, so no cfg override is needed for candle-count.
function candles5() {
  const pad = Array.from({ length: 21 }, (_, i) => ({ t: i * FIVE, o: 140, h: 150, l: 130, c: 140, v: 100 }));
  const rows = [
    [100, 101.2, 99.8, 101], [101, 101.2, 99.8, 100], [100, 101.2, 99.8, 101], [101, 101.2, 99.8, 100], [100, 101.2, 99.8, 101],
    [101, 101.2, 99.8, 100], [100, 104.2, 100, 104], [104, 105.2, 103.8, 105], [101.5, 102.6, 101, 102.5],
  ];
  return [...pad, ...rows.map(([o, h, l, c], i) => ({ t: (21 + i) * FIVE, o, h, l, c, v: 100 }))];
}

// 40 candles ramping 90 -> 99.75 (so EMA20/50 clearly reads 'up' - checked directly, not asserted by value), with one candle's HIGH
// (only the high; EMA uses closes, so this does not touch the trend calc) raised to 130 - the only swing high in range, confirmed
// against the real swingLevels/collectLevels before writing this fixture. Then 20 FLAT candles (TR = 1.0 every time, no gap) so
// ATR14(15m) - which only reads the LAST 14 - is exactly 1.0, unaffected by the spike (which sits 16 candles before that window).
function candles15() {
  const ramp = Array.from({ length: 40 }, (_, i) => { const px = 90 + i * 0.25; const h = i === 30 ? 130 : px + 0.2; return { t: i * FIFTEEN, o: px - 0.1, h, l: px - 0.2, c: px + 0.1, v: 50 }; });
  const flat = Array.from({ length: 20 }, (_, i) => ({ t: (40 + i) * FIFTEEN, o: 100, h: 100.5, l: 99.5, c: 100, v: 50 }));
  return [...ramp, ...flat];
}

function scene(cfgOver = {}) {
  const c5 = candles5(); const c15raw = candles15();
  const last = c5[c5.length - 1];
  const nowMs = last.t + FIVE + 5000;
  // c15 is built on its own relative clock (0, 15m, 30m, ...); shift it so its last candle has just closed by `nowMs`, the same
  // instant the bot is scanning at - otherwise closedOnly() (bot.js) would see every 15-minute candle as still in the future.
  const shift = nowMs - FIFTEEN - c15raw[c15raw.length - 1].t;
  const c15 = c15raw.map((k) => ({ ...k, t: k.t + shift }));
  return { c5, c15, nowMs, cfg: { ...TREND_SMC_DEFAULTS, ...cfgOver } };
}

test('plugin: auto-discovered under bots/trend_smc', () => {
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'trend_smc'));
});

// entry is the LAST candle's close (the retest candle itself) = 102.5, not the impulse candle's 104.
// stop: pattern low 99.8 (the order block's own candles) - 1 x ATR14(15m) 1.0 = 98.8; risk = 102.5 - 98.8 = 3.7; riskPct = 3.7/102.5 x 100 = 3.6098%
// target: the only level above entry is the 130 swing high, 0.1% held back -> 130 x 0.999 = 129.87; reward = 27.37; rewardPct = 27.37/102.5 x 100 = 26.7024%
// costs = 2 x 0.1 + 0.03 = 0.23%; rewardNet = 26.7024-0.23 = 26.4724; riskNet = 3.6098+0.23 = 3.8398; rr = 26.4724/3.8398 = 6.8943 -> 6.89 (>= 1.5, trades)
test('decide: order-block retest WITH the 15-min uptrend, in a discount zone, gives a LONG with stop 98.8, target 129.87, rr 6.89', () => {
  const s = scene();
  const d = decide(s.c5, { c15: s.c15, c1h: [], nowMs: s.nowMs, cfg: s.cfg });
  assert.equal(d.take, true, d.reason);
  assert.equal(d.direction, 'up'); assert.equal(d.entry, 102.5); assert.equal(d.pattern, 'order_block');
  assert.equal(d.stop, 98.8); assert.equal(d.target, 129.87); assert.equal(d.rr, 6.89);
  assert.equal(d.trend15, 'up'); assert.equal(d.zone, 'discount');
  assert.match(d.basis, /^trend_smc LONG:/); assert.match(d.basis, /Breakeven at 50%/);
});

test('decide: min_rr is the lever; raising it above 6.89 skips the SAME setup and carries a full shadowPlan', () => {
  const s = scene({ min_rr: 10 });
  const d = decide(s.c5, { c15: s.c15, c1h: [], nowMs: s.nowMs, cfg: s.cfg });
  assert.equal(d.take, false);
  assert.match(d.reason, /^reward\/risk 6\.89 after costs is below 10 \(target 26\.7024%, stop 3\.6098%, costs 0\.23% round trip\)$/);
  assert.deepEqual(d.extra.shadowPlan, { direction: 'LONG', entry_price: 102.5, sl_price: 98.8, target_price: 129.87, trigger_t: s.c5[s.c5.length - 1].t });
});

test('decide: against the trend is refused even if the pattern itself fires (trend15 down, pattern wants up)', () => {
  const s = scene();
  const flippedTrend = s.c15.map((k) => ({ ...k, o: 200 - k.o, h: 200 - k.l, l: 200 - k.h, c: 200 - k.c })); // mirrors the ramp downward
  const d = decide(s.c5, { c15: flippedTrend, c1h: [], nowMs: s.nowMs, cfg: s.cfg });
  assert.equal(d.take, false); assert.match(d.reason, /no setup|disagree/);
});

test('decide: too few 5-min or 15-min candles are refused in plain words', () => {
  const s = scene();
  assert.match(decide(s.c5.slice(-10), { c15: s.c15, c1h: [], nowMs: s.nowMs, cfg: s.cfg }).reason, /not enough 5-min candles yet \(need 30\)/);
  assert.match(decide(s.c5, { c15: s.c15.slice(-5), c1h: [], nowMs: s.nowMs, cfg: s.cfg }).reason, /not enough 15-min candles yet \(need 21\)/);
});

// ---------- exits: breakeven persists across checks, same shape as scalp_wide ----------
test('exit: breakeven at 50% moves the stop to entry; the SAME trade then exits at breakeven on a later dip', () => {
  const trade = { direction: 'LONG', entry_price: 100, sl_price: 95, target_price: 110, trigger_t: 0, be_moved: false };
  const cd = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });
  const r1 = evaluateExit({ trade, candles: [cd(FIVE, 100, 105.5, 99, 105)] }); // half way to target (105) reached
  assert.equal(r1.exit, false); assert.equal(r1.action, 'breakeven');
  const after = { ...trade, sl_price: 100, be_moved: true };
  const r2 = evaluateExit({ trade: after, candles: [cd(FIVE, 105, 105.5, 99.5, 100)] });
  assert.deepEqual([r2.exit, r2.reason, r2.price], [true, 'breakeven', 100]);
});

// ---------- the bot ----------
function harness(cfgOver = {}) {
  const s = scene(cfgOver);
  const store = createMemoryTrendSmcStore();
  const shadowStore = createMemoryShadowStore();
  const logs = [];
  const clock = { t: s.nowMs };
  const crypto = { candles: async () => s.c5, hourly: async () => [], usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const crypto15 = { candles15: async () => s.c15 };
  const bot = createTrendSmcBot({ store, crypto, crypto15, loadCfg: async () => s.cfg, shadowStore, now: () => clock.t, log: (m) => logs.push(m) });
  return { s, store, shadowStore, logs, clock, bot };
}

test('bot: opens one trade per coin under its own market, with trend15/zone/breakeven-ready stored; a second scan opens nothing', async () => {
  const h = harness();
  const r = await h.bot.scan();
  assert.deepEqual(r.entered, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const rows = h.store._db.trades;
  assert.equal(rows.length, 3); assert.ok(rows.every((t) => t.status === 'open' && t.direction === 'LONG' && t.sl_price === 98.8 && t.target_price === 129.87 && t.trend15 === 'up' && t.zone === 'discount' && t.be_moved === false));
  assert.equal((await h.bot.scan()).entered.length, 0);
});

test('bot: a skipped (above min_rr) setup is shadow-tracked, never a trade; the monitor can resolve it', async () => {
  const h = harness({ min_rr: 10 });
  await h.bot.scan();
  assert.equal(h.store._db.trades.length, 0);
  assert.equal(h.shadowStore._db.rows.length, 3);
  assert.ok(h.shadowStore._db.rows.every((r) => r.bot === 'trend_smc' && r.status === 'open'));
});

test(`market key: own market "${MARKET}"`, () => { assert.equal(MARKET, 'crypto_trend_smc'); });

test('settle: fees on both sides + slippage come off, same cost model as every other crypto bot', () => {
  const s = settle({ trade: { direction: 'LONG', entry_price: 100, qty: 10 }, exitPrice: 100.5, cfg: TREND_SMC_DEFAULTS, fxRate: 88 });
  assert.deepEqual(s, { gross_pnl_usdt: 5, cost_usdt: 2.305, net_pnl_usdt: 2.695, gross_pnl_inr: 440, pnl_inr: 237.16 }); // same worked numbers as src/paper/scalp/engine.js's own costs test
});

test('costPct: 0.1% fee per side + 0.03% slippage = 0.23% round trip', () => {
  assert.equal(Math.round(costPct(TREND_SMC_DEFAULTS) * 1000) / 1000, 0.23);
});
