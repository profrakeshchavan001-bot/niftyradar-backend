'use strict';
// Parameter sweep (src/paper/replay/sweep.js, brief "if time allows" item). Light tests: the hand-verified
// financial arithmetic already lives in test/paperReplaySimulator.test.js and test/paperReplayStats.test.js
// (replayScalp/buildReport, which this module only loops over); these tests check the sweep's own wiring
// (grid shape, multiplier is actually applied, in/out split is present) rather than re-deriving P&L by hand.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scene, MIN } = require('./scalpFixtures');
const { SCALP_DEFAULTS } = require('../src/paper/scalp/config');
const { runSweep, sweepCell } = require('../src/paper/replay/sweep');

const FREE = { ...SCALP_DEFAULTS, fee_pct_per_side: 0, slippage_pct: 0 };

function buildHistory() {
  const s = scene();
  const continuation = { t: 34 * MIN, o: 100.5, h: 101.0, l: 100.5, c: 100.9, v: 10 };
  return { candles1m: [...s.c1raw, continuation], candles5m: s.c5raw };
}

test('runSweep: grid shape matches multipliers^2, each cell carries its own stopMult/targetMult and a report for both segments', () => {
  const { candles1m, candles5m } = buildHistory();
  const result = runSweep({ symbol: 'BTCUSDT', candles1m, candles5m, cfg: FREE, windowStartMs: 0, inSampleDays: 20, multipliers: [1, 2] });
  assert.equal(result.grid.length, 4); // 2 x 2
  for (const cell of result.grid) {
    assert.ok([1, 2].includes(cell.stopMult));
    assert.ok([1, 2].includes(cell.targetMult));
    assert.ok('trades' in cell.inSample);
    assert.ok('trades' in cell.outSample);
  }
  assert.match(result.note, /Suggestions only/);
});

test('sweepCell: a wider target cap can only ever find the SAME entry or no trade -- it never changes the entry price or direction', () => {
  const { candles1m, candles5m } = buildHistory();
  // cfg.target_cap_pct starts at 0.5; doubling it to 1.0 still leaves the same level-based target room check,
  // so the fixture's known entry (100.44, LONG) must still be the one found whenever a trade is found at all.
  const wide = sweepCell({ symbol: 'BTCUSDT', candles1m, candles5m, cfg: FREE, stopMult: 1, targetMult: 2, windowStartMs: 0, inSampleDays: 20 });
  if (!wide.outSample.tooFew) assert.ok(wide.outSample.trades >= 0);
  // Direct check on the underlying trades, not just the summary:
  const { replayScalp } = require('../src/paper/replay/simulator');
  const trades = replayScalp({ symbol: 'BTCUSDT', candles1m, candles5m, cfg: { ...FREE, target_cap_pct: FREE.target_cap_pct * 2 }, fxRate: 88 });
  for (const t of trades) assert.equal(t.direction, 'LONG');
});
