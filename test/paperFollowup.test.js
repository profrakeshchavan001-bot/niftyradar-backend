'use strict';
// Follow-up: real R factor, separate database with in-memory fallback, keep-alive ping.
// Expected numbers are worked out by hand in the comments.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../paperbot/rfactor');
const { createMemoryStore, createCachedStore } = require('../paperbot/store');
const { createReporter } = require('../paperbot/report');
const { loadConfig } = require('../paperbot/config');
const { attachPaperBot, buildStore, pgOptions } = require('../paperbot');

// 20 quiet 15-min candles: high 102, low 100, close 101 -> every true range is 2.
const quiet = () => Array.from({ length: 20 }, (_, i) => ({ t: i * 900000, o: 101, h: 102, l: 100, c: 101, v: 100 }));
const withLevels = (edit) => { const c = quiet(); edit(c); return c; };

test('R factor, long side best: stop at the swing low, target at the swing high', () => {
  // swing low 97 (candle 8), swing high 106 (candle 12).
  // ATR14 = last 14 true ranges = 12 x 2 + 5 (candle 8: 102 - 97) + 6 (candle 12: 106 - 100) = 35 / 14 = 2.5
  const c15 = withLevels((c) => { c[8].l = 97; c[12].h = 106; });
  const r = R.rFactor({ entry: 101, c15 });
  assert.equal(r.atr15, 2.5);
  // long: stop = max(2.5, 101 - 97 = 4) = 4; target = 106 - 101 = 5 (under the cap 7.5); R = 5 / 4 = 1.25
  assert.deepEqual(r.long, { stop: 4, target: 5, r: 1.25, stopBasis: 'swing', targetBasis: 'level' });
  // short: stop = max(2.5, 106 - 101 = 5) = 5; target = 101 - 97 = 4; R = 4 / 5 = 0.8
  assert.deepEqual(r.short, { stop: 5, target: 4, r: 0.8, stopBasis: 'swing', targetBasis: 'level' });
  assert.equal(r.r, 1.25);
  assert.equal(r.direction, 'up');
});

test('R factor, short side best', () => {
  // swing high 104 (candle 8), swing low 95 (candle 12). ATR14 = (12 x 2 + 4 + 7) / 14 = 2.5
  const r = R.rFactor({ entry: 101, c15: withLevels((c) => { c[8].h = 104; c[12].l = 95; }) });
  // short: stop = max(2.5, 104 - 101 = 3) = 3; target = 101 - 95 = 6 (cap 7.5); R = 2
  assert.deepEqual(r.short, { stop: 3, target: 6, r: 2, stopBasis: 'swing', targetBasis: 'level' });
  // long: stop = max(2.5, 101 - 95 = 6) = 6; target = 104 - 101 = 3; R = 0.5
  assert.equal(r.long.r, 0.5);
  assert.equal(r.direction, 'down');
  assert.equal(r.r, 2);
});

test('R factor, no swing level: stop 1 x ATR, target 2 x ATR -> R = 2', () => {
  const r = R.rFactor({ entry: 101, c15: quiet() }); // ATR14 = 2, no swing points (all highs and lows equal)
  assert.deepEqual(r.long, { stop: 2, target: 4, r: 2, stopBasis: 'atr', targetBasis: 'no level, 2 x ATR' });
  assert.deepEqual(r.short, { stop: 2, target: 4, r: 2, stopBasis: 'atr', targetBasis: 'no level, 2 x ATR' });
});

test('R factor: previous-day high / low count as levels; far targets are capped at 3 x ATR', () => {
  const c15 = withLevels((c) => { c[8].l = 97; c[12].h = 106; });
  // previous-day high 103 is nearer than the swing high 106: long target = 2, R = 2 / 4 = 0.5
  // previous-day low 99.5 is nearer than the swing low 97: short target = 1.5, R = 1.5 / 5 = 0.3
  const r = R.rFactor({ entry: 101, c15, prevDay: { high: 103, low: 99.5 } });
  assert.equal(r.long.r, 0.5);
  assert.equal(r.short.r, 0.3);
  // swing high far away at 120: ATR14 = (24 + 5 + 20) / 14 = 3.5; long stop = max(3.5, 4) = 4;
  // target 19 is capped at 3 x 3.5 = 10.5; R = 10.5 / 4 = 2.625 -> 2.63
  const far = R.rFactor({ entry: 101, c15: withLevels((c) => { c[8].l = 97; c[12].h = 120; }) });
  assert.equal(far.atr15, 3.5);
  assert.equal(far.long.target, 10.5);
  assert.equal(far.long.targetBasis, 'capped at 3 x ATR');
  assert.equal(far.long.r, 2.63);
});

