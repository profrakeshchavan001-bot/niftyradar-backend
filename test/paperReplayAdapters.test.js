'use strict';
// Round-2 adapters (src/paper/replay/adapters/, plus scalp_wide in src/paper/replay/simulator.js): smoke
// tests against synthetic candles (no crash, returns an array) and a look-ahead check for each, reusing the
// generic lookAheadCheckDecide()/lookAheadCheckWide() so every new adapter gets the same guard with no new
// per-adapter look-ahead code. The underlying decide()/evaluateExit()/settle() math for each bot is already
// tested where that bot's own code lives (test/exhaustionOnly.test.js, test/paperScalp.test.js); this file
// checks only this repo's replay wiring (windowing, sizing, exit resolution), not re-deriving that math.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { replayExhaustionOnly, decide: decideEx, buildContext: ctxEx, EXHAUSTION_ONLY_DEFAULTS } = require('../src/paper/replay/adapters/exhaustionOnly');
const { replayIntradayCrypto, decide: decideIc, buildContext: ctxIc, INTRADAY_CRYPTO_DEFAULTS } = require('../src/paper/replay/adapters/intradayCrypto');
const { replayScalpWide } = require('../src/paper/replay/simulator');
const { SCALP_WIDE_DEFAULTS } = require('../src/paper/scalp/config');
const { lookAheadCheckDecide, lookAheadCheckWide } = require('../src/paper/replay/lookahead');

const FIVE_MIN = 5 * 60000;

// Deterministic pseudo-random 5-minute candles (LCG, no Math.random): a real-shaped series with enough bars
// to clear every bot's warm-up, long enough to very likely produce at least one signal for at least one bot.
function genCandles(n, seed) {
  let a = seed;
  const rng = () => { a = (a * 1103515245 + 12345) >>> 0; return (a % 10000) / 10000; };
  let px = 100;
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const t = i * FIVE_MIN;
    const o = px;
    px = Math.max(1, px + (rng() - 0.5) * 0.6);
    const h = Math.max(o, px) + rng() * 0.2;
    const l = Math.min(o, px) - rng() * 0.2;
    out.push({ t, o, h, l, c: px, v: 10 + rng() * 5 });
  }
  return out;
}

const CANDLES = genCandles(400, 42);

for (const [name, fn, cfg] of [
  ['exhaustion_only', (c) => replayExhaustionOnly({ symbol: 'BTCUSDT', candles5m: c }), EXHAUSTION_ONLY_DEFAULTS],
  ['intraday_crypto', (c) => replayIntradayCrypto({ symbol: 'BTCUSDT', candles5m: c }), INTRADAY_CRYPTO_DEFAULTS],
  ['scalp_wide', (c) => replayScalpWide({ symbol: 'BTCUSDT', candles5m: c, cfg: SCALP_WIDE_DEFAULTS }), SCALP_WIDE_DEFAULTS],
]) {
  test(`${name}: replays without throwing and returns a plain trade array`, () => {
    const trades = fn(CANDLES);
    assert.ok(Array.isArray(trades));
    for (const t of trades) {
      assert.ok(['LONG', 'SHORT'].includes(t.direction));
      assert.equal(typeof t.pnl_inr, 'number');
      assert.ok(t.exit_t > t.entry_t);
    }
  });
}

test('exhaustion_only: look-ahead holds -- corrupting the candles after a cutoff does not change signals decided before it', () => {
  const r = lookAheadCheckDecide({ candles: CANDLES, intervalMs: FIVE_MIN, decide: decideEx, buildContext: ctxEx, cfg: EXHAUSTION_ONLY_DEFAULTS, minCandles: EXHAUSTION_ONLY_DEFAULTS.min_candles_5m, window: 330, cutoffBar: 200 });
  assert.equal(r.ok, true);
});

test('intraday_crypto: look-ahead holds', () => {
  const r = lookAheadCheckDecide({ candles: CANDLES, intervalMs: FIVE_MIN, decide: decideIc, buildContext: ctxIc, cfg: INTRADAY_CRYPTO_DEFAULTS, minCandles: INTRADAY_CRYPTO_DEFAULTS.min_candles, window: 330, cutoffBar: 200 });
  assert.equal(r.ok, true);
});

test('scalp_wide: look-ahead holds', () => {
  const r = lookAheadCheckWide({ candles5m: CANDLES, cfg: SCALP_WIDE_DEFAULTS, cutoffBar5m: 200 });
  assert.equal(r.ok, true);
});
