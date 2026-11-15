'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { recoveryLimit } = require('../src/paper/lib/recoveryWindow');

test('recoveryLimit: a recent trade keeps the default (and the default cache key) window', () => {
  const nowMs = Date.parse('2026-11-15T10:00:00Z');
  const oldestEntryMs = nowMs - 5 * 60000; // 5 minutes old
  assert.strictEqual(recoveryLimit({ oldestEntryMs, nowMs, intervalMs: 300000, defaultLimit: 330 }), 330);
});

test('recoveryLimit: widens enough to cover a trade left open across an 11-hour outage', () => {
  const nowMs = Date.parse('2026-11-15T08:32:00Z');
  const oldestEntryMs = Date.parse('2026-11-14T21:29:00Z'); // ~11h03m old, 5-minute candles
  const limit = recoveryLimit({ oldestEntryMs, nowMs, intervalMs: 300000, defaultLimit: 330 });
  const ageMin = Math.round((nowMs - oldestEntryMs) / 60000);
  assert.ok(limit * 5 >= ageMin, `limit ${limit} x 5min must cover ${ageMin} minutes`);
});

test('recoveryLimit: bounded by maxLimit even for a very old trade (Binance klines caps at 1000)', () => {
  const nowMs = Date.parse('2026-11-20T00:00:00Z');
  const oldestEntryMs = Date.parse('2026-11-01T00:00:00Z'); // weeks old
  assert.strictEqual(recoveryLimit({ oldestEntryMs, nowMs, intervalMs: 60000, defaultLimit: 40, maxLimit: 1000 }), 1000);
});

test('recoveryLimit: no open trade (null entry) falls back to the default limit', () => {
  assert.strictEqual(recoveryLimit({ oldestEntryMs: null, nowMs: Date.now(), intervalMs: 60000, defaultLimit: 40 }), 40);
});