test('R factor: not enough candles or no price -> no value (never guessed)', () => {
  assert.equal(R.rFactor({ entry: 101, c15: quiet().slice(0, 14) }), null);
  assert.equal(R.rFactor({ entry: 0, c15: quiet() }), null);
});

test('previous-day levels come from the latest earlier IST day only', () => {
  const day = (d, h, l) => ({ t: Date.UTC(2026, 10, d, 5, 0), o: l, h, l, c: h, v: 1 });
  const lv = R.prevDayLevels([day(11, 130, 90), day(12, 110, 100), { ...day(12, 112, 101), t: Date.UTC(2026, 10, 12, 6, 0) }, day(13, 150, 80)], Date.UTC(2026, 10, 12, 18, 30));
  assert.deepEqual(lv, { date: '2026-11-12', high: 112, low: 100 });
  assert.equal(R.prevDayLevels([day(13, 150, 80)], Date.UTC(2026, 10, 12, 18, 30)), null);
});

test('legacy value and ranking: both kept side by side', () => {
  assert.equal(R.legacyRf(-2), 4.1); // 2 x 1.8 + 0.5
  const quotes = [{ symbol: 'A', pct: 3 }, { symbol: 'B', pct: -1 }, { symbol: 'C', pct: 2 }];
  assert.deepEqual(R.legacyOrderOf(quotes), ['A', 'C', 'B']);
  const rows = [{ symbol: 'A', pct: 3, r: { r: 0.8 } }, { symbol: 'B', pct: -1, r: { r: 2.5 } }, { symbol: 'C', pct: 2, r: { r: 1.2 } }];
  const top = R.rankByR(rows, 2, R.legacyOrderOf(quotes));
  // by R: B (2.5), C (1.2); by the old size-of-move order B was last (3rd) and C 2nd
  assert.deepEqual(top.map((x) => [x.symbol, x.rFactor, x.rRank, x.legacyRf, x.legacyRank]), [['B', 2.5, 1, 2.3, 3], ['C', 1.2, 2, 4.1, 2]]);
});

test('separate database: PAPER_DATABASE_URL only, DATABASE_URL is never read', async () => {
  const logs = [];
  // a getter that fails the test if the bot ever touches DATABASE_URL
  const env = { get DATABASE_URL() { throw new Error('the bot must not read DATABASE_URL'); }, TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '9' };
  const store = buildStore(env, (m) => logs.push(m));
  assert.equal(store.kind, 'memory');
  assert.match(logs[0], /PAPER_DATABASE_URL is not set/);
  // in-memory fallback still sends the Telegram summary
  const sent = [];
  const axios = { post: async (url, body) => { sent.push(body.text); } };
  const now = () => Date.UTC(2026, 10, 13, 10, 15);
  const r = await createReporter({ store, axios, env, now, log: () => {}, loadConfig }).daily('nse');
  assert.equal(r.telegram_sent, true);
  assert.match(sent[0], /NSE summary 2026-11-13/);
  assert.equal((await store.listSummaries(5))[0].telegram_sent, true);
  // with the variable set a Postgres store is built, and nothing connects until the first query (lazy)
  const pg = buildStore({ PAPER_DATABASE_URL: 'postgres://u:p@db.example.invalid:5432/postgres' }, () => {});
  assert.equal(pg.kind, 'postgres');
});

test('summary still goes to Telegram when the database cannot store it', async () => {
  const store = createMemoryStore();
  store.saveSummary = async () => { throw new Error('db down'); };
  const sent = [];
  const r = await createReporter({ store, axios: { post: async (u, b) => { sent.push(b.text); } }, env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '9' }, now: () => Date.UTC(2026, 10, 13, 10, 15), log: () => {}, loadConfig }).daily('nse');
  assert.equal(r.telegram_sent, true);
  assert.equal(sent.length, 1);
});

