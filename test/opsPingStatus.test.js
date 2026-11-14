'use strict';
// Overnight item 4: GET /api/paper/ping gets a short status line (ALIVE/PROBLEM/disabled), no secrets,
// no database read (it is hit every 5 minutes by the free Render pinger and must stay cheap).
const test = require('node:test');
const assert = require('node:assert/strict');
const { attachPaperBot } = require('../paperbot');
const { JOB_NAMES, STALE_MS } = require('../src/paper/ops/health');

function mountPing(env) {
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  const state = attachPaperBot({ app, cron: { schedule() {} }, axios: {}, deps: {}, env, log: () => {}, wakeDelayMs: 2 ** 30 });
  let body;
  const res = { set() { return this; }, json(b) { body = b; } };
  return { ping: () => { routes['/api/paper/ping']({}, res); return body; }, state };
}

test('bot disabled: status "disabled", never claims ALIVE', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'false' });
  const body = ping();
  assert.equal(body.status, 'disabled');
});

test('bot enabled but no job has scanned yet: status PROBLEM (never a false ALIVE on a fresh boot)', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'true' });
  const body = ping();
  assert.equal(body.status, 'PROBLEM');
});

test('every job freshly scanned: status ALIVE', () => {
  const { ping, state } = mountPing({ PAPER_BOT_ENABLED: 'true' });
  const { defaultTracker } = require('../src/paper/ops/health');
  for (const name of JOB_NAMES) defaultTracker().recordRun(name, true);
  const body = ping();
  assert.equal(body.status, 'ALIVE');
});

test('ping never leaks the secret or a stack trace', () => {
  const { ping } = mountPing({ PAPER_BOT_ENABLED: 'true', PAPER_ADMIN_SECRET: 'super-secret-value' });
  const body = ping();
  assert.equal(JSON.stringify(body).includes('super-secret-value'), false);
  assert.equal('error' in body, false);
});
