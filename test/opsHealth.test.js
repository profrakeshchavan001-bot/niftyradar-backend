'use strict';
// Overnight ops glance page: GET /api/paper/health (src/paper/ops/health.js). All expected numbers below
// are worked out by hand in the comments next to them, not copied from the function's own output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHealthTracker, buildHealth, JOB_NAMES, STALE_MS } = require('../src/paper/ops/health');
const { createMemoryStore } = require('../paperbot/store');

const NOW = Date.UTC(2026, 10, 14, 4, 0); // Sat 14 Nov 2026, 09:30 IST

test('tracker.wrap records a successful run and clears any earlier error for that job', async () => {
  let now = NOW;
  const tracker = createHealthTracker({ now: () => now });
  const ok = tracker.wrap('nseScan', async () => 'done');
  await ok();
  const snap = tracker.snapshot();
  assert.deepEqual(snap.jobs.nseScan, { lastRunAt: NOW, ok: true, error: null });
  assert.deepEqual(snap.errors, []);
});

test('tracker.wrap records a failed run, rethrows, and keeps the last 10 errors (oldest dropped)', async () => {
  let now = NOW;
  const tracker = createHealthTracker({ now: () => now });
  const failing = tracker.wrap('cryptoScan', async () => { throw new Error('boom'); });
  for (let i = 0; i < 12; i++) {
    now = NOW + i; // 12 distinct timestamps, one per failure
    await assert.rejects(failing(), /boom/);
  }
  const snap = tracker.snapshot();
  assert.equal(snap.errors.length, 10); // ring buffer caps at 10 of the 12 failures
  assert.equal(snap.errors[0].at, NOW + 11); // newest first
  assert.equal(snap.errors[9].at, NOW + 2); // the two oldest (at NOW, NOW+1) were dropped
  assert.equal(snap.jobs.cryptoScan.ok, false);
  assert.equal(snap.jobs.cryptoScan.error, 'boom');
});

test('ALIVE: bot ready, all 4 jobs scanned just now, database reachable, no errors, NSE open, Telegram configured', async () => {
  const marketOpenNow = Date.UTC(2026, 10, 13, 5, 0); // Fri 13 Nov 2026 10:30 IST - NSE open (NOW above is a Saturday)
  const tracker = createHealthTracker({ now: () => marketOpenNow });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const store = createMemoryStore();
  const env = { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C' };
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: marketOpenNow, env });
  assert.equal(h.status, 'ALIVE');
  assert.equal(h.database.ok, true);
  assert.equal(h.openTrades.nse, 0);
  assert.equal(h.openTrades.crypto, 0);
  assert.equal(h.today.trades, 0);
  assert.equal(h.today.skips, 0);
  for (const name of JOB_NAMES) assert.equal(h.jobs[name].stale, false);
});

test('PROBLEM: a job has not scanned in over 15 minutes (overnight brief rule: stale after 15 min)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  tracker.recordRun('nseScan', true);
  tracker.recordRun('nseMonitor', true);
  tracker.recordRun('cryptoScan', true);
  // cryptoMonitor never recorded: "never" counts as stale too, not "unchecked and therefore fine"
  const store = createMemoryStore();
  const later = NOW + STALE_MS + 60000; // 16 minutes after the last recorded run
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: later });
  assert.equal(h.status, 'PROBLEM');
  assert.match(h.reason, /no scan in 15\+ min/);
  assert.ok(h.reason.includes('cryptoMonitor'));
  assert.equal(h.jobs.nseScan.minutesAgo, 16);
  assert.equal(h.jobs.cryptoMonitor.lastRunAt, null);
});

test('PROBLEM: database unreachable is reported honestly, counts stay null (never guessed)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const brokenStore = { listTrades: async () => { throw new Error('ECONNREFUSED'); } };
  const h = await buildHealth({ tracker, store: brokenStore, state: { enabled: true, ready: true }, now: NOW });
  assert.equal(h.status, 'PROBLEM');
  assert.equal(h.database.ok, false);
  assert.match(h.reason, /ECONNREFUSED/);
  assert.equal(h.openTrades.nse, null);
  assert.equal(h.today.trades, null);
});