test('database options: SSL on for remote hosts (Supabase direct or pooler), pool of 2', () => {
  const direct = pgOptions('postgresql://postgres:pw@db.abcd.supabase.co:5432/postgres?sslmode=require');
  assert.equal(direct.max, 2);
  assert.deepEqual(direct.ssl, { rejectUnauthorized: false });
  assert.ok(!direct.connectionString.includes('sslmode')); // so the URL cannot override the ssl setting
  assert.match(direct.connectionString, /db\.abcd\.supabase\.co:5432\/postgres/);
  const pooler = pgOptions('postgresql://postgres.abcd:p%40w@aws-0-ap-south-1.pooler.supabase.com:6543/postgres');
  assert.deepEqual(pooler.ssl, { rejectUnauthorized: false });
  assert.match(pooler.connectionString, /p%40w@aws-0-ap-south-1\.pooler\.supabase\.com:6543/);
  assert.equal(pgOptions('postgres://postgres@127.0.0.1:5432/paper_test').ssl, false);
});

test('no polling: the cache answers repeat reads without touching the database', async () => {
  const inner = createMemoryStore();
  const calls = {};
  for (const k of ['getConfig', 'openTrades', 'tradesForDay', 'updateTrade', 'insertTrade']) {
    const orig = inner[k].bind(inner);
    inner[k] = async (...a) => { calls[k] = (calls[k] || 0) + 1; return orig(...a); };
  }
  let clock = 0;
  const store = createCachedStore(inner, { now: () => clock });
  const trade = { market: 'nse', symbol: 'X', trade_date: '2026-11-13', patterns: [], qty: 1, entry_price: 10, basis: 'b' };
  for (let i = 0; i < 30; i++) { await store.getConfig(); await store.openTrades('nse'); await store.tradesForDay('nse', '2026-11-13'); }
  assert.deepEqual([calls.getConfig, calls.openTrades, calls.tradesForDay], [1, 1, 1]);
  const id = await store.insertTrade(trade);
  assert.equal((await store.openTrades('nse')).length, 1);
  assert.equal((await store.tradesForDay('nse', '2026-11-13')).length, 1);
  await store.noteTrade(id, { max_fav_pct: 4 }); // memory only
  assert.equal(calls.updateTrade, undefined);
  assert.equal((await store.openTrades('nse'))[0].max_fav_pct, 4);
  await store.updateTrade(id, { status: 'closed', pnl_inr: 5 });
  assert.equal((await store.openTrades('nse')).length, 0);
  assert.equal((await store.tradesForDay('nse', '2026-11-13'))[0].status, 'closed');
  assert.deepEqual([calls.openTrades, calls.tradesForDay], [1, 1]); // still only the first read
  clock = 11 * 60000; // config is re-read after 10 minutes
  await store.getConfig();
  assert.equal(calls.getConfig, 2);
});

test('GET /api/paper/ping: no auth, no database, IST time and market-hours flag', () => {
  const routes = {};
  const app = { get: (p, h) => { routes[p] = h; } };
  const env = { get DATABASE_URL() { throw new Error('must not be read'); }, PAPER_BOT_ENABLED: 'false' };
  attachPaperBot({ app, cron: { schedule() {} }, axios: {}, deps: {}, env, log: () => {} });
  let body;
  const res = { set() { return this; }, json(b) { body = b; } };
  const real = Date.now;
  try {
    Date.now = () => Date.UTC(2026, 10, 13, 5, 0); // Fri 13 Nov 2026 10:30 IST
    routes['/api/paper/ping']({}, res);
    assert.deepEqual([body.ok, body.istDate, body.istTime, body.insideMarketHours, body.botEnabled], [true, '2026-11-13', '10:30', true, false]);
    Date.now = () => Date.UTC(2026, 10, 14, 5, 0); // Saturday
    routes['/api/paper/ping']({}, res);
    assert.equal(body.insideMarketHours, false);
    assert.equal(body.marketNote, 'weekend');
  } finally { Date.now = real; }
});
