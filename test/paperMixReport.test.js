'use strict';
// Task Group C ("best-of mix" report, docs/decisions/*.md): GET /api/paper/mix-report now also carries a per-bot scoreboard
// (reusing leaderboard/stats.js's computeBotStats, now with avgRFactor + tradesPerDay added) and a descriptive-only "mix
// candidate" analysis (src/paper/bots/mix/stats.js buildMixCandidate). Hand-worked numbers, not copied from the function's own
// output. Read-only, report-only: nothing here changes a live filter, threshold or bot, and no new engine is built or wired.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeBotStats } = require('../src/paper/bots/leaderboard/stats');
const { buildMixCandidate } = require('../src/paper/bots/mix/stats');
const register = require('../src/paper/bots/mix/register');
const { createMemoryStore } = require('../paperbot/store');

// ---------- avgRFactor / tradesPerDay, computeBotStats, for 2 bots (scalp-style `r_factor`, exhaustion_only-style `rr`) ----------

// scalp: r_factor 2, 1.0, 1.5 -> avg (2+1.0+1.5)/3 = 1.5; 3 trades over 2 distinct trade_date days -> 3/2 = 1.5/day
test('computeBotStats: avgRFactor and tradesPerDay, scalp-style trades carrying r_factor + trade_date', () => {
  const closed = [
    { pnl_inr: 100, r_factor: 2, trade_date: '2026-11-10' },
    { pnl_inr: -50, r_factor: 1.0, trade_date: '2026-11-10' },
    { pnl_inr: 80, r_factor: 1.5, trade_date: '2026-11-11' },
  ];
  const s = computeBotStats(closed);
  assert.equal(s.avgRFactor, 1.5);
  assert.equal(s.tradesPerDay, 1.5);
});

// exhaustion_only: rr 1.8, 1.3 -> avg 1.55; 2 trades over 2 distinct days -> 1.0/day
test('computeBotStats: avgRFactor and tradesPerDay, exhaustion_only-style trades carrying rr + trade_date', () => {
  const closed = [
    { pnl_inr: 60, rr: 1.8, trade_date: '2026-11-10' },
    { pnl_inr: 40, rr: 1.3, trade_date: '2026-11-12' },
  ];
  const s = computeBotStats(closed);
  assert.equal(s.avgRFactor, 1.55);
  assert.equal(s.tradesPerDay, 1.0);
});

test('computeBotStats: no R value and no date on any trade -> avgRFactor/tradesPerDay are null, never NaN or a crash', () => {
  const s = computeBotStats([{ pnl_inr: 10 }]);
  assert.equal(s.avgRFactor, null);
  assert.equal(s.tradesPerDay, null);
});

// ---------- mix-candidate analysis shape ----------

// 5 trend_smc trades: top 3 by net P&L are the "best slice" (fraction 0.3 of 5 rounds up to 2, floored at minCount 3).
// t1/t2 share "order block" + "discount zone"; t3 is an EMA cross in the premium zone; t4/t5 are losers, excluded from "best".
// best avg R = (2.5+2.2+1.8)/3 = 2.1667 -> 2.17; all avg R = (2.5+2.2+1.8+1.6+1.5)/5 = 1.92
test('buildMixCandidate: best-performing trades share a tag; avg R of the best slice vs all trades, hand-worked', () => {
  const closed = {
    trend_smc: [
      { pnl_inr: 100, rr: 2.5, basis: 'trend_smc LONG: order block retest with the up trend, price in the discount zone.' },
      { pnl_inr: 90, rr: 2.2, basis: 'trend_smc LONG: order block retest with the up trend, price in the discount zone.' },
      { pnl_inr: 80, rr: 1.8, basis: 'trend_smc SHORT: fresh EMA9/21 cross with the down trend, price in the premium zone.' },
      { pnl_inr: -20, rr: 1.6, basis: 'trend_smc LONG: order block retest with the up trend, price in the discount zone.' },
      { pnl_inr: -40, rr: 1.5, basis: 'trend_smc SHORT: fresh EMA9/21 cross with the down trend, price in the premium zone.' },
    ],
  };
  const mix = buildMixCandidate(closed);
  // shape: perBot per bot name, description array, strongest candidate (or null)
  assert.ok(mix.perBot.trend_smc);
  assert.ok(Array.isArray(mix.description));
  const m = mix.perBot.trend_smc;
  assert.deepEqual([m.totalClosed, m.bestCount], [5, 3]);
  assert.equal(m.avgRFactorBest, 2.17);
  assert.equal(m.avgRFactorAll, 1.92);
  assert.equal(m.knownMinRr, 1.5); // trend_smc's own static reward/risk floor, read-only
  assert.equal(m.topTagsInBestTrades[0].tag, 'order_block');
  assert.equal(m.topTagsInBestTrades[0].bestSharePct, 66.7);
  assert.equal(m.topTagsInBestTrades[0].allSharePct, 60);
  assert.ok(mix.description.some((l) => l.includes('trend_smc')));
  assert.equal(mix.strongest.bot, 'trend_smc');
  assert.equal(mix.strongest.tag, 'order_block');
});

test('buildMixCandidate: a bot with no winning trades yet gets no "best" slice and no crash', () => {
  const mix = buildMixCandidate({ scalp: [{ pnl_inr: -10, basis: 'x' }, { pnl_inr: -5, basis: 'y' }] });
  assert.equal(mix.perBot.scalp.bestCount, 0);
  assert.equal(mix.strongest, null);
  assert.ok(mix.description[0].includes('not enough winning trades'));
});

// ---------- route wiring: 200 with valid key, 401 without, scoreboard + mixCandidate + shadows in the JSON ----------
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

test('wiring: GET /api/paper/mix-report is 401 with no key, 200 with the right key', async () => {
  const app = fakeApp();
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store: createMemoryStore() });
  assert.equal((await call(app, '/api/paper/mix-report')).status, 401);
  assert.equal((await call(app, '/api/paper/mix-report', { query: { key: 'wrong' } })).status, 401);
  const r = await call(app, '/api/paper/mix-report', { query: { key: 's3cret', format: 'json' } });
  assert.equal(r.status, 200);
});

test('wiring: JSON carries scoreboard (every known bot) and a mixCandidate shape; paper_shadows missing degrades gracefully, not a crash', async () => {
  const app = fakeApp();
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store: createMemoryStore(), pool: null });
  const r = await call(app, '/api/paper/mix-report', { query: { key: 's3cret', format: 'json' } });
  const d = JSON.parse(r.body);
  assert.deepEqual(Object.keys(d.scoreboard).sort(), [
    'exhaustion_only', 'intraday', 'scalp', 'scalp_wide', 'trend_smc',
    'exhaustion_only_mirror', 'trend_smc_mirror', 'scalp_mirror', 'scalp_wide_mirror',
  ].sort());
  assert.ok('avgRFactor' in d.scoreboard.scalp); assert.ok('tradesPerDay' in d.scoreboard.scalp);
  assert.ok(Array.isArray(d.mixCandidate.description));
  assert.equal(d.shadows.available, false); // no pool given -> degrades gracefully, section omitted-ish rather than erroring
  assert.equal(r.type, 'json');
});

test('wiring: no PAPER_ADMIN_SECRET -> 503, same convention as every other report route', async () => {
  const app = fakeApp();
  await register.register({ app, env: {}, log: () => {}, store: createMemoryStore() });
  assert.equal((await call(app, '/api/paper/mix-report')).status, 503);
});
