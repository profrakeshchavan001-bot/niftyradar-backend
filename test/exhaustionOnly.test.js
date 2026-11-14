'use strict';
// exhaustion_only (docs/BOTS.md, src/paper/bots/exhaustion_only/): the owner's own rule and nothing else, measured alone. Numbers are
// worked out by hand below (plain arithmetic, not copied from the function's own output - see the comments next to each assertion).
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, evaluateExit, settle, costPct } = require('../src/paper/bots/exhaustion_only/engine');
const { EXHAUSTION_ONLY_DEFAULTS } = require('../src/paper/bots/exhaustion_only/config');
const { createExhaustionBot, MARKET } = require('../src/paper/bots/exhaustion_only/bot');
const { createMemoryExhaustionStore } = require('../src/paper/bots/exhaustion_only/store');
const { createMemoryShadowStore } = require('../src/paper/shadow/store');
const { findPluginDirs } = require('../src/paper/pluginLoader');

const MIN = 60000; const FIVE = 5 * MIN;

// 34 closed 5-minute candles: 32 falling (102.00 down to 100.40, same shape used by the scalp_wide fixtures), then a small red candle
// and a green candle closing above its high -> the exhaustion_reversal pattern, long, entry 100.44. All volume 10, so VWAP sits near the
// middle of the range (about 101.2), above the small candle's close 100.39 - satisfies "price below VWAP" for the falling-move case.
function candles5() {
  const out = []; let px = 102.0; let t = 0;
  for (let i = 0; i < 32; i++) { out.push({ t, o: px, h: px + 0.025, l: px - 0.075, c: px - 0.05, v: 10 }); px = +(px - 0.05).toFixed(4); t += FIVE; }
  out.push({ t, o: 100.40, h: 100.405, l: 100.38, c: 100.39, v: 10 }); t += FIVE;
  out.push({ t, o: 100.39, h: 100.45, l: 100.385, c: 100.44, v: 10 });
  return out;
}

// 20 flat 15-minute candles, except index 3's high raised to 103 (the only swing high, 2 lower neighbours on each side - the only
// candidate target). ATR14 reads the LAST 14 candles (index 6-19 here), which stay perfectly flat (h-l = 1.0, no gap) -> ATR14 = 1.0
// exactly; index 3 sits outside that window on purpose, so the one outsized candle does not also inflate the ATR it is compared against.
function candles15({ swingHigh = 103 } = {}) {
  return Array.from({ length: 20 }, (_, i) => ({ t: i * 15 * MIN, o: 100, h: i === 3 ? swingHigh : 100.5, l: 99.5, c: 100, v: 5 }));
}

function scene(over = {}) {
  const c5 = candles5();
  const last = c5[c5.length - 1];
  const nowMs = last.t + FIVE + 5000;
  return { candles: c5, c15: candles15(over), c1h: [], nowMs, cfg: { ...EXHAUSTION_ONLY_DEFAULTS, ...over.cfg } };
}

test('plugin: auto-discovered by src/paper/pluginLoader.js under bots/exhaustion_only (no manual wiring needed)', () => {
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'exhaustion_only'));
});

