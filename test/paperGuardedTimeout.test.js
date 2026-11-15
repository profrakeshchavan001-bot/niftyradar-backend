'use strict';
// CC3 urgent fix (docs/decisions/CC3.md, 15 Nov outage): guarded() defense in depth. The real root cause was a missing
// Postgres statement_timeout (see pgOptions() in paperbot/index.js and the hand-verified repro below); these are the
// extra safety nets so a hang ANYWHERE cannot wedge a job's own guard shut forever.
const test = require('node:test');
const assert = require('node:assert/strict');
const { guarded, pgOptions } = require('../paperbot/index');

test('guarded: a job that hangs past maxMs is abandoned and logged as timed out; the busy flag is released so the NEXT tick runs', async () => {
  const logs = [];
  let calls = 0;
  const hang = () => { calls += 1; return new Promise(() => {}); }; // never resolves - a hung fetch/query
  const job = guarded('test job', hang, (m) => logs.push(m), { maxMs: 20, maxBusyMs: 60 });
  await job(); // times out after 20ms, logged, busy released in finally
  assert.equal(calls, 1);
  assert.ok(logs.some((l) => /timed out after 20ms/.test(l)));
  await new Promise((r) => setTimeout(r, 70)); // past maxBusyMs too, for good measure
  await job(); // a second call must be allowed to actually run, not silently swallowed by a stuck busy flag
  assert.equal(calls, 2);
});

test('guarded: an overlapping call while a run is genuinely still fresh and busy is skipped, exactly as before', async () => {
  let resolveFirst;
  const slow = () => new Promise((r) => { resolveFirst = r; });
  const job = guarded('test job', slow, () => {}, { maxMs: 5000, maxBusyMs: 60000 });
  const first = job();
  const second = job(); // overlaps - must be a no-op, not a second concurrent run
  resolveFirst();
  await Promise.all([first, second]);
});

test('guarded: a normal success still clears busy immediately (no regression from the timeout race added)', async () => {
  const job = guarded('ok job', async () => 'done', () => {});
  await job();
  await job(); // would be skipped if busy never cleared
});

// CC3 ROOT CAUSE: pgOptions() must set statement_timeout/query_timeout - this is the actual fix for the 15 Nov outage
// (pool max 2, a stalled Supabase connection with no timeout held its slot forever; reproduced by hand with pg_sleep(30)
// against a local Postgres - see docs/decisions/CC3.md for the exact before/after timings).
test('pgOptions: statement_timeout and query_timeout are set (10s), not left unbounded', () => {
  const opt = pgOptions('postgres://u:p@db.example.invalid:5432/postgres');
  assert.equal(opt.statement_timeout, 10000);
  assert.equal(opt.query_timeout, 10000);
  assert.equal(opt.max, 2); // unchanged - the fix is the timeout, not the pool size
});
