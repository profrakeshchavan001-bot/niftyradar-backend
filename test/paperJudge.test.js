'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJudge, loadJudgeConfig, tradeFields, ablation, weeklyAblationReport, JUDGE_DEFAULTS, HELPERS, judge: defaultJudge } = require('../src/paper/decision/judge');
const { createMemoryStore } = require('../paperbot/store');

// 10:30 IST = 05:00 UTC. istAt('09:20') etc. build the timestamp for a given IST clock time on a Monday (2026-11-16).
const istAt = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(2026, 10, 16, h, m) - 5.5 * 3600 * 1000; };

// A perfect long: hand-worked points with the default weights
//  R 3 -> full 25 | order_block 0.9 x 25 = 22.5 | sector 80/100 x 20 = 16 | news +50 -> 150/200 x 10 = 7.5 | Nifty up -> 10 | 10:30 IST -> 10   => 91
const base = () => ({ symbol: 'RELIANCE', direction: 'long', rFactor: 3, patterns: ['order_block'], sectorView: { sector: 'Energy', score: 80, label: 'STRONG', vsNifty: 1.2 }, newsScore: 50, niftyTrend: 'up', time: istAt('10:30') });
const mk = (over) => createJudge({ stockSectorView: async () => null, newsScore: async () => 0, eventBlock: async () => ({ block: false }), ...over });

test('defaults: weights 25/25/20/10/10/10, take at 65', () => {
  assert.deepEqual(JUDGE_DEFAULTS.weights, { r_factor: 25, pattern: 25, sector: 20, news: 10, market_trend: 10, time: 10 });
  assert.equal(JUDGE_DEFAULTS.take_threshold, 65);
  assert.equal(HELPERS.reduce((s, h) => s + JUDGE_DEFAULTS.weights[h], 0), 100);
});

test('a perfect long scores 91 and is taken; contributions add up to the score; the basis is a plain sentence', async () => {
  const d = await mk()(base());
  assert.deepEqual(d.contributions, { r_factor: 25, pattern: 22.5, sector: 16, news: 7.5, market_trend: 10, time: 10 });
  assert.equal(d.score, 91);
  assert.equal(d.take, true); assert.equal(d.blocked, null); assert.deepEqual(d.unavailable, []);
  assert.match(d.basis, /^Taken: long scores 91\/100, needs 65\./);
  assert.match(d.basis, /order block/); assert.match(d.basis, /Energy is strong \(80\/100\)/); assert.match(d.basis, /Nifty 15-min trend is up/);
});

test('the threshold is >= 65: exactly 65 is taken, 63.8 is not', async () => {
  // R 2.6 -> (2.6-1)/2 = 0.8 -> 20 | hammer 0.6 -> 15 | sector 50 -> 10 | news 0 -> 5 | Nifty flat -> 5 | time 10   => 65
  const c = { ...base(), rFactor: 2.6, patterns: ['hammer'], sectorView: { sector: 'Energy', score: 50, label: 'NEUTRAL' }, newsScore: 0, niftyTrend: 'flat' };
  const at = await mk()(c); assert.equal(at.score, 65); assert.equal(at.take, true);
  // R 2.5 -> 0.75 -> 18.75: total 63.75, shown as 63.8
  const below = await mk()({ ...c, rFactor: 2.5 }); assert.equal(below.score, 63.8); assert.equal(below.take, false);
  assert.match(below.basis, /^Not taken: long scores 63\.8\/100, needs 65\. Weakest: /);
  const strict = await mk({ config: { take_threshold: 70 } })(c); assert.equal(strict.take, false, 'threshold is configurable');
});

test('hard block: an event block stops the trade whatever the score', async () => {
  const d = await mk({ eventBlock: async (s) => (s === 'RELIANCE' ? { block: true, reason: 'results due today' } : { block: false }) })(base());
  assert.equal(d.take, false); assert.equal(d.score, 91); assert.match(d.blocked, /event block: results due today/); assert.match(d.basis, /^Not taken: event block: results due today/);
});

