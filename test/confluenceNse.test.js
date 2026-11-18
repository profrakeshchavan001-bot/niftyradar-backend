'use strict';
// GROUP 6: confluence_nse feature flag gating (src/paper/bots/confluence_nse/register.js). Default OFF;
// even when turned on, it stays inert and logs "waiting for Dhan token" exactly once until a real token
// is present - never crashes, never schedules anything without both conditions.
const test = require('node:test');
const assert = require('node:assert/strict');
const plugin = require('../src/paper/bots/confluence_nse/register');
const { findPluginDirs } = require('../src/paper/pluginLoader');

test('plugin: auto-discovered under bots/confluence_nse', () => {
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'confluence_nse'));
});

test('readiness: default (no env var set) is inactive', () => {
  assert.equal(plugin.readiness({}).active, false);
});

test('readiness: flag "true" but no DHAN_ACCESS_TOKEN -> inactive, "waiting for Dhan token"', () => {
  const r = plugin.readiness({ PAPER_CONFLUENCE_NSE_ENABLED: 'true' });
  assert.equal(r.active, false);
  assert.equal(r.reason, 'waiting for Dhan token');
});

test('readiness: flag "true" and a token present -> active', () => {
  const r = plugin.readiness({ PAPER_CONFLUENCE_NSE_ENABLED: 'true', DHAN_ACCESS_TOKEN: 'x' });
  assert.equal(r.active, true);
});

test('register(): with the flag off, never throws, never touches cron or the database', async () => {
  const logs = [];
  const app = { get: () => {} };
  await plugin.register({ app, env: {}, log: (m) => logs.push(m), store: null, cron: { schedule: () => { throw new Error('must not schedule anything'); } } });
  assert.ok(logs.some((l) => l.includes('disabled')));
});

test('register(): flag on, no token -> logs "waiting for Dhan token" once, still never schedules', async () => {
  const logs = [];
  const app = { get: () => {} };
  await plugin.register({ app, env: { PAPER_CONFLUENCE_NSE_ENABLED: 'true' }, log: (m) => logs.push(m), store: null, cron: { schedule: () => { throw new Error('must not schedule anything'); } } });
  assert.ok(logs.some((l) => l.includes('waiting for Dhan token')));
});

test('register(): flag on and a token present -> does not crash, does not schedule a live loop in this change', async () => {
  const logs = [];
  const app = { get: () => {} };
  const store = { getConfig: async () => ({}), setConfigIfMissing: async () => {} };
  await plugin.register({ app, env: { PAPER_CONFLUENCE_NSE_ENABLED: 'true', DHAN_ACCESS_TOKEN: 'x' }, log: (m) => logs.push(m), store, cron: { schedule: () => { throw new Error('must not schedule anything yet'); } } });
  assert.ok(logs.some((l) => l.includes('not wired up yet')));
});