test('PROBLEM: no store configured at all (PAPER_DATABASE_URL unset at startup, state.store still null)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  const h = await buildHealth({ tracker, store: null, state: { enabled: true, ready: false }, now: NOW });
  assert.equal(h.status, 'PROBLEM');
  assert.match(h.reason, /still starting/);
  assert.equal(h.database.ok, false);
});

test('PROBLEM: bot disabled via PAPER_BOT_ENABLED=false', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  const h = await buildHealth({ tracker, store: null, state: { enabled: false, ready: false }, now: NOW });
  assert.match(h.reason, /disabled/);
});

test('today counts only count rows dated today, not yesterday (hand-checked: 1 of 2 trades, 1 of 2 skips)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const store = createMemoryStore();
  const today = '2026-11-14';
  const yesterday = '2026-11-13';
  await store.insertTrade({ market: 'nse', symbol: 'RELIANCE', trade_date: today, status: 'open' });
  await store.insertTrade({ market: 'nse', symbol: 'TCS', trade_date: yesterday, status: 'closed' });
  await store.insertSkip({ market: 'nse', symbol: 'INFY', skip_date: today, reason: 'test' });
  await store.insertSkip({ market: 'nse', symbol: 'WIPRO', skip_date: yesterday, reason: 'test' });
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: NOW });
  assert.equal(h.today.trades, 1);
  assert.equal(h.today.skips, 1);
  assert.equal(h.openTrades.nse, 1); // only the open RELIANCE trade
});

test('data sources are reported as "unchecked" when not yet asked anything, never a made-up status', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  const h = await buildHealth({ tracker, store: createMemoryStore(), state: { enabled: true, ready: true }, now: NOW });
  assert.equal(h.dataSources.binance.status, 'unchecked');
  assert.equal(h.dataSources.yahoo.status, 'unchecked');
  assert.equal(h.dataSources.dhan.status, 'unchecked');
});

test('a source with a real stats object reports real ok/fail counts and the last error (overnight item 3)', async () => {
  const tracker = createHealthTracker({ now: () => NOW });
  const state = {
    enabled: true, ready: true,
    crypto: { stats: { ok: 40, fail: 2, lastError: 'HTTP 451', lastErrorAt: NOW - 60000, lastSuccessAt: NOW - 5000 } },
    yahoo: { stats: { ok: 10, fail: 0, lastError: null, lastErrorAt: null, lastSuccessAt: NOW - 10000 } },
    nse: { stats: { ok: 0, fail: 5, lastError: 'HTTP 808: Authentication Failed', lastErrorAt: NOW - 1000, lastSuccessAt: null } },
  };
  const h = await buildHealth({ tracker, store: createMemoryStore(), state, now: NOW });
  assert.deepEqual(h.dataSources.binance, { status: 'ok', ok: 40, fail: 2, lastError: 'HTTP 451', lastErrorAt: new Date(NOW - 60000).toISOString(), lastSuccessAt: new Date(NOW - 5000).toISOString() });
  assert.equal(h.dataSources.yahoo.status, 'ok');
  assert.equal(h.dataSources.dhan.status, 'failing'); // 0 ok, 5 fail: a real source that is actually down, not "unchecked"
  assert.equal(h.dataSources.dhan.lastError, 'HTTP 808: Authentication Failed');
});

// Round 3 item 2: ALIVE / DEGRADED / PROBLEM, not just ALIVE/PROBLEM.
const MARKET_OPEN = Date.UTC(2026, 10, 13, 5, 0); // Fri 13 Nov 2026 10:30 IST
const WEEKEND = Date.UTC(2026, 10, 14, 4, 0); // Sat 14 Nov 2026 09:30 IST (NOW above)