test('hard block: news below -40 against a long (-41 blocks, -40 does not); mirrored for a short (+41 blocks, +40 does not)', async () => {
  assert.equal((await mk()({ ...base(), newsScore: -41 })).take, false);
  assert.match((await mk()({ ...base(), newsScore: -41 })).blocked, /news block/);
  assert.equal((await mk()({ ...base(), newsScore: -40 })).blocked, null);
  const short = { ...base(), direction: 'short', sectorView: { sector: 'Energy', score: 20, label: 'WEAK' }, niftyTrend: 'down' };
  assert.match((await mk()({ ...short, newsScore: 41 })).blocked, /news block/);
  assert.equal((await mk()({ ...short, newsScore: 40 })).blocked, null);
  const strictAny = await mk({ config: { news_block_mirror: false } })({ ...short, newsScore: 41 }); assert.equal(strictAny.blocked, null, 'mirror off: only scores below -40 block');
  assert.match((await mk({ config: { news_block_mirror: false } })({ ...short, newsScore: -41 })).blocked, /news block/);
});

test('hard block: a WEAK sector against a long, a STRONG sector against a short; the other way round is rewarded', async () => {
  const weak = { sector: 'Metals', score: 20, label: 'WEAK' }; const strong = { sector: 'Banks', score: 85, label: 'STRONG' };
  const longWeak = await mk()({ ...base(), sectorView: weak }); assert.equal(longWeak.take, false); assert.match(longWeak.blocked, /sector block: Metals is weak \(20\/100\), against a long/);
  const shortStrong = await mk()({ ...base(), direction: 'short', niftyTrend: 'down', sectorView: strong }); assert.equal(shortStrong.take, false); assert.match(shortStrong.blocked, /sector block/);
  // short with a weak sector: 1 - 0.2 = 0.8 x 20 = 16 points, no block
  const shortWeak = await mk()({ ...base(), direction: 'short', niftyTrend: 'down', sectorView: weak, newsScore: -20 });
  assert.equal(shortWeak.contributions.sector, 16); assert.equal(shortWeak.blocked, null);
  // news -20 for a short: (100 - (-20)) / 200 = 0.6 x 10 = 6
  assert.equal(shortWeak.contributions.news, 6);
});

test('time of day: first 15 and last 30 minutes earn nothing (09:15-09:30 and 15:00-15:30 IST), the rest earns all 10', async () => {
  const pts = async (hhmm) => (await mk()({ ...base(), time: istAt(hhmm) })).contributions.time;
  assert.equal(await pts('09:14'), 0, 'before the open');
  assert.equal(await pts('09:20'), 0); assert.equal(await pts('09:29'), 0);
  assert.equal(await pts('09:30'), 10); assert.equal(await pts('14:59'), 10);
  assert.equal(await pts('15:00'), 0); assert.equal(await pts('15:29'), 0); assert.equal(await pts('15:31'), 0, 'after the close');
  assert.equal((await mk()({ ...base(), market: 'crypto' })).contributions.time, 5, 'crypto: not scored, half points');
});

test('Nifty trend: with the trade 10, flat 5, against 0; a short wants a down trend', async () => {
  const t = async (trend, direction = 'long') => (await mk()({ ...base(), direction, sectorView: { score: 50, label: 'NEUTRAL' }, niftyTrend: trend })).contributions.market_trend;
  assert.equal(await t('up'), 10); assert.equal(await t('flat'), 5); assert.equal(await t('down'), 0);
  assert.equal(await t('down', 'short'), 10); assert.equal(await t('up', 'short'), 0);
});

