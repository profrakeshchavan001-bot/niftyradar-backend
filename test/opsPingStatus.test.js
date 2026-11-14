'use strict';
// Round 3 item 2: GET /api/paper/ping gets ALIVE/DEGRADED/PROBLEM + a reason string, no secrets, no
// database read (hit every 5 minutes by the free Render pinger, must stay cheap). Date.now() is mocked
// so NSE-open/closed is deterministic, not whatever day this test happens to run on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPaperBot } = require('../paperbot');
const { JOB_NAMES, defaultTracker } = require('../src/paper/ops/health');

const MARKET_OPEN = Date.UTC(2026, 10, 13, 5, 0); // Fri 13 Nov 2026 10:30 IST - NSE open
const WEEKEND = Date.UTC(2026, 10, 14, 20, 0); // Sat 14 Nov 2026 01:30 IST (Sunday) - NSE closed

function mountPing(env) {
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  const state = attachPaperBot({ app, cron: { schedule() {} }, axios: {}, deps: {}, env, log: () => {}, wakeDelayMs: 2 ** 30 });
  let body;
  const res = { set() { return this; }, json(b) { body = b; } };
  return { ping: () => { routes['/api/paper/ping']({}, res); return body; }, state };
}

function withClock(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try { return fn(); } finally { Date.now = real; }
}

test('bot disabled: status PROBLEM, reason names it, never claims ALIVE', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'false' });
  const body = withClock(MARKET_OPEN, ping);
  assert.equal(body.status, 'PROBLEM');
  assert.match(body.reason, /disabled/);
});

test('bot enabled but no job has scanned yet, market open: status PROBLEM (never a false ALIVE on a fresh boot)', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'true' });
  const body = withClock(MARKET_OPEN, ping);
  assert.equal(body.status, 'PROBLEM');
  assert.match(body.reason, /no scan in 15\+ min/);
});

test('every job freshly scanned, market open: status ALIVE', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'true' });
  withClock(MARKET_OPEN, () => { for (const name of JOB_NAMES) defaultTracker().recordRun(name, true); });
  const body = withClock(MARKET_OPEN, ping);
  assert.equal(body.status, 'ALIVE');
});

test('crypto jobs fresh but NSE idle on the weekend: status DEGRADED, not PROBLEM (the 02:40 IST false alarm this fixes)', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'true' });
  withClock(WEEKEND, () => { for (const name of JOB_NAMES) defaultTracker().recordRun(name, true); });
  const body = withClock(WEEKEND, ping);
  assert.equal(body.status, 'DEGRADED');
  assert.match(body.reason, /NSE closed/);
  assert.equal(body.insideMarketHours, false);
});

test('nse jobs stale on a weekend do not count as stale at all (never listed as "no scan in 15+ min")', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'true' });
  // nse jobs last ran long before WEEKEND (whatever an earlier test left behind, or never) - fine either
  // way, because NSE is closed right now; only crypto is refreshed so the DEGRADED-not-PROBLEM check holds.
  withClock(WEEKEND, () => { defaultTracker().recordRun('cryptoScan', true); defaultTracker().recordRun('cryptoMonitor', true); });
  const body = withClock(WEEKEND, ping);
  assert.equal(body.status, 'DEGRADED');
  assert.doesNotMatch(body.reason, /no scan in 15\+ min/);
});

test('ping never leaks the secret or a stack trace', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'true', PAPER_ADMIN_SECRET: 'super-secret-value' });
  const body = withClock(MARKET_OPEN, ping);
  assert.equal(JSON.stringify(body).includes('super-secret-value'), false);
  assert.equal('error' in body, false);
});