test('DEGRADED, not PROBLEM: NSE closed on the weekend, crypto scanning fine (the 02:40 IST false alarm)', async () => {
  const tracker = createHealthTracker({ now: () => WEEKEND });
  for (const name of JOB_NAMES) tracker.recordRun(name, true); // nse jobs "ran" too, doesn't matter - closed anyway
  const h = await buildHealth({ tracker, store: createMemoryStore(), state: { enabled: true, ready: true }, now: WEEKEND, env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C' } });
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.reason, /NSE closed/);
  assert.deepEqual(h.problems, []);
});

test('PROBLEM beats DEGRADED: NSE closed AND crypto has not scanned in 15+ min', async () => {
  const tracker = createHealthTracker({ now: () => WEEKEND });
  tracker.recordRun('nseScan', true); tracker.recordRun('nseMonitor', true); // irrelevant, nse is closed
  // cryptoScan/cryptoMonitor never recorded -> stale, and crypto runs 24/7 so it counts
  const h = await buildHealth({ tracker, store: createMemoryStore(), state: { enabled: true, ready: true }, now: WEEKEND });
  assert.equal(h.status, 'PROBLEM');
  assert.match(h.reason, /cryptoScan/);
});

test('DEGRADED: Dhan down but Yahoo fallback is ok - not a PROBLEM', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const state = { enabled: true, ready: true, nse: { stats: { ok: 0, fail: 3, lastError: 'HTTP 808', lastErrorAt: MARKET_OPEN, lastSuccessAt: null } }, yahoo: { stats: { ok: 5, fail: 0, lastError: null, lastErrorAt: null, lastSuccessAt: MARKET_OPEN } } };
  const h = await buildHealth({ tracker, store: createMemoryStore(), state, now: MARKET_OPEN, env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C' } });
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.reason, /Dhan down, Yahoo fallback working/);
  assert.deepEqual(h.problems, []);
});

test('PROBLEM: Dhan AND Yahoo both failing (no working fallback for NSE)', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const state = { enabled: true, ready: true, nse: { stats: { ok: 0, fail: 3, lastError: 'x', lastErrorAt: MARKET_OPEN, lastSuccessAt: null } }, yahoo: { stats: { ok: 0, fail: 3, lastError: 'y', lastErrorAt: MARKET_OPEN, lastSuccessAt: null } } };
  const h = await buildHealth({ tracker, store: createMemoryStore(), state, now: MARKET_OPEN });
  assert.equal(h.status, 'PROBLEM');
  assert.match(h.reason, /NSE data sources \(Dhan and Yahoo\) both failing/);
});

test('PROBLEM: Binance failing with no fallback (crypto has only one candle source)', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const state = { enabled: true, ready: true, crypto: { stats: { ok: 0, fail: 5, lastError: 'HTTP 503', lastErrorAt: MARKET_OPEN, lastSuccessAt: null } } };
  const h = await buildHealth({ tracker, store: createMemoryStore(), state, now: MARKET_OPEN });
  assert.equal(h.status, 'PROBLEM');
  assert.match(h.reason, /Binance.*no fallback/);
});

test('DEGRADED: Telegram not configured, everything else fine', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const h = await buildHealth({ tracker, store: createMemoryStore(), state: { enabled: true, ready: true }, now: MARKET_OPEN, env: {} });
  assert.equal(h.status, 'DEGRADED');
  assert.match(h.reason, /Telegram not configured/);
  assert.equal(h.telegram.configured, false);
});

// Add-on v2 item 6: /api/paper/health shows Telegram configured yes/no, last send ok/fail.
test('telegram: configured + last send ok, read from state.telegramStats', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const state = { enabled: true, ready: true, telegramStats: { lastSendOk: true } };
  const h = await buildHealth({ tracker, store: createMemoryStore(), state, now: MARKET_OPEN, env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C' } });
  assert.deepEqual(h.telegram, { configured: true, lastSendOk: true });
});

test('telegram: not configured, no sends yet -> configured false, lastSendOk null (never guessed)', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const h = await buildHealth({ tracker, store: createMemoryStore(), state: { enabled: true, ready: true }, now: MARKET_OPEN, env: {} });
  assert.deepEqual(h.telegram, { configured: false, lastSendOk: null });
});

// CC3 urgent fix item 4: shadows stuck 60+ min past their own stop/target/time stop means the resolver is not running
// (docs/decisions/CC3.md - the exact live bug: 10 shadow_setups rows open 40+ minutes past their time stop).
test('stale shadows (60min+): any count above 0 is a PROBLEM, with the count and reason stated plainly', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const store = { ...createMemoryStore(), query: async (sql) => { assert.match(sql, /shadow_setups/); return { rows: [{ n: 3 }] }; } };
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: MARKET_OPEN, env: {} });
  assert.equal(h.status, 'PROBLEM');
  assert.equal(h.staleShadows, 3);
  assert.match(h.reason, /3 open shadow\(s\) older than 60 min/);
});

