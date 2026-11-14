'use strict';
// CC3 urgent fix item 3: a stored paper_config row created before PR #25 lowered scalp's min_rr default (1.3 -> 1.0) stays stuck
// at 1.3 forever, since setConfigIfMissing only ever writes once. One clear precedence rule (the stored row always wins - already
// documented in docs/SCALP.md) plus a one-time, idempotent migration of that ONE known-stale value.
const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateStaleConfigDefaults } = require('../paperbot/configMigrate');
const { createMemoryStore } = require('../paperbot/store');
const { loadScalpConfig } = require('../src/paper/scalp/config');

test('migrates a stored scalp.min_rr of exactly 1.3 (the pre-PR#25 default) to 1.0, keeping every other stored field', async () => {
  const store = createMemoryStore();
  await store.setConfigIfMissing('scalp', { min_rr: 1.3, symbols: ['BTCUSDT'], risk_pct: 2 });
  const migrated = await migrateStaleConfigDefaults(store, () => {});
  assert.deepEqual(migrated, [{ key: 'scalp', field: 'min_rr', from: 1.3, to: 1.0 }]);
  const rows = await store.getConfig();
  assert.deepEqual(rows.scalp, { min_rr: 1.0, symbols: ['BTCUSDT'], risk_pct: 2 });
  assert.equal((await loadScalpConfig(store)).min_rr, 1.0, 'the effective config now actually reads 1.0');
});

test('idempotent: running it a second time (or on an already-fixed database) is a no-op', async () => {
  const store = createMemoryStore();
  await store.setConfigIfMissing('scalp', { min_rr: 1.3 });
  await migrateStaleConfigDefaults(store, () => {});
  const second = await migrateStaleConfigDefaults(store, () => {});
  assert.deepEqual(second, []);
  assert.equal((await store.getConfig()).scalp.min_rr, 1.0);
});

test('never touches a value the owner deliberately changed to something other than the old stale default', async () => {
  const store = createMemoryStore();
  await store.setConfigIfMissing('scalp', { min_rr: 0.5 }); // the owner's own choice, not the stale 1.3 default
  const migrated = await migrateStaleConfigDefaults(store, () => {});
  assert.deepEqual(migrated, []);
  assert.equal((await store.getConfig()).scalp.min_rr, 0.5, 'left exactly as the owner set it');
});

test('no stored scalp config at all (fresh database) is a safe no-op', async () => {
  const store = createMemoryStore();
  assert.deepEqual(await migrateStaleConfigDefaults(store, () => {}), []);
});
