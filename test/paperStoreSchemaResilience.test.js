'use strict';
// Root-cause fix (15 Nov outage round 3): schema setup must run at most once and must never block a real query
// from running, even if the migration itself fails. Before this fix, a failed migration reset its own "ready"
// flag and was retried on EVERY subsequent query, forever - so once it could fail at all, every store call from
// every job failed with the exact same error forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPgStore } = require('../paperbot/store');

function fakePool({ schemaFails = true } = {}) {
  let schemaCalls = 0;
  const realQueries = [];
  return {
    schemaCalls: () => schemaCalls,
    realQueries,
    query: async (text) => {
      if (/CREATE TABLE/.test(text)) {
        schemaCalls += 1;
        if (schemaFails) throw new Error('check constraint "paper_trades_market_check" of relation "paper_trades" is violated by some row');
        return { rows: [] };
      }
      realQueries.push(text);
      return { rows: [] };
    },
  };
}

test('a failing schema migration is attempted once, logged, and never retried on later queries', async () => {
  const logs = [];
  const pool = fakePool({ schemaFails: true });
  const store = createPgStore(() => pool, (m) => logs.push(m));
  for (let i = 0; i < 5; i += 1) await store.query('SELECT 1');
  assert.equal(pool.schemaCalls(), 1, 'schema setup must run at most once, not once per query');
  assert.equal(pool.realQueries.length, 5, 'every real query must still run even though schema setup failed');
  assert.ok(logs.some((l) => l.includes('schema setup failed')));
  assert.match(store.schemaError().message, /violated by some row/);
});

test('a successful schema migration also runs only once', async () => {
  const pool = fakePool({ schemaFails: false });
  const store = createPgStore(() => pool, () => {});
  for (let i = 0; i < 3; i += 1) await store.query('SELECT 1');
  assert.equal(pool.schemaCalls(), 1);
  assert.equal(store.schemaError(), null);
});

test('store.init() can be called explicitly at boot and is a safe no-op afterwards', async () => {
  const pool = fakePool({ schemaFails: false });
  const store = createPgStore(() => pool, () => {});
  await store.init();
  await store.init();
  assert.equal(pool.schemaCalls(), 1);
});