// Hand arithmetic (plain numbers, not from decide()): entry 100.44, pattern low 100.38, ATR14(15m) = 1.0 (flat fixture) ->
//   stop = 100.38 - 1 x 1.0 = 99.38, risk = 1.06, riskPct = 1.06 / 100.44 x 100 = 1.055356 %
//   target = nearest level above entry = swing high 103, 0.1% held back -> 103 x 0.999 = 102.897, reward = 2.457, rewardPct = 2.446237 %
//   costs = 2 x 0.1 + 0.03 = 0.23 %; rewardNet = 2.446237 - 0.23 = 2.216237; riskNet = 1.055356 + 0.23 = 1.285356
//   rr = 2.216237 / 1.285356 = 1.724219 -> 1.72 (>= 1.2, trades)
test('decide: the exhaustion rule on a falling move gives a LONG, stop beyond the pattern low, target the only swing high, rr 1.72 after costs', () => {
  const s = scene();
  const ctx5 = require('../paperbot/engine').buildContext(s.candles, s.candles[0].t);
  const d = decide(s.candles, { vwap: ctx5.vwap, c15: s.c15, c1h: s.c1h, nowMs: s.nowMs, cfg: s.cfg });
  assert.equal(d.take, true, d.reason);
  assert.equal(d.direction, 'up'); assert.equal(d.entry, 100.44); assert.equal(d.pattern, 'exhaustion_reversal');
  assert.equal(d.stop, 99.38); assert.equal(d.target, 102.897); assert.equal(d.rr, 1.72);
  assert.match(d.basis, /^Exhaustion-only LONG:/); assert.match(d.basis, /No other pattern, no trend filter/);
});

// Same setup but min_rr raised above 1.72: the one rule still fires (the pattern itself has no trend filter and does not change),
// only the level-based reward/risk gate turns it down - demonstrating the gate is a separate, named reason, not a second pattern rule.
test('decide: min_rr is the lever; raising it above 1.72 skips the SAME setup with the numbers in the reason', () => {
  const s = scene({ cfg: { min_rr: 2 } });
  const ctx5 = require('../paperbot/engine').buildContext(s.candles, s.candles[0].t);
  const d = decide(s.candles, { vwap: ctx5.vwap, c15: s.c15, c1h: s.c1h, nowMs: s.nowMs, cfg: s.cfg });
  assert.equal(d.take, false);
  assert.match(d.reason, /^reward\/risk 1\.72 after costs is below 2 \(target 2\.4462%, stop 1\.0554%, costs 0\.23% round trip\)$/); // same numbers as the test above, just a higher bar
});

test('decide: no setup at all is quiet (not logged); too few 5-min candles is refused in plain words', () => {
  const s = scene();
  const flat = s.candles.map((k) => ({ ...k, o: 100, h: 100.01, l: 99.99, c: 100 }));
  const ctx5 = require('../paperbot/engine').buildContext(flat, flat[0].t);
  const q = decide(flat, { vwap: ctx5.vwap, c15: s.c15, c1h: s.c1h, nowMs: s.nowMs, cfg: s.cfg });
  assert.equal(q.take, false); assert.equal(q.quiet, true);
  assert.match(decide(s.candles.slice(-5), { vwap: 101, c15: s.c15, c1h: [], nowMs: s.nowMs, cfg: s.cfg }).reason, /not enough 5-min candles yet/);
});

// ---------- exits (candle-accurate, src/paper/lib/exitSim.js) ----------
test('exit: target and stop are checked against every candle high/low; both in one candle books the STOP (worst case); no breakeven, no time stop', () => {
  const trade = { direction: 'LONG', entry_price: 100, sl_price: 99, target_price: 101, trigger_t: 0 };
  const cd = (t, o, h, l, c) => ({ t, o, h, l, c, v: 1 });
  assert.deepEqual(evaluateExit({ trade, candles: [cd(FIVE, 100, 101.2, 99.9, 100.5)] }), { exit: true, reason: 'target', price: 101, timeMs: 2 * FIVE });
  assert.deepEqual(evaluateExit({ trade, candles: [cd(FIVE, 100, 100.2, 98.8, 99.5)] }), { exit: true, reason: 'stop', price: 99, timeMs: 2 * FIVE });
  const both = evaluateExit({ trade, candles: [cd(FIVE, 100, 101.5, 98.5, 100)] });
  assert.deepEqual([both.reason, both.price], ['stop', 99]);
  // a long run inside the range with no target/stop touch, even well past where a breakeven rule would have moved the stop elsewhere, never exits
  const hold = evaluateExit({ trade, candles: Array.from({ length: 20 }, (_, i) => cd((i + 1) * FIVE, 100.5, 100.9, 100.1, 100.5)) });
  assert.equal(hold.exit, false);
});

