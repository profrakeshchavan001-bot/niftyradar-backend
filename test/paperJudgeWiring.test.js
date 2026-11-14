'use strict';
// The judge wired into the bot's NSE entry step (PAPER_JUDGE_ON). Same recorded candles as paperReplay.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBot } = require('../paperbot/bot');
const { createMemoryStore } = require('../paperbot/store');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'paper_replay.json'), 'utf8'));
const MIN = 60000; const FIVE = 5 * MIN;

function harness({ judgeOn, judgeHelpers, niftyTrend }) {
  const clock = { t: fx.nse.sessionStart };
  const store = createMemoryStore();
  const closedAt = () => fx.nse.candles.filter((k) => k.t + FIVE <= clock.t);
  const spotNow = () => closedAt().at(-1)?.c ?? null;
  const nse = {
    ranking: () => { const price = spotNow(); if (!price) return null; const volume = 1000000; return [{ symbol: 'TESTSTK', price, pct: -1.8, volume }, { symbol: 'AAA', price: 100, pct: 2.5, volume }, { symbol: 'BBB', price: 100, pct: -0.4, volume }, { symbol: 'CCC', price: 100, pct: 0.3, volume }, { symbol: 'DDD', price: 100, pct: 0.6, volume }, { symbol: 'THIN', price: 100, pct: -3, volume: 10 }]; },
    spot: (s) => (s === 'TESTSTK' ? spotNow() : null),
    candles: async (s) => ({ candles: s === 'TESTSTK' ? fx.nse.candles.filter((k) => k.t <= clock.t) : [], source: 'replay_fixture' }),
    optionQuote: async () => ({ ltp: 20, strike: 490, expiry: '2026-11-26', spot: spotNow() }),
    lotSize: () => 500,
    news: async () => [],
    ...(niftyTrend ? { niftyTrend: async () => niftyTrend } : {}),
  };
  const bot = createBot({ store, nse, crypto: null, now: () => clock.t, log: () => {}, judgeOn, judgeHelpers });
  async function runSession() {
    for (let m = 0; m <= 375; m++) { const base = fx.nse.sessionStart + m * MIN; if (m % 5 === 0) { clock.t = base + 20000; await bot.nseScan(); } clock.t = base + 50000; await bot.nseMonitor(); }
  }
  return { store, runSession };
}
const strong = { stockSectorView: async () => ({ sector: 'Energy', score: 80, label: 'STRONG', vsNifty: 1 }), newsScore: async () => 50, eventBlock: async () => ({ block: false }) };

test('judge on, good helpers: the trade is taken and the judge score + every helper\'s points are stored with it', async () => {
  const h = harness({ judgeOn: true, judgeHelpers: strong, niftyTrend: 'up' });
  await h.runSession();
  const t = h.store._db.trades[0];
  assert.ok(t, 'one trade');
  assert.equal(t.judge_take, true); assert.ok(t.judge_score >= 65 && t.judge_score <= 100);
  // R 3 -> 25 | sector 80/100 x 20 = 16 | news +50 -> 7.5 | Nifty up -> 10 | scanned 11:05 IST -> 10
  assert.deepEqual({ ...t.judge_contributions, pattern: 0 }, { r_factor: 25, pattern: 0, sector: 16, news: 7.5, market_trend: 10, time: 10 });
  assert.ok(t.judge_contributions.pattern > 0);
  assert.match(t.judge_basis, /^Taken: long scores/);
});

test('judge on, event block: no trade, and the skip says why in plain words', async () => {
  const h = harness({ judgeOn: true, judgeHelpers: { ...strong, eventBlock: async () => ({ block: true, reason: 'results due today' }) }, niftyTrend: 'up' });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  assert.ok(h.store._db.skips.some((s) => /^judge \d+(\.\d)?\/100: Not taken: event block: results due today/.test(s.reason)), JSON.stringify(h.store._db.skips.map((s) => s.reason)));
});

test('judge on, weak sector against the long: no trade (hard block)', async () => {
  const h = harness({ judgeOn: true, judgeHelpers: { ...strong, stockSectorView: async () => ({ sector: 'Metals', score: 15, label: 'WEAK', vsNifty: -2 }) }, niftyTrend: 'up' });
  await h.runSession();
  assert.equal(h.store._db.trades.length, 0);
  assert.ok(h.store._db.skips.some((s) => /sector block: Metals is weak/.test(s.reason)));
});

test('judge off (the default of createBot): trades carry no judge fields and nothing changes', async () => {
  const h = harness({ judgeOn: false, judgeHelpers: strong });
  await h.runSession();
  const t = h.store._db.trades[0];
  assert.ok(t); assert.equal(t.judge_score, undefined); assert.equal(t.judge_contributions, undefined);
});

test('judge on with no sector / news module on this branch and no Nifty source: half points for those helpers, the trade can still be taken', async () => {
  const h = harness({ judgeOn: true, judgeHelpers: { eventBlock: async () => ({ block: false }) } }); // only the event stub is given: sector / news / Nifty unavailable
  await h.runSession();
  const t = h.store._db.trades[0];
  assert.ok(t);
  assert.equal(t.judge_contributions.sector, 10); assert.equal(t.judge_contributions.news, 5); assert.equal(t.judge_contributions.market_trend, 5);
});

test('the Sunday job also stores the judge ablation report (its own summary), and applies nothing', async () => {
  const { createReporter } = require('../paperbot/report');
  const { loadConfig } = require('../paperbot/config');
  const store = createMemoryStore();
  for (let i = 0; i < 3; i++) await store.insertTrade({ market: 'nse', symbol: 'A', trade_date: '2026-11-17', status: 'closed', pnl_inr: 100, patterns: ['hammer'], judge_contributions: { sector: 15 } });
  const reporter = createReporter({ store, axios: null, env: {}, now: () => Date.UTC(2026, 10, 22, 5), log: () => {}, loadConfig });
  await loadConfig(store);
  const { loadJudgeConfig } = require('../src/paper/decision/judge'); await loadJudgeConfig(store); // first run writes the defaults once
  const before = JSON.stringify(await store.getConfig());
  await reporter.weekly();
  const kinds = store._db.summaries.map((s) => s.kind);
  assert.deepEqual(kinds, ['weekly_suggestions', 'judge_ablation']);
  assert.match(store._db.summaries[1].body, /Nothing below is applied/); assert.match(store._db.summaries[1].body, /Too few trades, no conclusion/);
  const after = await store.getConfig();
  assert.equal(JSON.stringify(after), before, 'no rule or weight was changed');
});
