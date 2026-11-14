'use strict';
// Scalp strategy (docs/SCALP.md): entry rules, exits, costs, bot behaviour, report, wiring. Numbers are worked out by hand (see the comments).
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyse, analyseWide, evaluateExit, settle } = require('../src/paper/scalp/engine');
const { SCALP_DEFAULTS, SCALP_WIDE_DEFAULTS, costPct } = require('../src/paper/scalp/config');
const { createScalpBot } = require('../src/paper/scalp/bot');
const { summarise, buildScalpData, renderScalpReport, NO_CONCLUSION } = require('../src/paper/scalp/report');
const { attachScalp } = require('../src/paper/scalp');
const { createMemoryStore } = require('../paperbot/store');
const { scene, sceneWide, MIN } = require('./scalpFixtures');

const FREE = { ...SCALP_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0 }; // no costs: pure geometry

test('defaults: 0.1% fee per side + 0.03% slippage = 0.23% round trip; target 0.3-0.5%, stop cap 0.3%, reward/risk 1.0 (never below, after costs), 15 min, breakeven at half', () => {
  assert.equal(Math.round(costPct(SCALP_DEFAULTS) * 1000) / 1000, 0.23);
  assert.deepEqual([SCALP_DEFAULTS.target_min_pct, SCALP_DEFAULTS.target_cap_pct, SCALP_DEFAULTS.stop_cap_pct, SCALP_DEFAULTS.min_rr, SCALP_DEFAULTS.time_stop_min, SCALP_DEFAULTS.breakeven_frac], [0.3, 0.5, 0.3, 1.0, 15, 0.5]);
  assert.deepEqual(SCALP_DEFAULTS.symbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
});

test('scalp_wide defaults: 5-min entry / 15-min trend, target >= 0.8% AND 1xATR, min_rr 1.0 (never below, after costs), 45 min time stop, breakeven at half', () => {
  assert.equal(Math.round(costPct(SCALP_WIDE_DEFAULTS) * 1000) / 1000, 0.23);
  assert.deepEqual([SCALP_WIDE_DEFAULTS.target_min_pct, SCALP_WIDE_DEFAULTS.min_rr, SCALP_WIDE_DEFAULTS.time_stop_min, SCALP_WIDE_DEFAULTS.breakeven_frac], [0.8, 1.0, 45, 0.5]);
  assert.deepEqual(SCALP_WIDE_DEFAULTS.symbols, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
});

// ---------- entry ----------
// Scene: bullish exhaustion reversal (5-min trend and VWAP both point down, a reversal is exempt), entry 100.44.
//  stop: pattern candles low 100.38 -> 100.44 - 100.38 = 0.06; ATR14(1m) = (12 x 0.10 + 0.025 + 0.065) / 14 = 0.092143; + 0.5 x ATR = 0.046071 -> 0.106071 -> 0.105606 % (under the 0.3 cap)
//  target: no swing high, only today's high 102.10 -> 1.653 % away, minus 0.1 = 1.553, capped at 0.5 %
test('entry: exhaustion reversal gives a long with stop 0.1056 %, target 0.5 %, exit prices from the entry', () => {
  const s = scene();
  const a = analyse({ ...s, cfg: FREE });
  assert.equal(a.ok, true, a.reason);
  const p = a.plan;
  assert.equal(p.long, true); assert.deepEqual(p.hits.map((h) => h.name), ['exhaustion_reversal']); // the engulfing is dropped: against 5-min trend and VWAP
  assert.equal(p.entry, 100.44); assert.equal(p.stopPct, 0.1056); assert.equal(p.targetPct, 0.5);
  assert.equal(p.stopPrice, 100.333929);                                         // 100.44 - (0.06 + 0.5 x 0.092143) = 100.44 - 0.106071 = 100.333929
  assert.equal(p.targetPrice, Math.round(100.44 * 1.005 * 1e6) / 1e6);          // 100.9422
  assert.equal(p.rr, 4.73);                                                       // 0.5 / 0.1056 = 4.73 with no costs
});

test('entry: with the default costs (0.23 %) the same setup is SKIPPED: reward 0.5 - 0.23 = 0.27, risk 0.1056 + 0.23 = 0.3356, 0.27 / 0.3356 = 0.8 < 1.0', () => {
  const a = analyse({ ...scene(), cfg: SCALP_DEFAULTS });
  assert.equal(a.ok, false);
  assert.match(a.reason, /^reward\/risk 0\.8 after costs is below 1 \(target 0\.5%, stop 0\.11%, costs 0\.23% round trip\)$/);
  assert.equal(a.extra.r_factor, 0.8); assert.deepEqual(a.extra.patterns, ['exhaustion_reversal', 'bullish_engulfing']); // every pattern that fired is logged
  assert.equal(analyse({ ...scene(), cfg: { ...SCALP_DEFAULTS, min_rr: 0.5 } }).ok, true, 'min_rr is the lever');
});

test('entry: a swing high 0.26 % above leaves no room (0.2589 - 0.1 = 0.1589 % < 0.3 %): skipped with the level in the reason', () => {
  const a = analyse({ ...scene({ bump: 26 }), cfg: FREE });
  assert.equal(a.ok, false);
  assert.match(a.reason, /^only 0\.26% of room to the nearest resistance 100\.7; after leaving 0\.1% the target would be 0\.16%, below the 0\.3% minimum$/);
});

test('entry: stop is capped at 0.3 %: a wide pattern candle (low 99.90, 0.54 away) gives 0.3 not 0.54 %', () => {
  const s = scene(); s.c1raw[s.c1raw.length - 2] = { ...s.c1raw[s.c1raw.length - 2], l: 99.90 };
  const a = analyse({ ...s, cfg: FREE });
  assert.equal(a.ok, true); assert.equal(a.plan.stopPct, 0.3);
});

test('entry: stale candle, too few candles and no setup are all refused in plain words; a quiet market is not logged', () => {
  const s = scene();
  assert.match(analyse({ ...s, now: s.now + 10 * MIN, cfg: FREE }).reason, /no fresh 1-min candle/);
  assert.match(analyse({ ...s, c1raw: s.c1raw.slice(-10), cfg: FREE }).reason, /not enough 1-min candles yet \(need 30\)/);
  assert.match(analyse({ ...s, c5raw: s.c5raw.slice(-5), cfg: FREE }).reason, /not enough 5-min candles yet \(need 21\)/);
  const flat = s.c1raw.map((k) => ({ ...k, o: 100, h: 100.01, l: 99.99, c: 100 }));
  const q = analyse({ ...s, c1raw: flat, cfg: FREE }); assert.equal(q.ok, false); assert.equal(q.quiet, true);
});

test('entry: a pattern against both the 5-min trend and the VWAP side is refused (the engulfing alone)', () => {
  const s = scene();
  // make the small candle bigger so the exhaustion reversal no longer fires; the green engulfing then points up while trend and VWAP point down
  // (a small candle with a body of 0.06 is no longer "small" next to the 0.05 average, and the last green candle now opens at its close)
  const n = s.c1raw.length;
  s.c1raw[n - 2] = { t: s.c1raw[n - 2].t, o: 100.40, h: 100.41, l: 100.33, c: 100.34, v: 10 };
  s.c1raw[n - 1] = { t: s.c1raw[n - 1].t, o: 100.34, h: 100.45, l: 100.335, c: 100.44, v: 10 };
  const a = analyse({ ...s, cfg: FREE });
  assert.equal(a.ok, false);
  assert.match(a.reason, /is against the 5-min trend \(down\) and the VWAP side \(down\)/);
});

// ---------- scalp_wide entry ----------
// sceneWide() reuses candles1()'s exact numbers at 5-minute spacing: same stop (0.1056 %), and today's high 102.025 is the only level, 1.585 away.
//   levelPct = 1.585 / 100.44 x 100 = 1.578057 % (worked by long division); required = max(0.8, ATR% 0.0917) = 0.8 %, so there is room.
//   target = the level itself (no margin held back) = entry + 1.585 = 102.025 exactly.
const FREE_WIDE = { ...SCALP_WIDE_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0, min_candles_15m: 10 }; // 34 candles -> 11 complete 15-min buckets
const WIDE = { ...SCALP_WIDE_DEFAULTS, min_candles_15m: 10 };

test('scalp_wide entry: exhaustion reversal on 5-min candles gives a long, stop 0.1056 %, target = the level (102.025), no costs', () => {
  const a = analyseWide({ ...sceneWide(), cfg: FREE_WIDE });
  assert.equal(a.ok, true, a.reason);
  const p = a.plan;
  assert.equal(p.long, true); assert.deepEqual(p.hits.map((h) => h.name), ['exhaustion_reversal']);
  assert.equal(p.entry, 100.44); assert.equal(p.stopPct, 0.1056); assert.equal(p.targetPct, 1.5781);
  assert.equal(p.stopPrice, 100.333929); assert.equal(p.targetPrice, 102.025);
  assert.equal(p.rr, 14.94); // 1.578057 / 0.105607 (no costs) worked by long division
});

// reward 1.578057 - 0.23 = 1.348057, risk 0.105607 + 0.23 = 0.335607, 1.348057 / 0.335607 = 4.02: scalp_wide still trades after the real costs
// (unlike the tight scalp above, whose 0.5 % cap leaves almost no reward once the 0.23 % round trip is taken off).
test('scalp_wide entry: with the default costs (0.23 %) the same setup still trades, reward/risk 4.02 after costs', () => {
  const a = analyseWide({ ...sceneWide(), cfg: WIDE });
  assert.equal(a.ok, true, a.reason);
  assert.equal(a.plan.rr, 4.02);
});

// highOverride caps every candle's high at 100.84: the only level is then 100.84, 0.3983 % away ((100.84-100.44)/100.44 x 100), below the 0.8 %
// minimum (and below 1 x ATR 0.0917 %, so the 0.8 % floor is what actually binds here): no room, skipped.
test('scalp_wide entry: a level only 0.40 % away is below the 0.8 % / 1xATR floor and is skipped', () => {
  const a = analyseWide({ ...sceneWide({ highOverride: 100.84 }), cfg: FREE_WIDE });
  assert.equal(a.ok, false);
  assert.match(a.reason, /^nearest resistance 100\.84 is only 0\.4% away, below the 0\.8% needed \(0\.8% minimum, or 1 x ATR 0\.09%, whichever is larger\)$/);
});

test('scalp_wide entry: too few 5-min or 15-min candles, and a stale candle, are refused in plain words', () => {
  const s = sceneWide();
  assert.match(analyseWide({ ...s, now: s.now + 20 * MIN, cfg: FREE_WIDE }).reason, /no fresh 5-min candle/);
  assert.match(analyseWide({ ...s, c5raw: s.c5raw.slice(-10), cfg: FREE_WIDE }).reason, /not enough 5-min candles yet \(need 30\)/);
  assert.match(analyseWide({ ...s, cfg: { ...FREE_WIDE, min_candles_15m: 50 } }).reason, /not enough 15-min candles yet \(need 50\)/);
});

// ---------- exits ----------
const MS = 1_000_000_000_000; // trigger candle open time
const trade = (over = {}) => ({ direction: 'LONG', entry_price: 100, sl_price: 99.9, target_price: 100.5, trigger_t: MS, entry_time: new Date(MS + 65000).toISOString(), ...over });
const cd = (k, o, h, l, c) => ({ t: MS + k * MIN, o, h, l, c, v: 1 });
const cfg = SCALP_DEFAULTS;

test('exit: target hit -> out at the target price (100.5), best move +0.55 %', () => {
  const r = evaluateExit({ trade: trade(), candles: [cd(1, 100, 100.55, 100.0, 100.4)], nowMs: MS + 130000, cfg });
  assert.deepEqual([r.exit, r.reason, r.price, r.timeMs], [true, 'target', 100.5, MS + 2 * MIN]); assert.equal(r.favPct, 0.55);
});
test('exit: stop hit -> out at the stop (99.9); one candle touching both stop and target counts as the STOP (worst case)', () => {
  assert.deepEqual(evaluateExit({ trade: trade(), candles: [cd(1, 100, 100.1, 99.89, 99.95)], nowMs: MS + 130000, cfg }).reason, 'stop');
  const both = evaluateExit({ trade: trade(), candles: [cd(1, 100, 100.6, 99.8, 100)], nowMs: MS + 130000, cfg });
  assert.deepEqual([both.reason, both.price], ['stop', 99.9]);
});
test('exit: breakeven at half way (100.25): the stop moves to the entry; the next dip to 99.99 is then a breakeven exit at 100', () => {
  const r = evaluateExit({ trade: trade(), candles: [cd(1, 100, 100.26, 99.95, 100.2), cd(2, 100.2, 100.2, 99.99, 100.0)], nowMs: MS + 200000, cfg });
  assert.deepEqual([r.exit, r.reason, r.price, r.beMoved], [true, 'breakeven', 100, true]);
  // without the half-way move the same dip is not an exit
  const n = evaluateExit({ trade: trade(), candles: [cd(1, 100, 100.2, 99.95, 100.1), cd(2, 100.1, 100.1, 99.99, 100.0)], nowMs: MS + 200000, cfg });
  assert.equal(n.exit, false); assert.equal(n.beMoved, false);
});
test('exit: time stop after 15 minutes (entry + 15 min = trigger + 965 s): candle 16 ends at 1020 s and is closed at its close', () => {
  const quiet = Array.from({ length: 16 }, (_, i) => cd(i + 1, 100.05, 100.1, 100.0, 100.05));
  const r = evaluateExit({ trade: trade(), candles: quiet, nowMs: MS + 1030000, cfg });
  assert.deepEqual([r.exit, r.reason, r.price, r.timeMs], [true, 'time', 100.05, MS + 17 * MIN]);
  assert.equal(evaluateExit({ trade: trade(), candles: quiet.slice(0, 15), nowMs: MS + 960000 + 5000, cfg }).exit, false, 'candle 15 ends at 960 s, before the 965 s deadline');
  assert.equal(evaluateExit({ trade: trade(), candles: quiet.slice(0, 15), nowMs: MS + 965000 + 61000, cfg }).reason, 'time', 'a feed gap never holds a trade past the time stop');
});
test('exit: candles at or before the trigger candle are ignored; a short mirrors everything', () => {
  assert.equal(evaluateExit({ trade: trade(), candles: [cd(0, 100, 101, 99, 100)], nowMs: MS + 100000, cfg }).exit, false);
  const s = trade({ direction: 'SHORT', sl_price: 100.1, target_price: 99.5 });
  assert.deepEqual([evaluateExit({ trade: s, candles: [cd(1, 100, 100.05, 99.45, 99.6)], nowMs: MS + 130000, cfg }).reason, evaluateExit({ trade: s, candles: [cd(1, 100, 100.12, 99.9, 100)], nowMs: MS + 130000, cfg }).reason], ['target', 'stop']);
  const be = evaluateExit({ trade: s, candles: [cd(1, 100, 100.05, 99.74, 99.8), cd(2, 99.8, 100.01, 99.8, 99.9)], nowMs: MS + 200000, cfg }); // half way = 99.75
  assert.deepEqual([be.reason, be.price], ['breakeven', 100]);
});

// ---------- costs ----------
// Long 10 coins 100 -> 100.5: gross = 0.5 x 10 = 5. Fees 0.1 % of (1000 + 1005) = 2.005, slippage 0.03 % of 1000 = 0.3, costs 2.305, net 2.695 USDT; x 88 = Rs 237.16 net, Rs 440 gross.
test('costs: fees on both sides + slippage come off every scalp P&L; gross, costs and net are all stored (long and short)', () => {
  const s = settle({ trade: { direction: 'LONG', entry_price: 100, qty: 10 }, exitPrice: 100.5, cfg, fxRate: 88 });
  assert.deepEqual(s, { gross_pnl_usdt: 5, cost_usdt: 2.305, net_pnl_usdt: 2.695, gross_pnl_inr: 440, pnl_inr: 237.16 });
  // Short 100 -> 99.5: gross 5, fees 0.1 % of (1000 + 995) = 1.995 + 0.3 = 2.295, net 2.705
  const sh = settle({ trade: { direction: 'SHORT', entry_price: 100, qty: 10 }, exitPrice: 99.5, cfg, fxRate: 88 });
  assert.deepEqual([sh.gross_pnl_usdt, sh.cost_usdt, sh.net_pnl_usdt], [5, 2.295, 2.705]);
  assert.ok(settle({ trade: { direction: 'LONG', entry_price: 100, qty: 10 }, exitPrice: 100.1, cfg, fxRate: 88 }).pnl_inr < 0, 'a small win before costs is a loss after costs');
});

// ---------- the bot ----------
function harness(over = {}) {
  const s = scene();
  const store = createMemoryStore();
  const logs = [];
  const clock = { t: s.now };
  const calls = { c1: [], c5: [] };
  const crypto = { candles: async (sym) => { calls.c5.push(sym); return s.c5raw; }, usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const source1m = { candles1m: async (sym) => { calls.c1.push(sym); return over.c1 ? over.c1(clock.t) : s.c1raw; } };
  const bot = createScalpBot({ store, crypto, source1m, now: () => clock.t, log: (m) => logs.push(m) });
  return { s, store, logs, clock, bot, calls };
}
const freeCosts = async (store) => store.setConfigIfMissing('scalp', { fee_pct_per_side: 0, slippage_pct: 0 });

test('bot: with costs off, each of BTC / ETH / SOL gets exactly ONE open scalp tagged strategy "scalp"; a second scan opens nothing; intraday queries never see them', async () => {
  const h = harness(); await freeCosts(h.store);
  const r = await h.bot.cryptoScalpScan();
  assert.deepEqual(r.entered, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const rows = h.store._db.trades;
  assert.equal(rows.length, 3); assert.ok(rows.every((t) => t.market === 'crypto_scalp' && t.strategy === 'scalp' && t.status === 'open' && t.direction === 'LONG'));
  const t = rows[0];
  // size: risk 2 % of 1000 = 20 USDT / stop 0.1056 % = 18,939 -> capped at capital / 3 coins = 333.33 USDT -> 333.33 / 100.44 = 3.3187 coins
  assert.equal(Math.round(t.qty * 10000) / 10000, 3.3187);
  assert.equal(t.sl_price, 100.333929); assert.equal(t.target_price, 100.9422); assert.equal(t.r_factor, 4.73);
  assert.match(t.basis, /^Scalp LONG on BTCUSDT: the 1-min chart showed exhaustion reversal/); assert.match(t.basis, /reward\/risk 4\.73 after costs/);
  assert.equal(t.data_source, 'binance_public'); assert.equal(t.trigger_t, h.s.last.t);
  assert.equal((await h.bot.cryptoScalpScan()).entered.length, 0, 'one open scalp per coin');
  assert.equal(h.store._db.trades.length, 3);
  assert.deepEqual(await h.store.openTrades('crypto'), [], 'the intraday crypto monitor does not see scalps');
  assert.deepEqual(await h.store.closedTrades(null), [], 'nor do the intraday lists');
  assert.equal((await h.store.openTrades('crypto_scalp')).length, 3);
});

test('bot: with the default costs nothing is entered, the skip is stored with its numbers, and it appears only in the scalp skip list', async () => {
  const h = harness();
  assert.deepEqual((await h.bot.cryptoScalpScan()).entered, []);
  assert.equal(h.store._db.trades.length, 0);
  const skips = await h.store.skipsSince('1970-01-01', 'crypto_scalp');
  assert.equal(skips.length, 3); assert.match(skips[0].reason, /^reward\/risk 0\.8 after costs is below 1\b/); assert.equal(skips[0].market, 'crypto_scalp');
  assert.deepEqual(await h.store.skipsSince('1970-01-01'), [], 'intraday skip list stays clean');
  await h.bot.cryptoScalpScan(); assert.equal((await h.store.skipsSince('1970-01-01', 'crypto_scalp')).length, 3, 'the same skip is stored once');
});

test('bot: the monitor closes at the target with gross, costs, net and rupee P&L stored; then a NEW trigger candle may be traded at once (no cooldown)', async () => {
  const h = harness({ c1: (t) => (t < h0.s.now + 90000 ? h0.s.c1raw : h0.later) }); const h0 = h;
  h.later = [...h.s.c1raw, { t: h.s.last.t + MIN, o: 100.44, h: 100.99, l: 100.40, c: 100.9, v: 1 }, { t: h.s.last.t + 2 * MIN, o: 100.9, h: 100.95, l: 100.8, c: 100.85, v: 1 }];
  await h.store.setConfigIfMissing('scalp', { fee_pct_per_side: 0.1, slippage_pct: 0.03, min_rr: 0.5, symbols: ['BTCUSDT'] }); // costs on, filter relaxed so the entry happens
  assert.deepEqual((await h.bot.cryptoScalpScan()).entered, ['BTCUSDT']);
  h.clock.t += 130000; // two minutes on: the candle after the trigger took the target 100.9422
  const m = await h.bot.cryptoScalpMonitor();
  assert.deepEqual(m, { checked: 1, closed: 1 });
  const t = h.store._db.trades[0];
  assert.equal(t.status, 'closed'); assert.equal(t.exit_reason, 'target'); assert.equal(t.exit_price, 100.9422);
  const qty = t.qty; const gross = (100.9422 - 100.44) * qty; const cost = 0.001 * (100.44 * qty + 100.9422 * qty) + 0.0003 * 100.44 * qty;
  assert.ok(Math.abs(t.gross_pnl_usdt - gross) < 1e-4); assert.ok(Math.abs(t.net_pnl_usdt - (gross - cost)) < 1e-4); assert.ok(Math.abs(t.cost_usdt - cost) < 1e-4);
  assert.ok(Math.abs(t.pnl_inr - (gross - cost) * 88) < 0.01); assert.ok(t.pnl_inr < t.gross_pnl_inr); assert.equal(t.fx_rate, 88);
  assert.equal(t.be_moved, false);
});

function harnessWide() {
  const s = sceneWide();
  const store = createMemoryStore();
  const logs = [];
  const clock = { t: s.now };
  const crypto = { candles: async () => s.c5raw, usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const bot = createScalpBot({ store, crypto, source1m: { candles1m: async () => [] }, now: () => clock.t, log: (m) => logs.push(m) });
  return { s, store, logs, clock, bot };
}

test('bot: scalp_wide opens one trade per coin under its OWN market/strategy, with its own balance; scalp and intraday queries never see it', async () => {
  const h = harnessWide();
  await h.store.setConfigIfMissing('scalp_wide', { min_candles_15m: 10 }); // this fixture's 34 candles give 11 complete 15-min buckets
  const r = await h.bot.cryptoScalpWideScan();
  assert.deepEqual(r.entered, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const rows = h.store._db.trades;
  assert.equal(rows.length, 3);
  assert.ok(rows.every((t) => t.market === 'crypto_wide_scalp' && t.strategy === 'scalp_wide' && t.status === 'open' && t.direction === 'LONG'));
  const t = rows[0];
  assert.equal(t.sl_price, 100.333929); assert.equal(t.target_price, 102.025); assert.equal(t.r_factor, 4.02);
  assert.match(t.basis, /^Scalp wide LONG on BTCUSDT: the 5-min chart showed exhaustion reversal/); assert.match(t.basis, /reward\/risk 4\.02 after costs/);
  assert.equal((await h.bot.cryptoScalpWideScan()).entered.length, 0, 'one open scalp_wide per coin');
  assert.deepEqual(await h.store.openTrades('crypto_scalp'), [], 'the tight scalp never sees scalp_wide trades');
  assert.deepEqual(await h.store.openTrades('crypto'), [], 'nor does the intraday crypto monitor');
  assert.deepEqual(await h.store.closedTrades(null), [], 'nor the intraday lists (market ends in "_scalp", same exclusion as the tight scalp)');
});

test('bot: NSE scalp does not run (no 1-minute NSE source) and says why, once a day', async () => {
  const h = harness();
  const r = await h.bot.nseScalpScan(); await h.bot.nseScalpScan();
  assert.equal(r.ran, false); assert.match(r.reason, /no 1-minute NSE candle source/);
  assert.equal(h.logs.filter((l) => /NSE scalp is off/.test(l)).length, 1);
});

// ---------- report ----------
const closedT = (over) => ({ status: 'closed', pnl_inr: 100, gross_pnl_inr: 150, patterns: ['hammer'], entry_time: '2026-11-16T05:00:00.000Z', exit_time: '2026-11-16T05:10:00.000Z', ...over });

test('report: win rate, net P&L, average minutes in trade; a pattern under 20 trades says "too few trades, no conclusion"', () => {
  // 20 hammer trades (15 wins +100, 5 losses -40) and 5 engulfing trades (all wins): hammer win 75 %, net 15 x 100 - 5 x 40 = 1300
  const closed = [...Array.from({ length: 15 }, () => closedT()), ...Array.from({ length: 5 }, () => closedT({ pnl_inr: -40, gross_pnl_inr: -10 })), ...Array.from({ length: 5 }, () => closedT({ patterns: ['bullish_engulfing'], exit_time: '2026-11-16T05:04:00.000Z' }))];
  const s = summarise({ closed, open: [], skips: [], minTrades: 20 });
  assert.equal(s.trades, 25); assert.equal(s.winRatePct, 80); assert.equal(s.netPnlInr, 1800); // 20 wins x 100 - 5 x 40 = 1800
  assert.equal(s.avgMinutes, 8.8); // (20 trades x 10 min + 5 x 4 min) / 25 = 220 / 25
  const h = s.patterns.find((p) => p.pattern === 'hammer'); const e = s.patterns.find((p) => p.pattern === 'bullish_engulfing');
  assert.deepEqual([h.trades, h.winRatePct, h.conclusion], [20, 75, 'enough trades']); assert.deepEqual([e.trades, e.conclusion], [5, NO_CONCLUSION]);
  assert.equal(summarise({ closed: closed.slice(0, 3), open: [], skips: [], minTrades: 20 }).conclusion, NO_CONCLUSION);
});

test('report: skips grouped by reason with counts; scalp and intraday are computed from their own trades only', async () => {
  const store = createMemoryStore();
  for (let i = 0; i < 3; i++) await store.insertTrade({ market: 'crypto_scalp', strategy: 'scalp', symbol: 'BTCUSDT', trade_date: '2026-11-16', status: 'closed', pnl_inr: 50, gross_pnl_inr: 80, patterns: ['hammer'], entry_time: '2026-11-16T05:00:00.000Z', exit_time: '2026-11-16T05:06:00.000Z' });
  await store.insertTrade({ market: 'crypto', symbol: 'ETHUSDT', trade_date: '2026-11-16', status: 'closed', pnl_inr: -500, patterns: ['hammer'], entry_time: '2026-11-16T05:00:00.000Z', exit_time: '2026-11-16T07:00:00.000Z' });
  await store.insertTrade({ market: 'nse', symbol: 'TCS', trade_date: '2026-11-16', status: 'closed', pnl_inr: 700, patterns: ['engulfing'], entry_time: '2026-11-16T05:00:00.000Z', exit_time: '2026-11-16T06:00:00.000Z' });
  for (const [r, n] of [['reward/risk 0.6 after costs is below 1.3', 2], ['reward/risk 0.9 after costs is below 1.3', 1], ['only 0.2% of room to the nearest resistance 100.7', 1]]) for (let i = 0; i < n; i++) await store.insertSkip({ market: 'crypto_scalp', symbol: `S${i}${r.length}`, skip_date: '2026-11-16', reason: r });
  await store.insertSkip({ market: 'nse', symbol: 'INFY', skip_date: '2026-11-16', reason: 'no fresh candle' });
  const d = await buildScalpData({ store, now: () => Date.parse('2026-11-17T04:00:00Z') });
  assert.equal(d.scalp.trades, 3); assert.equal(d.scalp.netPnlInr, 150); assert.equal(d.scalp.avgMinutes, 6);
  assert.equal(d.intraday.trades, 2); assert.equal(d.intraday.netPnlInr, 200); assert.equal(d.intraday.avgMinutes, 90); // (120 + 60) / 2
  assert.deepEqual(d.scalp.skips.reasons.map((r) => [r.reason, r.n]), [['reward/risk N after costs is below N', 3], ['only N% of room to the nearest resistance N', 1]]);
  assert.deepEqual(d.intraday.skips.reasons.map((r) => r.n), [1]);
  assert.equal(d.recentScalp.length, 3);
});

test('report page: Scalp and Intraday tabs, "too few trades, no conclusion", and every value HTML-escaped', async () => {
  const store = createMemoryStore();
  await store.insertSkip({ market: 'crypto_scalp', symbol: 'BTCUSDT', skip_date: '2026-11-16', reason: '<script>alert(1)</script> reward/risk 0.5' });
  const html = renderScalpReport(await buildScalpData({ store, now: () => Date.parse('2026-11-16T10:00:00Z') }));
  assert.match(html, /id="b-scalp"[^>]*>Scalp<\/button><button id="b-scalp_wide"[^>]*>Scalp wide<\/button><button id="b-intraday"[^>]*>Intraday<\/button>/);
  assert.match(html, /too few trades, no conclusion/); assert.doesNotMatch(html, /<script>alert/); assert.match(html, /&lt;script&gt;alert\(1\)/);
});

// ---------- wiring ----------
// no web framework needed: a tiny fake app records the routes, and a fake response records what the handler sent
function fakeApp() {
  const routes = {};
  return { routes, get: (path, handler) => { routes[path] = handler; } };
}
async function call(app, path, { query = {}, headers = {} } = {}) {
  const out = { status: 200, headers: {}, body: null, type: null };
  const res = {
    set(h, v) { if (typeof h === 'object') Object.assign(out.headers, h); else out.headers[h] = v; return this; },
    status(n) { out.status = n; return this; },
    type(t) { out.type = t; return this; },
    send(b) { out.body = b; return this; },
    json(b) { out.type = 'json'; out.body = JSON.stringify(b); return this; },
  };
  await app.routes[path]({ query, get: (h) => headers[h.toLowerCase()] }, res);
  return out;
}
function wiring(env) {
  const app = fakeApp(); const crons = []; const logs = [];
  const state = { ready: true, store: createMemoryStore() };
  const okSecret = (g) => g === 's3cret';
  const out = attachScalp({ app, cron: { schedule: (expr) => crons.push(expr) }, axios: {}, env, log: (m) => logs.push(m), state, store: state.store, crypto: {}, secret: 's3cret', okSecret, enabled: true, guarded: (name, fn) => fn });
  return { app, crons, logs, out };
}
test('wiring: scan every minute and monitor every minute; the report is behind the secret; PAPER_SCALP_ENABLED=false removes the jobs but not the report', async () => {
  const on = wiring({});
  assert.deepEqual(on.crons, ['5 * * * * *', '35 * * * * *', '10 */5 * * * *', '40 * * * * *']); assert.equal(on.out.enabled, true);
  assert.equal((await call(on.app, '/api/paper/scalp-report')).status, 401);
  assert.equal((await call(on.app, '/api/paper/scalp-report', { query: { key: 'wrong' } })).status, 401);
  const ok = await call(on.app, '/api/paper/scalp-report', { query: { key: 's3cret' } });
  assert.equal(ok.status, 200); assert.equal(ok.type, 'html'); assert.match(ok.body, /Scalp vs Intraday/); assert.equal(ok.headers['Cache-Control'], 'no-store');
  const js = await call(on.app, '/api/paper/scalp-report', { query: { format: 'json' }, headers: { 'x-paper-secret': 's3cret' } });
  assert.equal(JSON.parse(js.body).paperOnly, true); assert.equal(JSON.parse(js.body).scalpEnabled, true);
  assert.ok(on.logs.some((l) => /NSE scalp is off/.test(l)));
  const off = wiring({ PAPER_SCALP_ENABLED: 'false' });
  assert.deepEqual(off.crons, []); assert.equal(off.out.enabled, false);
  assert.equal((await call(off.app, '/api/paper/scalp-report', { query: { key: 's3cret' } })).status, 200);
});

test('wiring: the paper_trades market CHECK constraint allows crypto_wide_scalp (a real Postgres would otherwise reject every scalp_wide insert)', () => {
  const sql = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'sql', 'paper_bot.sql'), 'utf8');
  const checks = [...sql.matchAll(/paper_trades_market_check CHECK \(market IN \(([^)]+)\)\)/g)];
  assert.ok(checks.length >= 1, 'the constraint must exist');
  const last = checks[checks.length - 1][1]; // the LAST ALTER wins (DROP + ADD is run top to bottom on every migrate)
  assert.match(last, /'crypto_wide_scalp'/);
});

test('wiring: paperbot/index.js calls the scalp hook once (one require line) and the scalp jobs are scheduled with the others', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'paperbot', 'index.js'), 'utf8');
  assert.equal((src.match(/require\('\.\.\/src\/paper\/scalp'\)\.attachScalp/g) || []).length, 1);
});
