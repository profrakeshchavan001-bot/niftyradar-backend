'use strict';
// Wiring for GET /api/paper/bots-report (src/paper/bots/leaderboard/register.js): auth, JSON shape, graceful when a bot's table/store
// is not there yet. No web framework needed: a tiny fake app/response, same pattern as test/paperScalp.test.js's wiring tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('../src/paper/bots/leaderboard/register');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { createMemoryStore } = require('../paperbot/store');

function fakeApp() { const routes = {}; return { routes, get: (path, handler) => { routes[path] = handler; } }; }
async function call(app, path, { query = {}, headers = {} } = {}) {
  const out = { status: 200, headers: {}, body: null, type: null };
  const res = {
    set(h, v) { if (typeof h === 'object') Object.assign(out.headers, h); else out.headers[h] = v; return this; },
    status(n) { out.status = n; return this; }, type(t) { out.type = t; return this; },
    send(b) { out.body = b; return this; }, json(b) { out.type = 'json'; out.body = JSON.stringify(b); return this; },
  };
  await app.routes[path]({ query, get: (h) => headers[h.toLowerCase()] }, res);
  return out;
}

test('plugin: auto-discovered under bots/leaderboard', () => {
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'bots' && p.name === 'leaderboard'));
});

test('wiring: behind the secret; JSON has every known bot even with nothing stored yet (empty, never a crash)', async () => {
  const app = fakeApp();
  const store = createMemoryStore();
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store });
  assert.equal((await call(app, '/api/paper/bots-report')).status, 401);
  assert.equal((await call(app, '/api/paper/bots-report', { query: { key: 'wrong' } })).status, 401);
  const r = await call(app, '/api/paper/bots-report', { query: { key: 's3cret', format: 'json' } });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.deepEqual(Object.keys(d.stats).sort(), ['exhaustion_only', 'intraday', 'scalp', 'scalp_wide', 'trend_smc'].sort());
  for (const bot of Object.keys(d.stats)) assert.deepEqual([d.stats[bot].trades, d.stats[bot].ranked], [0, false]);
  assert.equal(d.daily.length, 0);
});

test('wiring: scalp and exhaustion_only trades are read from their own stores and show up in the right row, not mixed up', async () => {
  const app = fakeApp();
  const store = createMemoryStore();
  await store.insertTrade({ market: 'crypto_scalp', strategy: 'scalp', symbol: 'BTCUSDT', trade_date: '2026-11-15', status: 'closed', pnl_inr: 100, entry_time: '2026-11-15T05:00:00Z', exit_time: '2026-11-15T05:10:00Z' });
  const exhaustionMemoryStore = { closedTrades: async () => [{ symbol: 'ETHUSDT', status: 'closed', pnl_inr: 50, entry_time: '2026-11-15T05:00:00Z', exit_time: '2026-11-15T05:05:00Z' }] };
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store, exhaustionMemoryStore });
  const d = JSON.parse((await call(app, '/api/paper/bots-report', { query: { key: 's3cret', format: 'json' } })).body);
  assert.equal(d.stats.scalp.trades, 1); assert.equal(d.stats.scalp.netPnlInr, 100);
  assert.equal(d.stats.exhaustion_only.trades, 1); assert.equal(d.stats.exhaustion_only.netPnlInr, 50);
  assert.equal(d.stats.scalp_wide.trades, 0); assert.equal(d.stats.intraday.trades, 0);
  assert.match((await call(app, '/api/paper/bots-report', { query: { key: 's3cret' } })).body, /NiftyRadar PAPER bots: leaderboard/);
});

test('wiring: no PAPER_ADMIN_SECRET -> 503, same convention as every other report route', async () => {
  const app = fakeApp();
  await register.register({ app, env: {}, log: () => {}, store: createMemoryStore() });
  assert.equal((await call(app, '/api/paper/bots-report')).status, 503);
});
