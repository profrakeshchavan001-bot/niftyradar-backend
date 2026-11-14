'use strict';
// Generic decide(candles,context)/evaluateExit({trade,candles})/settle() adapter (src/paper/replay/simulator.js:
// scanDecideSignals/resolveDecideTrade/replayDecideBot), the machinery every src/paper/bots/*/ adapter reuses
// (exhaustion_only today, trend_smc when it lands). Tested here with hand-built fake decide/evaluateExit/settle
// functions with known arithmetic, so this file is checking THIS repo's own wiring, not re-deriving a bot's math.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scanDecideSignals, resolveDecideTrade, replayDecideBot } = require('../src/paper/replay/simulator');

const MIN5 = 5 * 60000;

// 10 flat candles, 5-minute step, price 100 flat (content does not matter: the fake decide() below ignores it
// and fires on the candle at index 4 only, so trigger_t = candles[4].t = 4*MIN5 = 1,200,000).
function flatCandles(n = 10) {
  return Array.from({ length: n }, (_, i) => ({ t: i * MIN5, o: 100, h: 100.1, l: 99.9, c: 100, v: 1 }));
}

// Fires exactly once, at the candle whose index (within the full array, found via its own close time) is 4.
// entry 100, stop 99 (1% away), target 102 (2% away) -- by hand: stopPct = |100-99|/100*100 = 1%, targetPct = 2%.
function fakeDecide(win) {
  const last = win[win.length - 1];
  if (last.t !== 4 * MIN5) return { take: false, direction: null };
  return { take: true, direction: 'up', entry: 100, stop: 99, target: 102, trigger_t: last.t, rr: 2, pattern: 'fake_pattern' };
}

// Exits on the 2nd candle after the trigger with a fixed price 101 (gross = (101-100) x qty = qty, by hand).
function fakeEvaluateExit({ candles }) {
  if (candles.length < 2) return { exit: false };
  return { exit: true, reason: 'target', price: 101, timeMs: candles[1].t + MIN5 };
}

// gross = (exitPrice - entry) x qty; cost = 0 (fee/slippage both 0 in this fixture's cfg); net = gross.
function fakeSettle({ trade, exitPrice, fxRate }) {
  const gross = (exitPrice - trade.entry_price) * trade.qty;
  return { gross_pnl_usdt: gross, cost_usdt: 0, net_pnl_usdt: gross, gross_pnl_inr: gross * fxRate, pnl_inr: gross * fxRate };
}

const cfg = { capital_usdt: 1000, risk_pct: 2, symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] };
const buildContext = () => ({});

test('scanDecideSignals: finds exactly the one bar the fake decide() is built to fire on', () => {
  const candles = flatCandles();
  const signals = scanDecideSignals({ candles, intervalMs: MIN5, decide: fakeDecide, buildContext, cfg, minCandles: 1, window: 20 });
  assert.equal(signals.length, 1);
  assert.equal(signals[0].decision.entry, 100);
});

test('resolveDecideTrade: hand-worked qty, pnl and exit placement', () => {
  const candles = flatCandles();
  const decision = { take: true, direction: 'up', entry: 100, stop: 99, target: 102, trigger_t: 4 * MIN5, rr: 2, pattern: 'fake_pattern' };
  // sizeCrypto: notional = min(1000*2/100 / (1/100), 1000/3, 1000/3) = min(2000, 333.333..., 333.333...) = 333.333...
  // qty = 333.333.../100 = 3.333333...
  const qty = (1000 / 3) / 100;
  const r = resolveDecideTrade({ symbol: 'BTCUSDT', candles, triggerIndex: 4, decision, evaluateExitFn: fakeEvaluateExit, settleFn: fakeSettle, cfg, fxRate: 88, qty, stepMs: MIN5 });
  assert.equal(r.resolved, true);
  assert.equal(r.row.entry_t, 4 * MIN5);
  assert.equal(r.row.exit_t, candles[6].t + MIN5); // candles.slice(5) -> index 1 of that slice is candles[6]
  assert.equal(r.row.exit_price, 101);
  assert.equal(r.row.stop_pct, 1); // |100-99|/100*100
  assert.equal(r.row.target_pct, 2); // |102-100|/100*100
  assert.equal(r.row.gross_pnl_usdt, 1 * qty); // (101-100) x qty, worked out above
  assert.equal(r.row.pnl_inr, 1 * qty * 88);
});

test('replayDecideBot: end to end with the real sizeCrypto (via sizeFor) -- one trade, matching the hand-worked numbers above', () => {
  const candles = flatCandles();
  const trades = replayDecideBot({ symbol: 'BTCUSDT', candles, intervalMs: MIN5, decide: fakeDecide, buildContext, evaluateExitFn: fakeEvaluateExit, settleFn: fakeSettle, cfg, fxRate: 88, minCandles: 1, window: 20 });
  assert.equal(trades.length, 1);
  const t = trades[0];
  assert.equal(t.direction, 'LONG');
  assert.equal(t.entry_price, 100);
  assert.equal(t.exit_price, 101);
  assert.equal(t.patterns[0], 'fake_pattern');
  const qty = (1000 / 3) / 100;
  assert.equal(t.qty, qty);
  assert.equal(t.pnl_inr, 1 * qty * 88); // fakeSettle does not round; same formula as the hand-worked test above
});