test('patterns: strongest + 0.1 for each extra confirming pattern, patterns against the trade subtract; accepts the bot\'s {name, direction} objects; CALL/PUT work', async () => {
  const p = async (patterns, direction = 'long') => (await mk()({ ...base(), direction, patterns })).contributions.pattern;
  assert.equal(await p(['hammer']), 15);                       // 0.6 x 25
  assert.equal(await p(['hammer', 'order_block']), 25);        // 0.9 + 0.1 = 1.0 x 25
  assert.equal(await p([]), 0);
  assert.equal(await p([{ name: 'bullish_engulfing', direction: 'up' }, { name: 'bearish_engulfing', direction: 'down' }]), 15); // 0.7 - 0.1 = 0.6 x 25
  assert.equal(await p([{ name: 'bearish_engulfing', direction: 'down' }]), 0, 'only patterns against the long');
  assert.equal(await p(['mystery_pattern']), 12.5);            // not in the table: 0.5 x 25
  assert.equal((await mk()({ ...base(), direction: 'CALL' })).take, true);
  assert.equal((await mk()({ ...base(), direction: 'PUT', niftyTrend: 'down', sectorView: { score: 20, label: 'WEAK' }, newsScore: -10 })).blocked, null);
});

test('a helper that is not available earns half its points and is listed; the real modules are used when they exist (here: absent)', async () => {
  const d = await createJudge()({ symbol: 'X', direction: 'long', rFactor: 3, patterns: ['order_block'], niftyTrend: 'up', time: istAt('10:30') });
  assert.deepEqual(d.unavailable.sort(), ['news', 'sector']);
  assert.equal(d.contributions.sector, 10); assert.equal(d.contributions.news, 5);
  assert.equal(d.score, 25 + 22.5 + 10 + 5 + 10 + 10); // 82.5
  const noR = await mk()({ ...base(), rFactor: undefined }); assert.deepEqual(noR.unavailable, ['r_factor']); assert.equal(noR.contributions.r_factor, 0);
  assert.ok(typeof (await defaultJudge({ ...base() })).score === 'number', 'the ready-made judge works');
});

test('stub helpers are asked with the symbol; a helper that throws counts as unavailable, never breaks the decision', async () => {
  const asked = [];
  const d = await createJudge({ stockSectorView: async (s) => { asked.push(['sector', s]); return { sector: 'IT', score: 70, label: 'STRONG' }; }, newsScore: async (s) => { asked.push(['news', s]); throw new Error('feed down'); }, eventBlock: async (s) => { asked.push(['event', s]); return { block: false }; } })({ ...base(), sectorView: undefined, newsScore: undefined });
  assert.deepEqual(asked.map((a) => a[0]).sort(), ['event', 'news', 'sector']); assert.ok(asked.every((a) => a[1] === 'RELIANCE'));
  assert.deepEqual(d.unavailable, ['news']); assert.equal(d.contributions.sector, 14); // 0.7 x 20
});

test('weights come from config; they are scaled so the score stays 0-100; missing direction is not taken', async () => {
  const doubled = Object.fromEntries(HELPERS.map((h) => [h, JUDGE_DEFAULTS.weights[h] * 2]));
  assert.equal((await mk({ config: { weights: doubled } })(base())).score, 91, 'same score when every weight doubles');
  const onlyR = await mk({ config: { weights: { r_factor: 100, pattern: 0, sector: 0, news: 0, market_trend: 0, time: 0 } } })({ ...base(), rFactor: 2 });
  assert.equal(onlyR.score, 50); // (2-1)/2 = 0.5 of 100
  const none = await mk()({ ...base(), direction: undefined }); assert.equal(none.take, false); assert.equal(none.score, 0);
});

test('loadJudgeConfig: first run writes the defaults to paper_config, a stored row wins, the bot never writes weights', async () => {
  const store = createMemoryStore();
  const c1 = await loadJudgeConfig(store); assert.deepEqual(c1.weights, JUDGE_DEFAULTS.weights); assert.deepEqual(store._db.config.judge.weights, JUDGE_DEFAULTS.weights);
  store._db.config.judge = { take_threshold: 70, weights: { news: 20 } };
  const c2 = await loadJudgeConfig(store); assert.equal(c2.take_threshold, 70); assert.equal(c2.weights.news, 20); assert.equal(c2.weights.sector, 20);
  assert.deepEqual(store._db.config.judge, { take_threshold: 70, weights: { news: 20 } }, 'loading changes nothing in the table');
});

