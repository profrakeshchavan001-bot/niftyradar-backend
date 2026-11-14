'use strict';
// Replay simulator (src/paper/replay/): runs the REAL scalp engine (analyse/evaluateExit/settle, imported
// from src/paper/scalp/engine.js) over hand-built candles. Reuses test/scalpFixtures.js's `scene()`, which
// test/paperScalp.test.js already hand-verifies triggers a bullish exhaustion-reversal LONG at 100.44 with
// FREE (no-cost) config: stopPct 0.1056, stopPrice 100.333929, targetPct 0.5, targetPrice 100.9422, rr 4.73.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scene, MIN } = require('./scalpFixtures');
const { SCALP_DEFAULTS } = require('../src/paper/scalp/config');
const { sizeCrypto } = require('../paperbot/engine');
const { scanSignals, replayScalp, replayRandomBaseline } = require('../src/paper/replay/simulator');
const { lookAheadCheck } = require('../src/paper/replay/lookahead');

const FREE = { ...SCALP_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0 };

// candles1m = the fixture's 34 candles (warms up min_candles_1m=30, triggers the entry on its own last one,
// index 33, t=33*MIN) + ONE continuation candle at t=34*MIN whose high (101.0) clears the target (100.9422)
// and whose low (100.5) stays well above the stop (100.333929), so the trade resolves on the very next candle.
function buildHistory() {
  const s = scene();
  const continuation = { t: 34 * MIN, o: 100.5, h: 101.0, l: 100.5, c: 100.9, v: 10 };
  return { candles1m: [...s.c1raw, continuation], candles5m: s.c5raw };
}

test('scanSignals: finds exactly the one signal the fixture is built to trigger, with the hand-verified plan', () => {
  const { candles1m, candles5m } = buildHistory();
  const signals = scanSignals({ candles1m, candles5m, cfg: FREE });
  assert.equal(signals.length, 1);
  const { plan } = signals[0];
  assert.equal(plan.long, true);
  assert.equal(plan.entry, 100.44);
  assert.equal(plan.stopPct, 0.1056);
  assert.equal(plan.targetPct, 0.5);
  assert.equal(plan.stopPrice, 100.333929);
});

test('replayScalp: one closed LONG trade, exit on target, qty from the real sizeCrypto, pnl hand-worked', () => {
  const { candles1m, candles5m } = buildHistory();
  const trades = replayScalp({ symbol: 'BTCUSDT', candles1m, candles5m, cfg: FREE, fxRate: 88 });
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.direction, 'LONG');
  assert.equal(t.entry_price, 100.44);
  assert.equal(t.entry_t, 33 * MIN);
  assert.equal(t.exit_reason, 'target');
  assert.equal(t.exit_price, 100.9422);
  assert.equal(t.exit_t, 35 * MIN); // continuation candle (t=34*MIN) closes at 35*MIN

  // Sizing: capital_usdt 1000, risk_pct 2%, 3 symbols -> this coin's fixed share is capital/3 = 333.3333...
  //   notional = min(1000*2/100 / (0.1056/100), 1000/3, 1000/3) = min(18939.39..., 333.3333..., 333.3333...) = 333.3333...
  //   qty = 333.3333.../100.44  (computed here via the real, separately-tested sizeCrypto, not copied from replayScalp's own output)
  const size = sizeCrypto({ capital: 1000, riskPct: 2, stopPct: 0.1056, freeCash: 1000 / 3, price: 100.44, coins: 3 });
  assert.equal(t.qty, size.qty);
  // FREE config: zero fee, zero slippage -> cost = 0, net = gross. gross = (target - entry) x qty = 0.5022 x qty.
  const grossUsdt = Math.round((100.9422 - 100.44) * size.qty * 1e6) / 1e6;
  assert.equal(t.gross_pnl_usdt, grossUsdt);
  assert.equal(t.net_pnl_usdt, grossUsdt); // no costs
  assert.equal(t.pnl_inr, Math.round(grossUsdt * 88 * 100) / 100);
});