// Long 5 coins 100 -> 101: gross = 1 x 5 = 5. Fees 0.1% of (500+505) = 1.005, slippage 0.03% of 500 = 0.15, costs 1.155, net 3.845; x 88 = Rs 338.36
test('settle: fees on both sides + slippage come off, same cost model as the scalp bots', () => {
  const s = settle({ trade: { direction: 'LONG', entry_price: 100, qty: 5 }, exitPrice: 101, cfg: EXHAUSTION_ONLY_DEFAULTS, fxRate: 88 });
  assert.deepEqual(s, { gross_pnl_usdt: 5, cost_usdt: 1.155, net_pnl_usdt: 3.845, gross_pnl_inr: 440, pnl_inr: 338.36 });
});

test('costPct: 0.1% fee per side + 0.03% slippage = 0.23% round trip', () => {
  assert.equal(Math.round(costPct(EXHAUSTION_ONLY_DEFAULTS) * 1000) / 1000, 0.23);
});

// ---------- the bot ----------
// bot.js does not fetch a separate native 15-min feed - like the main crypto bot (paperbot/bot.js), it leaves decide() to build the
// 15-min candles from the 5-minute ones (E.aggregate), which needs at least 45 5-minute candles for 15 complete buckets. 12 quiet
// padding candles (flat, far from the tail) are prepended so that holds here too; they are themselves aggregated into the first four
// 15-min buckets and never reach the ATR14 window (the last 14 of 15) or the pattern lookback (the last 8 of 5-minute), so the engine
// numbers already hand-verified above (stop 99.38, target 102.897, rr 1.72) are unaffected - the exhaustionReversal pattern and the
// ATR both still look only at the real fixture's tail.
function candles5Padded() {
  const pad = Array.from({ length: 12 }, (_, i) => ({ t: i * FIVE, o: 110, h: 110.01, l: 109.99, c: 110, v: 1 }));
  return [...pad, ...candles5().map((k) => ({ ...k, t: k.t + 12 * FIVE }))];
}

function harness(over = {}) {
  const s = scene(over);
  const padded = candles5Padded();
  const store = createMemoryExhaustionStore();
  const shadowStore = createMemoryShadowStore();
  const logs = [];
  const clock = { t: padded[padded.length - 1].t + FIVE + 5000 };
  const crypto = { candles: async () => padded, hourly: async () => s.c1h, usdtInr: async () => ({ rate: 88, source: 'test' }) };
  const bot = createExhaustionBot({ store, crypto, loadCfg: async () => s.cfg, shadowStore, now: () => clock.t, log: (m) => logs.push(m) });
  return { s, padded, store, shadowStore, logs, clock, bot };
}

test('bot: a skipped setup is shadow-tracked (never counted as a trade) and the monitor resolves it to its would-be exit', async () => {
  const h = harness({ cfg: { min_rr: 100 } }); // guaranteed skip, same fixture as the "below min_rr" test above
  await h.bot.scan();
  const shadows = h.shadowStore._db.rows;
  assert.equal(shadows.length, 3);
  assert.ok(shadows.every((r) => r.bot === 'exhaustion_only' && r.status === 'open' && r.direction === 'LONG'));
  const target = shadows[0].target_price;
  h.padded.push({ t: h.padded[h.padded.length - 1].t + FIVE, o: 100.44, h: target + 1, l: 100.4, c: target + 0.5, v: 1 }); // clears the target
  h.clock.t += FIVE + 5000;
  await h.bot.monitor();
  const row = h.shadowStore._db.rows[0];
  assert.equal(row.status, 'resolved'); assert.equal(row.resolved_reason, 'target'); assert.equal(row.resolved_price, target);
  assert.equal(h.store._db.trades.length, 0, 'a shadow is never counted as a trade');
});