test('tradeFields: the columns stored with every trade', async () => {
  const d = await mk()(base());
  assert.deepEqual(tradeFields(d), { judge_score: 91, judge_take: true, judge_contributions: d.contributions, judge_basis: d.basis });
});

// ---------- ablation ----------
const trade = (pnl, contributions) => ({ status: 'closed', pnl_inr: pnl, judge_contributions: { r_factor: 20, pattern: 20, sector: 10, news: 5, market_trend: 5, time: 5, ...contributions } });
const many = (n, pnl, contributions) => Array.from({ length: n }, () => trade(pnl, contributions));

test('ablation: sector supported 25 winning trades (+100) and not supported 25 losing trades (-50): adds value; the report says so and applies nothing', () => {
  // sector weight 20, support = at least 10 points. With: 25 trades, win 100%, avg +100. Without: 25 trades, win 0%, avg -50. Edge: 100 points, +150.
  const closed = [...many(25, 100, { sector: 16 }), ...many(25, -50, { sector: 2 })];
  const frozen = JSON.parse(JSON.stringify(JUDGE_DEFAULTS)); Object.freeze(frozen.weights);
  const sector = ablation(closed, frozen).find((r) => r.helper === 'sector');
  assert.deepEqual(sector.with, { trades: 25, winRatePct: 100, avgPnlInr: 100 }); assert.deepEqual(sector.without, { trades: 25, winRatePct: 0, avgPnlInr: -50 });
  assert.equal(sector.enough, true); assert.equal(sector.verdict, 'adds value'); assert.equal(sector.winRateEdgePts, 100); assert.equal(sector.avgPnlEdgeInr, 150);
  assert.match(sector.suggestion, /keep, maybe raise the weight \(now 20\)/);
  const rep = weeklyAblationReport({ date: '2026-11-22', closed, config: frozen });
  assert.match(rep.text, /Nothing below is applied/); assert.match(rep.text, /sector \(weight 20\): 50 trades\./); assert.match(rep.text, /Verdict: adds value/);
  assert.deepEqual(frozen.weights, JUDGE_DEFAULTS.weights, 'the config is never changed');
});

test('ablation: trades it liked did worse -> does not add value; similar results -> no clear difference', () => {
  const hurt = ablation([...many(20, -40, { news: 9 }), ...many(20, 60, { news: 1 })]).find((r) => r.helper === 'news');
  assert.match(hurt.verdict, /does not add value/); assert.match(hurt.suggestion, /consider lowering the weight \(now 10\)/);
  const same = ablation([...many(20, 10, { time: 9 }), ...many(20, 10, { time: 1 })]).find((r) => r.helper === 'time');
  assert.equal(same.verdict, 'no clear difference');
});

test('ablation: fewer than 20 trades in a group (or none) -> "too few trades, no conclusion"; open trades and trades without judge points are ignored', () => {
  const closed = [...many(19, 100, { pattern: 24 }), ...many(30, -10, { pattern: 1 }), { status: 'open', pnl_inr: null, judge_contributions: { pattern: 24 } }, { status: 'closed', pnl_inr: 5 }];
  const pattern = ablation(closed).find((r) => r.helper === 'pattern');
  assert.equal(pattern.with.trades, 19); assert.equal(pattern.without.trades, 30); assert.equal(pattern.enough, false);
  assert.equal(pattern.verdict, 'too few trades, no conclusion'); assert.equal(pattern.winRateEdgePts, null);
  const rep = weeklyAblationReport({ date: '2026-11-22', closed });
  assert.match(rep.text, /Too few trades, no conclusion \(with: 19, without: 30, each group needs 20\)/);
  assert.match(weeklyAblationReport({ date: 'x', closed: [] }).text, /No closed trades with judge points yet/);
  assert.equal(ablation([]).length, HELPERS.length);
});
