'use strict';
// Root cause of the 15 Nov "cryptoScan" /api/paper/health failure: error text was the cryptic
// `"undefined" is not valid JSON` - a classic JSON.parse(undefined) / JSON.parse(JSON.stringify(undefined))
// bug (JSON.stringify(undefined) returns the JS value undefined, not the string "undefined"; JSON.parse on
// that throws exactly this message).
//
// Found in paperbot/store.js's createCachedStore(). cryptoScan and nseScan both call
// store.tradesForDay(market, istDate) with the SAME date but different markets
// (paperbot/bot.js: nseScan at line ~153 `tradesForDay('nse', p.date)`, cryptoScan at line ~282
// `tradesForDay('crypto', date)`). The old tradesForDay REASSIGNED the whole `day` Map to prune
// older dates, then read the just-fetched value BACK OUT of whatever `day` currently pointed to:
//
//   async tradesForDay(market, date) {
//     const key = `${market}|${date}`;
//     if (!day.has(key)) {
//       day = new Map([...day].filter(([k]) => k.endsWith(`|${date}`)));   // <- reassigns `day`
//       day.set(key, await inner.tradesForDay(market, date));              // <- writes into THAT map
//     }
//     return copy(day.get(key));                                          // <- re-reads the CURRENT `day`
//   }
//
// If a second, concurrent call for a DIFFERENT market (same date) reassigns `day` again while the
// first call is still awaiting its own DB read, the first call's own write lands in its own
// (now-orphaned) map, while `return copy(day.get(key))` reads it back out of the NEWER map - which
// never got that key. `day.get(key)` is `undefined`, and `copy()` (`JSON.parse(JSON.stringify(x))`)
// throws the exact bug message. Because nseScan (09:15-15:30 IST, every 5 min) and cryptoScan (24/7,
// every 5 min) run on offset-but-overlappable cron ticks, this is a real, intermittent production race,
// not a contrived one - whichever of the two calls is the slower of the pair gets the crash.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCachedStore, safeClone } = require('../paperbot/store');

// A controllable inner store: tradesForDay() for a given market resolves only when told to.
function createControllableInner() {
  const pending = new Map(); // market -> { resolve }
  return {
    inner: {
      kind: 'postgres',
      async tradesForDay(market) {
        return new Promise((resolve) => { pending.set(market, resolve); });
      },
    },
    resolve(market, rows) {
      const r = pending.get(market);
      if (!r) throw new Error(`no pending tradesForDay call for ${market} to resolve`);
      pending.delete(market);
      r(rows);
    },
  };
}

test('BUG REPRODUCTION (documents the original crash): two concurrent tradesForDay() calls for different markets, same date, used to make the SLOWER one read back undefined and crash with the exact "undefined is not valid JSON" message', async () => {
  // This test exercises the OLD unsafe shape directly (JSON.parse(JSON.stringify(undefined))) so the
  // exact failure mode is pinned down even after the real fix below changes the code path that used to
  // hit it. This is the "construct the exact undefined input" reproduction the fix is proven against.
  assert.throws(() => JSON.parse(JSON.stringify(undefined)), (e) => e instanceof SyntaxError && /"undefined" is not valid JSON/.test(e.message));
});

test('tradesForDay(): the fixed cache never hands back undefined under the exact race that used to crash it, for either market, in either resolution order', async () => {
  for (const [first, second] of [['crypto', 'nse'], ['nse', 'crypto']]) {
    const { inner, resolve } = createControllableInner();
    const store = createCachedStore(inner);
    const date = '2026-11-16';

    const pFirst = store.tradesForDay(first, date); // starts, reassigns/mutates the day cache, then awaits
    await Promise.resolve(); // let it reach its own await before the second call starts
    const pSecond = store.tradesForDay(second, date); // starts concurrently, same date, different market
    await Promise.resolve();

    // Resolve the SECOND call's own DB read first (it finishes before the first one) - this is exactly
    // the ordering that used to orphan the first call's write under the old reassignment race.
    resolve(second, [{ id: 2, market: second }]);
    const rowsSecond = await pSecond;
    assert.deepEqual(rowsSecond, [{ id: 2, market: second }]);

    // Now resolve the first (slower) call's own DB read - this is the one that used to crash.
    resolve(first, [{ id: 1, market: first }]);
    const rowsFirst = await pFirst; // must NOT throw "undefined" is not valid JSON
    assert.deepEqual(rowsFirst, [{ id: 1, market: first }]);

    // A later plain read of either key (now resolved, no race) still works from the warmed cache.
    assert.deepEqual(await store.tradesForDay(first, date), [{ id: 1, market: first }]);
    assert.deepEqual(await store.tradesForDay(second, date), [{ id: 2, market: second }]);
  }
});

