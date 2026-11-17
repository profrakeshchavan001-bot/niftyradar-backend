'use strict';
// Root-cause fix (backfill bug report, problems 1 and 3): src/paper/lib/backfillAlertSuppress.js marks
// every backfilled mirror/reverse row as already-sent in telegram_alert_log, the exact table and key
// src/paper/ops/telegramAlerts/register.js's own alreadySent() uses - so its next poll tick never fires
// an individual live alert for a historical, backfilled row. A genuinely live trade is never touched
// here (it is simply not in the list passed in), so register.js keeps alerting on it exactly as before.
const test = require('node:test');
const assert = require('node:assert/strict');
const { markAlreadySent } = require('../src/paper/lib/backfillAlertSuppress');

function fakePool() {
  const queries = [];
  return { queries, query: async (sql, params) => { queries.push({ sql, params }); return { rows: [] }; } };
}

test('marks an entry+exit row for every CLOSED trade, entry-only for an OPEN one', async () => {
  const pool = fakePool();
  const trades = [{ id: 1, status: 'closed' }, { id: 2, status: 'open' }];
  const r = await markAlreadySent(pool, 'scalp_wide-REVERSE', trades);
  const insert = pool.queries.find((q) => /INSERT INTO telegram_alert_log/.test(q.sql));
  assert.ok(insert, 'an insert was issued');
  // trade 1: entry + exit (2 rows), trade 2: entry only (1 row) = 3 rows total
  assert.equal(insert.params.length, 9); // 3 rows x (bot, trade_id, event)
  assert.deepEqual(insert.params.slice(0, 3), ['scalp_wide-REVERSE', 1, 'entry']);
  assert.deepEqual(insert.params.slice(3, 6), ['scalp_wide-REVERSE', 1, 'exit']);
  assert.deepEqual(insert.params.slice(6, 9), ['scalp_wide-REVERSE', 2, 'entry']);
  assert.equal(r.marked, 3);
});

test('no pool (script run with no PAPER_DATABASE_URL) -> no-op, never throws', async () => {
  const r = await markAlreadySent(null, 'intraday-REVERSE', [{ id: 1, status: 'closed' }]);
  assert.deepEqual(r, { marked: 0 });
});

test('empty trade list -> no-op, no query issued at all', async () => {
  const pool = fakePool();
  await markAlreadySent(pool, 'intraday-REVERSE', []);
  assert.equal(pool.queries.length, 0);
});

test('a row with no id (never actually inserted) is skipped, never sent as NULL', async () => {
  const pool = fakePool();
  const r = await markAlreadySent(pool, 'intraday-REVERSE', [{ id: null, status: 'open' }]);
  assert.equal(r.marked, 0);
  assert.equal(pool.queries.length, 1); // only the CREATE TABLE IF NOT EXISTS, no INSERT
});

test('a database error is caught and logged, never thrown - a reporting hiccup must never fail the backfill', async () => {
  const pool = { query: async () => { throw new Error('relation does not exist'); } };
  const logs = [];
  const r = await markAlreadySent(pool, 'intraday-REVERSE', [{ id: 1, status: 'closed' }], { log: (m) => logs.push(m) });
  assert.equal(r.marked, 0);
  assert.ok(r.error);
  assert.ok(logs.some((l) => l.includes('intraday-REVERSE')));
});

test('bot label or missing trades array -> no-op, never throws', async () => {
  const pool = fakePool();
  assert.deepEqual(await markAlreadySent(pool, null, [{ id: 1 }]), { marked: 0 });
  assert.deepEqual(await markAlreadySent(pool, 'x', null), { marked: 0 });
  assert.equal(pool.queries.length, 0);
});