test('replayScalp: the default (costly) config skips the same setup (rr 0.8 < 1.3, already hand-verified in paperScalp.test.js) -- no trades', () => {
  const { candles1m, candles5m } = buildHistory();
  const trades = replayScalp({ symbol: 'BTCUSDT', candles1m, candles5m, cfg: SCALP_DEFAULTS, fxRate: 88 });
  assert.equal(trades.length, 0);
});

test('replayScalp: doubling the cost config (brief item 5, the doubled-cost check) only ever makes the gate stricter, never finds a trade the base config missed', () => {
  const { candles1m, candles5m } = buildHistory();
  const base = replayScalp({ symbol: 'BTCUSDT', candles1m, candles5m, cfg: FREE, fxRate: 88 });
  const doubled = replayScalp({ symbol: 'BTCUSDT', candles1m, candles5m, cfg: { ...FREE, fee_pct_per_side: 0.1, slippage_pct: 0.03 }, fxRate: 88 });
  assert.ok(doubled.length <= base.length);
});

test('replayRandomBaseline: resolves using the real evaluateExit()/settle(), never throws on an empty real-trade list', () => {
  const { candles1m } = buildHistory();
  assert.deepEqual(replayRandomBaseline({ symbol: 'BTCUSDT', candles1m, realTrades: [], cfg: FREE }), []);
  const base = [{ stop_pct: 0.1, target_pct: 0.3 }];
  const rows = replayRandomBaseline({ symbol: 'BTCUSDT', candles1m, realTrades: base, cfg: FREE, seed: 7 });
  for (const r of rows) {
    assert.ok(['LONG', 'SHORT'].includes(r.direction));
    assert.equal(typeof r.pnl_inr, 'number');
  }
});

test('look-ahead: corrupting the continuation candle (index 34, strictly after the trigger at index 33) does not change the signal decided at or before the trigger', () => {
  const { candles1m, candles5m } = buildHistory();
  const result = lookAheadCheck({ candles1m, candles5m, cfg: FREE, cutoffBar1m: 34 });
  assert.equal(result.ok, true);
  assert.equal(result.signalsBeforeCutoff, 1); // the one real signal, at index 33, is still found and unchanged
});

test('look-ahead: the check is not vacuous -- a window that leaks one future candle DOES change, so a real leak would be caught', () => {
  const { candles1m, candles5m } = buildHistory();
  const { analyse } = require('../src/paper/scalp/engine');
  const { istDayStart } = require('../paperbot/time');
  // A deliberately leaky decision at the real trigger bar (index 33): "now" is bumped one minute too late, so
  // the continuation candle (index 34) is treated as already closed and becomes `last` inside analyse().
  function leakyDecisionAt33(c1) {
    const i = 33;
    const now = c1[i].t + 2 * MIN; // the leak: index 34 now also looks closed
    const c1raw = c1.slice(0, i + 2); // includes index 34
    const c5raw = candles5m.filter((k) => k.t + 5 * MIN <= now);
    return analyse({ c1raw, c5raw, now, cfg: FREE, dayStartMs: istDayStart(now) });
  }
  // Sanity check on the test itself: leaking the future candle into the window changes the real decision at
  // bar 33 (it stops seeing a setup at all, because the "last" candle is now the continuation bar, not the
  // fixture's crafted one) -- so a real leak in the production code would NOT be invisible.
  const leaked = leakyDecisionAt33(candles1m);
  assert.notEqual(leaked.ok, true);
  // The REAL (non-leaky) scanSignals, even after that same future candle is corrupted, still decides exactly
  // what it decided before -- proving the production windowing never leaks it in the first place.
  const corrupted = candles1m.map((k, i) => (i === 34 ? { ...k, o: k.o * 50, h: k.h * 50, l: k.l * 50, c: k.c * 50, v: k.v * 50 } : k));
  const real = scanSignals({ candles1m: corrupted, candles5m, cfg: FREE }).filter((s) => s.i <= 33);
  assert.equal(real.length, 1);
  assert.equal(real[0].plan.entry, 100.44);
});
