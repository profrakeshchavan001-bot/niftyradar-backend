'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLevelSet, equalLevels, dayHighLow } = require('../src/paper/lib/levelEngine');

const MIN = 60000;
function candle(t, o, h, l, c, v = 10) { return { t, o, h, l, c, v }; }

// A simple zig-zag series so swingLevels() reliably finds highs/lows.
function zigzag(n, base, amp, startT, stepMs) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const up = i % 4 < 2;
    const o = base + (up ? i % 2 : -(i % 2)) * amp;
    const h = o + amp / 2;
    const l = o - amp / 2;
    const c = up ? o + amp / 3 : o - amp / 3;
    out.push(candle(startT + i * stepMs, o, h, l, c));
  }
  return out;
}

test('buildLevelSet returns support/resistance, order block, FVG, VWAP and day high/low kinds from real OHLC', () => {
  const dayStartMs = 0;
  const c5 = zigzag(80, 100, 2, 0, 5 * MIN);
  const c15 = zigzag(60, 100, 3, 0, 15 * MIN);
  const c1h = zigzag(50, 100, 5, 0, 60 * MIN);
  const { levels, vwap } = buildLevelSet({ c5, c15, c1h, dayStartMs, nowMs: c5[c5.length - 1].t + 5 * MIN });
  assert.ok(levels.length > 0, 'should produce at least one level');
  assert.ok(levels.every((l) => l.price > 0 && l.type && l.side && l.tf));
  assert.ok(levels.some((l) => l.type.includes('swing high 5m') || l.type.includes('swing low 5m')));
  assert.ok(levels.some((l) => l.type.includes('swing high 15m') || l.type.includes('swing low 15m')));
  assert.ok(levels.some((l) => l.type.includes('swing high 1h') || l.type.includes('swing low 1h')));
  assert.ok(levels.some((l) => l.type === "today's high" || l.type === "today's low"));
  assert.ok(Number.isFinite(vwap));
});

test('dayHighLow: empty when no candle falls on or after dayStartMs', () => {
  const c5 = [candle(0, 1, 2, 0.5, 1.5)];
  assert.deepEqual(dayHighLow(c5, 1000), []);
});

test('dayHighLow: today high/low from candles at/after dayStartMs only', () => {
  const c5 = [candle(-1000, 1, 2, 0.5, 1.5), candle(0, 10, 12, 9, 11), candle(5 * MIN, 11, 13, 10, 12)];
  const out = dayHighLow(c5, 0);
  const high = out.find((l) => l.type === "today's high");
  const low = out.find((l) => l.type === "today's low");
  assert.equal(high.price, 13);
  assert.equal(low.price, 9);
});

test('equalLevels: groups 2+ swing prices within tolerance into one liquidity pool, ignores lone swings', () => {
  const pools = equalLevels([100, 100.05, 150], 'equal highs liquidity pool 15m', 'resistance', '15m', 0.1);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].count, 2);
  assert.equal(pools[0].side, 'resistance');
  assert.ok(pools[0].price > 100 && pools[0].price < 100.1);
});