// CC3 urgent fix item 3 (docs/decisions/CC3.md, 15 Nov outage): the actual fault that happened - every write stopped for
// ~3 hours with cron still firing and /api/paper/ping still answering - which the old staleJobs check (job FUNCTION ran)
// could never catch. This measures the newest row across every table directly.
test('last DB write: 10+ minutes ago is a PROBLEM, stated with the age in minutes', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const lastWrite = new Date(MARKET_OPEN - 15 * 60000).toISOString(); // 15 min before "now"
  const store = {
    ...createMemoryStore(),
    query: async (sql) => (/status = 'open'/.test(sql) ? { rows: [{ n: 0 }] } : { rows: [{ last_write: lastWrite }] }),
  };
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: MARKET_OPEN, env: {} });
  assert.equal(h.status, 'PROBLEM');
  assert.equal(h.lastDbWriteMinutesAgo, 15);
  assert.match(h.reason, /last database write was 15 min ago/);
});

test('last DB write: under 10 minutes is fine, not a problem', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const lastWrite = new Date(MARKET_OPEN - 3 * 60000).toISOString();
  const store = {
    ...createMemoryStore(),
    query: async (sql) => (/status = 'open'/.test(sql) ? { rows: [{ n: 0 }] } : { rows: [{ last_write: lastWrite }] }),
  };
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true }, now: MARKET_OPEN, env: {} });
  assert.equal(h.lastDbWriteMinutesAgo, 3); assert.doesNotMatch(h.reason, /last database write/);
});

test('stale shadows: 0 is not a problem; no raw query access (memory mode) reports null, never a false "0"', async () => {
  const tracker = createHealthTracker({ now: () => MARKET_OPEN });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const storeWithZero = { ...createMemoryStore(), query: async () => ({ rows: [{ n: 0 }] }) };
  const ok = await buildHealth({ tracker, store: storeWithZero, state: { enabled: true, ready: true }, now: MARKET_OPEN, env: {} });
  assert.equal(ok.staleShadows, 0); assert.doesNotMatch(ok.reason, /open shadow/);
  const memOnly = await buildHealth({ tracker, store: createMemoryStore(), state: { enabled: true, ready: true }, now: MARKET_OPEN, env: {} });
  assert.equal(memOnly.staleShadows, null);
});

test('crypto heartbeat: scanning but no trade for 12h+ is DEGRADED with the top rejection reasons; recent trade stays quiet', async () => {
  const now = Date.UTC(2026, 10, 18, 3, 0);
  const tracker = createHealthTracker({ now: () => now });
  for (const name of JOB_NAMES) tracker.recordRun(name, true);
  const rows = (sql) => {
    if (/FROM paper_trades WHERE market LIKE/.test(sql)) return [{ market: 'crypto', t: new Date(now - 14 * 3600000) }, { market: 'crypto_scalp', t: new Date(now - 1 * 3600000) }];
    if (/count\(\*\)::int AS n24/.test(sql)) return [{ market: 'crypto', t: new Date(now - 5 * 60000), n24: 300 }, { market: 'crypto_scalp', t: new Date(now - 5 * 60000), n24: 900 }];
    if (/AS bucket/.test(sql)) return [{ market: 'crypto', bucket: 'pattern against trend/VWAP', n: 183 }, { market: 'crypto', bucket: 'momentum too low', n: 102 }];
    return [];
  };
  const store = { ...createMemoryStore(), query: async (sql) => ({ rows: rows(sql) }) };
  const h = await buildHealth({ tracker, store, state: { enabled: true, ready: true, holidays: [] }, now, env: { TELEGRAM_BOT_TOKEN: 'x', TELEGRAM_CHAT_ID: 'y' } });
  assert.equal(h.cryptoHeartbeat.crypto.verdict, 'scanning-no-signal');
  assert.equal(h.cryptoHeartbeat.crypto.lastTradeHoursAgo, 14); // 14h exactly
  assert.deepEqual(h.cryptoHeartbeat.crypto.topRejections, ['pattern against trend/VWAP x183', 'momentum too low x102']);
  assert.ok(h.degraded.some((d) => /crypto crypto: no trade for 14h/.test(d))); // 14 >= 12
  assert.ok(!h.degraded.some((d) => /crypto_scalp: no trade/.test(d))); // 1h < 12
});
