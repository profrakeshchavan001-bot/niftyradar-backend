'use strict';
// Group 1 (2026-11): Dhan token renewal retry-with-backoff + at-most-one-alert-per-day
// (src/lib/renewWithRetry.js). Every dependency injected (fake clock, fake sleep, fake renew/alert), no
// real network or timers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRenewRetrier } = require('../src/lib/renewWithRetry');

function fakeClock(startDateKey = '2026-11-18') {
  let dateKey = startDateKey;
  return { dateKeyOf: () => dateKey, now: () => null, advanceDay: (k) => { dateKey = k; } };
}

test('success on the first try: no retry, no alert', async () => {
  const calls = [];
  const alerts = [];
  const sleeps = [];
  const { renewWithRetry } = createRenewRetrier({
    renewFn: async () => { calls.push(1); return { ok: true }; },
    sendAlert: async (e) => alerts.push(e),
    sleep: async (ms) => sleeps.push(ms),
    ...fakeClock(),
  });
  const r = await renewWithRetry();
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
  assert.equal(alerts.length, 0);
});

test('fails, then succeeds on a retry: no alert, backoff delay used before the retry', async () => {
  let n = 0;
  const sleeps = [];
  const alerts = [];
  const { renewWithRetry } = createRenewRetrier({
    renewFn: async () => { n += 1; return n < 2 ? { ok: false, error: 'network error' } : { ok: true }; },
    sendAlert: async (e) => alerts.push(e),
    sleep: async (ms) => sleeps.push(ms),
    delaysMs: [1000, 2000, 3000],
    ...fakeClock(),
  });
  const r = await renewWithRetry();
  assert.deepEqual(r, { ok: true });
  assert.equal(n, 2);
  assert.deepEqual(sleeps, [1000]); // only the one delay before the successful retry
  assert.equal(alerts.length, 0);
});

test('every attempt fails: exactly one alert, with the last error', async () => {
  const alerts = [];
  const sleeps = [];
  const { renewWithRetry } = createRenewRetrier({
    renewFn: async () => ({ ok: false, error: 'HTTP 500' }),
    sendAlert: async (e) => alerts.push(e),
    sleep: async (ms) => sleeps.push(ms),
    delaysMs: [1000, 2000],
    ...fakeClock(),
  });
  const r = await renewWithRetry();
  assert.deepEqual(r, { ok: false, error: 'HTTP 500' });
  assert.deepEqual(sleeps, [1000, 2000]); // 1 initial try + 2 retries = 3 attempts, 2 delays between them
  assert.deepEqual(alerts, ['HTTP 500']);
});

test('exactly one alert per day: a second exhausted run the SAME day sends nothing more', async () => {
  const alerts = [];
  const clock = fakeClock('2026-11-18');
  const { renewWithRetry } = createRenewRetrier({
    renewFn: async () => ({ ok: false, error: 'HTTP 500' }),
    sendAlert: async (e) => alerts.push(e),
    sleep: async () => {},
    delaysMs: [1000],
    ...clock,
  });
  await renewWithRetry();
  await renewWithRetry();
  await renewWithRetry();
  assert.equal(alerts.length, 1, 'never a second alert for the same day, no matter how many times renewal is exhausted that day');
});

test('a new IST day re-arms the alert: one failure alert per day, not per process lifetime', async () => {
  const alerts = [];
  const clock = fakeClock('2026-11-18');
  const { renewWithRetry } = createRenewRetrier({
    renewFn: async () => ({ ok: false, error: 'HTTP 500' }),
    sendAlert: async (e) => alerts.push(e),
    sleep: async () => {},
    delaysMs: [],
    ...clock,
  });
  await renewWithRetry();
  await renewWithRetry();
  assert.equal(alerts.length, 1);
  clock.advanceDay('2026-11-19');
  await renewWithRetry();
  assert.equal(alerts.length, 2, 'a new day gets its own alert');
});

test('a success between two failures the SAME day still sends only the one alert for that day', async () => {
  // A 6-hourly cron that recovers for one tick and then fails again later the same day must not be
  // alerted twice - "exactly one Telegram alert ... for the day" is a day-level verdict, not a
  // per-incident count.
  const alerts = [];
  let ok = false;
  const clock = fakeClock('2026-11-18');
  const { renewWithRetry } = createRenewRetrier({
    renewFn: async () => (ok ? { ok: true } : { ok: false, error: 'HTTP 500' }),
    sendAlert: async (e) => alerts.push(e),
    sleep: async () => {},
    delaysMs: [],
    ...clock,
  });
  await renewWithRetry(); // fails -> alert #1
  assert.equal(alerts.length, 1);
  ok = true;
  await renewWithRetry(); // succeeds -> no alert
  ok = false;
  await renewWithRetry(); // fails again, same day -> still no second alert
  assert.equal(alerts.length, 1);
});
