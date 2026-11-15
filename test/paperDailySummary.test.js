'use strict';
// Task Group E: GET /api/paper/daily-summary (src/paper/ops/dailySummary/). Same fake-app wiring pattern as
// test/paperLeaderboardWiring.test.js: no real Express needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const register = require('../src/paper/ops/dailySummary/register');
const { buildDailySummary, resolveDate } = require('../src/paper/ops/dailySummary/report');
const { findPluginDirs } = require('../src/paper/pluginLoader');
const { createMemoryStore } = require('../paperbot/store');
const { categorize } = require('../src/paper/decision/filterStrictness');

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

const DATE = '2026-11-14'; // a Saturday, deliberately NOT "today" in these tests

/** Seeds one taken trade (closed, with P&L), one still-open trade, and a handful of skipped candidates
 * (some sharing the same category so the top-5-reasons tally has something to rank) for DATE. */
async function seedDay(store) {
  await store.insertTrade({
    market: 'nse', symbol: 'RELIANCE', trade_date: DATE, status: 'closed', direction: 'long',
    entry_price: 100, target_price: 110, sl_price: 95, exit_price: 110, exit_reason: 'target', pnl_inr: 500,
    entry_time: `${DATE}T05:00:00Z`, exit_time: `${DATE}T06:00:00Z`,
  });
  await store.insertTrade({
    market: 'crypto', symbol: 'BTCUSDT', trade_date: DATE, status: 'open', direction: 'long',
    entry_price: 50000, target_price: 52000, sl_price: 49000,
    entry_time: `${DATE}T07:00:00Z`,
  });
  // 3 skips categorised as take_threshold (most common), 2 as news_block, 1 as no_pattern - top 5 should
  // rank take_threshold first, news_block second, no_pattern third.
  for (let i = 0; i < 3; i += 1) await store.insertSkip({ market: 'nse', symbol: `S${i}`, skip_date: DATE, reason: 'judge 42 < 65' });
  for (let i = 0; i < 2; i += 1) await store.insertSkip({ market: 'crypto', symbol: `N${i}`, skip_date: DATE, reason: 'news filter: earnings today' });
  await store.insertSkip({ market: 'nse', symbol: 'P0', skip_date: DATE, reason: 'no pattern' });
  // one skip on a DIFFERENT day must never leak into this day's bucket
  await store.insertSkip({ market: 'nse', symbol: 'OTHER', skip_date: '2026-11-13', reason: 'no pattern' });
  // one trade on a different day must never leak into this day's bucket either
  await store.insertTrade({ market: 'nse', symbol: 'OTHERDAY', trade_date: '2026-11-13', status: 'closed', pnl_inr: 999, entry_time: '2026-11-13T05:00:00Z' });
}

test('plugin: auto-discovered under ops/daily-summary', () => {
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'ops' && p.name === 'dailySummary'));
});

test('resolveDate: defaults to today IST, rejects a malformed date, passes through a valid one', () => {
  assert.match(resolveDate(undefined), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(resolveDate('2026-01-05'), '2026-01-05');
  assert.throws(() => resolveDate('not-a-date'), /bad date/);
  assert.throws(() => resolveDate('2026/01/05'), /bad date/);
});

test('wiring: 401 without a key, 200 with the right one', async () => {
  const app = fakeApp();
  const store = createMemoryStore();
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store });
  assert.equal((await call(app, '/api/paper/daily-summary')).status, 401);
  assert.equal((await call(app, '/api/paper/daily-summary', { query: { key: 'wrong' } })).status, 401);
  assert.equal((await call(app, '/api/paper/daily-summary', { query: { key: 's3cret' } })).status, 200);
});

test('wiring: no PAPER_ADMIN_SECRET -> 503, same convention as every other report route', async () => {
  const app = fakeApp();
  await register.register({ app, env: {}, log: () => {}, store: createMemoryStore() });
  assert.equal((await call(app, '/api/paper/daily-summary')).status, 503);
});

test('wiring: a malformed ?date= is rejected with 400, not a crash', async () => {
  const app = fakeApp();
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store: createMemoryStore() });
  const r = await call(app, '/api/paper/daily-summary', { query: { key: 's3cret', date: 'nonsense' } });
  assert.equal(r.status, 400);
});

test('wiring: x-paper-secret header also works (same convention as every other route)', async () => {
  const app = fakeApp();
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store: createMemoryStore() });
  const r = await call(app, '/api/paper/daily-summary', { headers: { 'x-paper-secret': 's3cret' } });
  assert.equal(r.status, 200);
});

test('buildDailySummary: correct taken/open/closed bucketing and total P&L for the given date, nothing from other days leaks in', async () => {
  const store = createMemoryStore();
  await seedDay(store);
  const d = await buildDailySummary({ store, date: DATE });
  assert.equal(d.date, DATE);
  assert.equal(d.isToday, false);
  assert.equal(d.takenCount, 2); // RELIANCE + BTCUSDT, not OTHERDAY
  assert.equal(d.closedCount, 1);
  assert.equal(d.openCount, 1);
  assert.equal(d.open[0].symbol, 'BTCUSDT');
  assert.equal(d.wins, 1);
  assert.equal(d.losses, 0);
  assert.equal(d.totalPnlInr, 500); // after-costs pnl_inr convention (src/paper/bots/leaderboard/stats.js netOf)
  assert.equal(d.skipsCount, 6); // 3 + 2 + 1, not the 2026-11-13 one
  assert.ok(d.taken.every((t) => t.trade_date === DATE));
  assert.ok(d.skips.every((s) => s.skip_date === DATE));
});

test('buildDailySummary: top-5 skip reasons match filterStrictness categorization, ranked by count', async () => {
  const store = createMemoryStore();
  await seedDay(store);
  const d = await buildDailySummary({ store, date: DATE });
  assert.ok(d.topSkipReasons.length <= 5);
  assert.equal(d.topSkipReasons[0].key, categorize('judge 42 < 65'));
  assert.equal(d.topSkipReasons[0].count, 3);
  assert.equal(d.topSkipReasons[1].key, categorize('news filter: earnings today'));
  assert.equal(d.topSkipReasons[1].count, 2);
  assert.equal(d.topSkipReasons[2].key, categorize('no pattern'));
  assert.equal(d.topSkipReasons[2].count, 1);
});

test('buildDailySummary: a day with nothing at all is empty, not a crash or a guessed number', async () => {
  const store = createMemoryStore();
  const d = await buildDailySummary({ store, date: '2099-01-01' });
  assert.deepEqual([d.takenCount, d.openCount, d.closedCount, d.skipsCount, d.totalPnlInr], [0, 0, 0, 0, 0]);
  assert.deepEqual(d.topSkipReasons, []);
});

test('wiring: JSON response round-trips the same bucketing as buildDailySummary directly', async () => {
  const app = fakeApp();
  const store = createMemoryStore();
  await seedDay(store);
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store });
  const r = await call(app, '/api/paper/daily-summary', { query: { key: 's3cret', date: DATE, format: 'json' } });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.takenCount, 2);
  assert.equal(d.totalPnlInr, 500);
  assert.equal(d.topSkipReasons[0].count, 3);
});

test('wiring: HTML response renders without a crash and names the route\'s own page', async () => {
  const app = fakeApp();
  const store = createMemoryStore();
  await seedDay(store);
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store });
  const r = await call(app, '/api/paper/daily-summary', { query: { key: 's3cret', date: DATE } });
  assert.equal(r.status, 200);
  assert.match(r.body, /daily summary/i);
  assert.match(r.body, /RELIANCE/);
  assert.match(r.body, /BTCUSDT/);
});