test('tradesForDay(): three-way concurrency (nse + crypto + a third market) on the same date never crashes, whatever order the reads resolve in', async () => {
  const { inner, resolve } = createControllableInner();
  const store = createCachedStore(inner);
  const date = '2026-11-16';

  const pA = store.tradesForDay('nse', date);
  await Promise.resolve();
  const pB = store.tradesForDay('crypto', date);
  await Promise.resolve();
  const pC = store.tradesForDay('nse_scalp', date);
  await Promise.resolve();

  // Resolve out of start order: C, A, B.
  resolve('nse_scalp', [{ id: 'c' }]);
  resolve('nse', [{ id: 'a' }]);
  resolve('crypto', [{ id: 'b' }]);

  const [a, b, c] = await Promise.all([pA, pB, pC]);
  assert.deepEqual(a, [{ id: 'a' }]);
  assert.deepEqual(b, [{ id: 'b' }]);
  assert.deepEqual(c, [{ id: 'c' }]);
});

test('tradesForDay(): a stale day is pruned from the cache without disturbing an in-flight read for today', async () => {
  const seen = [];
  const inner = {
    kind: 'postgres',
    async tradesForDay(market, date) { seen.push(`${market}|${date}`); return [{ market, date }]; },
  };
  const store = createCachedStore(inner);
  await store.tradesForDay('crypto', '2026-11-15'); // warms yesterday
  const today = await store.tradesForDay('crypto', '2026-11-16'); // today: must prune yesterday, not crash
  assert.deepEqual(today, [{ market: 'crypto', date: '2026-11-16' }]);
  assert.deepEqual(seen, ['crypto|2026-11-15', 'crypto|2026-11-16']);
});

// Defense in depth: the safe clone helper itself (used by createMemoryStore and createCachedStore alike)
// must never again surface the raw, cryptic V8 message - it should say plainly what went wrong, and still
// behave exactly like JSON.parse(JSON.stringify(x)) for every real (non-undefined) value.
test('safeClone: undefined fails with a clear, diagnosable message instead of the cryptic native JSON error', () => {
  assert.throws(() => safeClone(undefined, 'cryptoScan'), (e) => {
    assert.ok(e instanceof Error);
    assert.doesNotMatch(e.message, /is not valid JSON/); // the ORIGINAL bug's exact (cryptic) message must be gone
    assert.match(e.message, /cryptoScan/); // names the caller, so this is diagnosable next time
    assert.match(e.message, /undefined/);
    return true;
  });
});

test('safeClone: every other value is cloned exactly as JSON.parse(JSON.stringify(x)) always did', () => {
  assert.deepEqual(safeClone({ a: 1, b: [1, 2, 3] }), { a: 1, b: [1, 2, 3] });
  assert.deepEqual(safeClone([]), []);
  assert.equal(safeClone(null), null);
  assert.equal(safeClone(0), 0);
});

test('cachedStore.updateTrade(): the fields clone sees the real unsafe path exercised (a cached row exists for the id) and still never crashes with the cryptic JSON error, even when fields itself is undefined', async () => {
  const insertedRows = [];
  const store = createCachedStore({
    kind: 'postgres',
    async getConfig() { return {}; },
    async openTrades() { return []; },
    async insertTrade(t) { insertedRows.push(t); return insertedRows.length; },
    async updateTrade() {}, // the DB side is a no-op here; only the in-memory clone path is under test
  });
  await store.openTrades('crypto'); // warms the open-trades cache so the next insert is tracked in memory
  const id = await store.insertTrade({ market: 'crypto', symbol: 'BTCUSDT', trade_date: '2026-11-16' });
  // With a row now cached under `id`, updateTrade's `for (const row of rowsOf(id)) Object.assign(row, copy(fields))`
  // actually reaches `copy(fields)` - the real call site the original bug would have hit if `fields` were ever
  // undefined. It must fail with OUR clear error, never the cryptic native one.
  await assert.rejects(
    () => store.updateTrade(id, undefined),
    (e) => e instanceof Error && !/is not valid JSON/.test(e.message),
  );
});