// bot.js leaves decide() to build its own 15-min candles from the padded array (E.aggregate), same as the main crypto bot - the exact
// target it lands on (whichever real level is nearest) is NOT the fabricated 103 swing high from the engine-level tests above, since
// there is no explicit c15 fixture here. These orchestration tests therefore cross-check the bot's own numbers against the SAME shared
// sizing/pattern functions it calls, rather than re-deriving a second hand-picked target/stop - the exact financial arithmetic is
// already hand-verified at the decide() level above; this layer checks wiring (market separation, sizing, one-trade-per-coin, exits).
test('bot: each of BTC / ETH / SOL gets exactly ONE open trade (own market, own balance), sized from its own stop; a second scan opens nothing', async () => {
  const h = harness({ cfg: { min_rr: 0 } }); // the real default (1.2) is a near-miss on this padded fixture (1.18) - not what this test is about
  const r = await h.bot.scan();
  assert.deepEqual(r.entered, ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  const rows = h.store._db.trades;
  assert.equal(rows.length, 3); assert.ok(rows.every((t) => t.status === 'open' && t.direction === 'LONG'));
  assert.deepEqual([rows[0].sl_price, rows[0].target_price, rows[0].rr], [rows[1].sl_price, rows[1].target_price, rows[1].rr], 'identical candles -> identical plan for every coin');
  const { sizeCrypto } = require('../paperbot/engine');
  const stopPct = Math.abs(rows[0].entry_price - rows[0].sl_price) / rows[0].entry_price * 100;
  const size = sizeCrypto({ capital: h.s.cfg.capital_usdt, riskPct: h.s.cfg.risk_pct, stopPct, freeCash: h.s.cfg.capital_usdt, price: rows[0].entry_price, coins: 3 });
  assert.equal(Math.round(rows[0].qty * 1e6) / 1e6, Math.round(size.qty * 1e6) / 1e6);
  assert.equal((await h.bot.scan()).entered.length, 0, 'one open trade per coin');
  assert.equal(h.store._db.trades.length, 3);
});

test('bot: a reward/risk below min_rr is skipped and stored; it never opens a trade', async () => {
  const h = harness({ cfg: { min_rr: 100 } }); // nothing could ever clear this
  assert.deepEqual((await h.bot.scan()).entered, []);
  assert.equal(h.store._db.trades.length, 0);
  assert.equal(h.store._db.skips.length, 3);
  assert.match(h.store._db.skips[0].reason, /^reward\/risk [\d.]+ after costs is below 100 \(target [\d.]+%, stop [\d.]+%, costs 0\.23% round trip\)$/);
});

test('bot: the monitor closes at the target with gross, costs, net and rupee P&L stored', async () => {
  const h = harness({ cfg: { min_rr: 0 } });
  await h.bot.scan();
  const target = h.store._db.trades[0].target_price;
  h.padded.push({ t: h.padded[h.padded.length - 1].t + FIVE, o: 100.44, h: target + 1, l: 100.4, c: target + 0.5, v: 1 }); // clears the target
  h.clock.t += FIVE + 5000;
  const m = await h.bot.monitor();
  assert.deepEqual(m, { checked: 3, closed: 3 });
  const t = h.store._db.trades[0];
  assert.equal(t.status, 'closed'); assert.equal(t.exit_reason, 'target'); assert.equal(t.exit_price, target);
  const qty = t.qty; const gross = (target - 100.44) * qty;
  assert.ok(Math.abs(t.gross_pnl_usdt - gross) < 1e-4); assert.ok(t.pnl_inr < t.gross_pnl_inr, 'costs reduce the rupee P&L'); assert.equal(t.fx_rate, 88);
});

test(`market key: own market "${MARKET}" (ends in "_only", never "_scalp" - it must not be swept into the scalp exclusion or vice versa)`, () => {
  assert.equal(MARKET, 'crypto_exhaustion_only');
});
