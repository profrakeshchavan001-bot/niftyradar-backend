'use strict';
// confluence (Bot A) entry logic (src/paper/bots/confluence/engine.js): location (order block / liquidity
// sweep) + trigger (candle pattern) must agree on direction, and the stop/target come purely from real
// chart levels (src/paper/lib/levelEngine.js, logicalTargets.js) - never a fixed % or fixed R multiple.
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide } = require('../src/paper/bots/confluence/engine');
const { buildContext } = require('../paperbot/engine');
const { CONFLUENCE_DEFAULTS } = require('../src/paper/bots/confluence/config');

const MIN = 60000; const FIVE = 5 * MIN;
const mk = (t, o, h, l, c, v = 10) => ({ t, o, h, l, c, v });

// A liquidity sweep (wick below the prior 10-candle swing low, closes back inside the range) that is also
// a hammer (long lower wick, tiny/no upper wick, after a fall) - location AND trigger agree: LONG. A far
// swing high (140, well before "today") is the only resistance level, so it becomes the target.
function buildScene({ sweepHigh = 99 } = {}) {
  const prior = []; let t = 0;
  for (let i = 0; i < 10; i++) { prior.push(mk(t, 100, 103, 97, 100.5)); t += FIVE; }
  const sweep = mk(t, 98, sweepHigh, 93, 99);
  const lead = []; let t2 = -15 * FIVE;
  for (let i = 0; i < 5; i++) { lead.push(mk(t2, 100, 101, 99, 100)); t2 += FIVE; }
  lead[2] = mk(lead[2].t, 100, 140, 99, 100); // the only swing high, far from entry
  const candles = [...lead, ...prior, sweep];
  const dayStartMs = sweep.t; // only the sweep candle counts as "today" (keeps "today's high" out of the way)
  const ctx5 = buildContext(candles, dayStartMs);
  const nowMs = sweep.t + FIVE + 1000;
  return { candles, context: { vwap: ctx5.vwap, c15: [], c1h: [], dayStartMs, nowMs, cfg: { ...CONFLUENCE_DEFAULTS, min_candles_5m: 10 } } };
}

test('decide: location (liquidity sweep) + trigger (hammer) agree -> LONG, stop beyond the sweep, target the real swing high, R:R from real levels', () => {
  const { candles, context } = buildScene();
  const d = decide(candles, context);
  assert.equal(d.take, true, d.reason);
  assert.equal(d.direction, 'up');
  assert.equal(d.entry, 99);
  assert.equal(d.pattern, 'hammer');
  assert.match(d.locationType, /liquidity_sweep/);
  assert.equal(d.stopType, 'beyond liquidity_sweep');
  assert.equal(d.obstacleLevel.price, 140);
  assert.ok(d.stop < 93, 'stop must sit beyond (below) the sweep low, with the ATR cushion');
  assert.ok(d.target < 140 && d.target > d.entry, 'target sits just before the real level, never at or beyond it');
  assert.ok(d.rr >= 1.5);
});

test('decide: same setup but the sweep candle leaves an upper wick above entry -> that becomes the nearest obstacle, R:R too small -> SKIP with a shadow plan, never widened to pass', () => {
  const { candles, context } = buildScene({ sweepHigh: 99.3 }); // the wick itself is now "today's high", much closer than the real swing high
  const d = decide(candles, context);
  assert.equal(d.take, false);
  assert.match(d.reason, /below 1\.5/);
  assert.ok(d.extra.shadowPlan, 'a fully-worked-out plan that only failed the R:R gate must carry a shadow plan');
  assert.equal(d.extra.shadowPlan.direction, 'LONG');
  assert.equal(d.extra.shadowPlan.entry_price, 99);
});

test('decide: order-flow disagreement (confluence_flow\'s extra gate) skips an otherwise-valid LONG setup', () => {
  const { candles, context } = buildScene();
  const d = decide(candles, { ...context, flow: { direction: 'sell', strength: 0.8 } });
  assert.equal(d.take, false);
  assert.match(d.reason, /order flow disagrees/);
  assert.ok(d.extra.shadowPlan);
});

test('decide: order-flow agreement lets the same setup through', () => {
  const { candles, context } = buildScene();
  const d = decide(candles, { ...context, flow: { direction: 'buy', strength: 0.6 } });
  assert.equal(d.take, true);
});

test('decide: location with no trigger pattern, or trigger with no location, is quiet (not logged) - confluence needs both', () => {
  const flat = Array.from({ length: 20 }, (_, i) => mk(i * FIVE, 100, 100.2, 99.8, 100));
  const ctx5 = buildContext(flat, 0);
  const q = decide(flat, { vwap: ctx5.vwap, c15: [], c1h: [], dayStartMs: 0, nowMs: flat[flat.length - 1].t + FIVE + 1, cfg: { ...CONFLUENCE_DEFAULTS, min_candles_5m: 10 } });
  assert.equal(q.take, false);
  assert.equal(q.quiet, true);
});

test('decide: too few 5-min candles is refused in plain words, never a silent guess', () => {
  const { candles, context } = buildScene();
  const d = decide(candles.slice(-3), context);
  assert.equal(d.take, false);
  assert.match(d.reason, /not enough 5-min candles/);
});
