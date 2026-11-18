'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { planFromLevels, pathCheck, firstObstacle, computeStop } = require('../src/paper/lib/logicalTargets');

test('normal case: stop beyond the order block, target at the first resistance, R:R computed from real levels', () => {
  const entry = 100;
  const entryBasis = { low: 98, high: 100 }; // the order block / pattern zone the long entry is based on
  const levels = [
    { price: 110, type: 'swing high 1h', side: 'resistance' }, // first obstacle above entry
    { price: 150, type: 'swing high 1h', side: 'resistance' }, // further out, irrelevant
    { price: 95, type: 'swing low 15m', side: 'support' },
  ];
  const r = planFromLevels({ entry, long: true, entryBasis, levels, atr: 1, costPct: 0.2, minRr: 1.5 });
  assert.equal(r.ok, true);
  assert.ok(r.plan.stop < 98); // beyond the order block low, with the ATR cushion
  assert.ok(r.plan.target < 110 && r.plan.target > entry); // just before the obstacle, never at or beyond it
  assert.equal(r.plan.obstacleLevel.price, 110);
  assert.ok(r.plan.rr >= 1.5);
});

test('path check: an opposing level between entry and the first obstacle shortens the target, never lengthens it', () => {
  const entry = 100;
  const levels = [
    { price: 120, type: 'swing high 1h', side: 'resistance' }, // the "real" first obstacle
    { price: 108, type: 'order block', side: 'resistance' }, // sits in the way - should become the target instead
  ];
  const target = { price: 119.88, type: 'swing high 1h' }; // what firstObstacle would have produced (120 - 0.1% margin)
  const pc = pathCheck({ entry, long: true, target, levels });
  assert.equal(pc.shortened, true);
  assert.equal(pc.target.price, 108);
  assert.equal(pc.obstacles[0].price, 108);
});

test('path check: no opposing level in the way leaves the target unchanged', () => {
  const entry = 100;
  const levels = [{ price: 120, type: 'swing high 1h', side: 'resistance' }];
  const target = { price: 119.88, type: 'swing high 1h' };
  const pc = pathCheck({ entry, long: true, target, levels });
  assert.equal(pc.shortened, false);
  assert.equal(pc.target.price, target.price);
});

test('R:R below 1.5 after costs is a SKIP with a reason, and the target is never pushed out to pass it', () => {
  const entry = 100;
  const entryBasis = { low: 90, high: 100 }; // a wide stop (far below entry) forces a low R:R against a nearby target
  const levels = [{ price: 103, type: 'swing high 15m', side: 'resistance' }]; // small reward vs the wide risk above
  const r = planFromLevels({ entry, long: true, entryBasis, levels, atr: 0, costPct: 0.2, minRr: 1.5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /below 1\.5/);
  assert.ok(r.plan.target <= 103); // the skip reason is the gate, not a target that got moved further out
});

test('no order block/swing on the entry side -> skip with reason, never a fixed-% stop', () => {
  const r = planFromLevels({ entry: 100, long: true, entryBasis: null, levels: [{ price: 110, type: 'x', side: 'resistance' }] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /order block/);
});

test('no resistance/support level ahead -> skip, never a fixed-% target', () => {
  const r = planFromLevels({ entry: 100, long: true, entryBasis: { low: 98, high: 100 }, levels: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no resistance level/);
});

test('computeStop/firstObstacle short-side mirror', () => {
  const stop = computeStop({ long: false, entryBasis: { low: 100, high: 105 }, atr: 1, atrMult: 0.5 });
  assert.equal(stop, 105.5);
  const ob = firstObstacle({ entry: 100, long: false, levels: [{ price: 90, type: 'x', side: 'support' }, { price: 80, type: 'y', side: 'support' }] });
  assert.equal(ob.price, 90);
});
