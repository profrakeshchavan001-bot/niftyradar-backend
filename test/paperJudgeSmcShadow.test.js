'use strict';
// Task Group B: the SMC shadow judge (src/paper/decision/judgeSmcShadow.js) - a PARALLEL decision,
// never used for a live take/skip. Hand-worked totals, same convention as test/paperJudge.test.js and
// test/paperJudge2.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createShadowJudge, SHADOW_HELPERS, SHADOW_DEFAULTS, SMC_SHADOW_WEIGHT } = require('../src/paper/decision/judgeSmcShadow');
const { createJudge, JUDGE_DEFAULTS } = require('../src/paper/decision/judge');

const istAt = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return Date.UTC(2026, 10, 16, h, m) - 5.5 * 3600 * 1000; };

const base = () => ({
  symbol: 'RELIANCE', direction: 'long', rFactor: 3, patterns: ['order_block'],
  smcTags: ['order_block_up', 'fvg_retest_up', 'bos_up'], rawDir: 'up',
  sectorView: { sector: 'Energy', score: 80, label: 'STRONG', vsNifty: 1.2 }, newsScore: 50, niftyTrend: 'up', time: istAt('10:30'),
});
const mk = (over) => createShadowJudge({ stockSectorView: async () => null, newsScore: async () => 0, eventBlock: async () => ({ block: false }), ...over });

test('weight choice: smc added as a 7th helper at 15, same as judge2.js; 6 existing helpers keep their nominal weight, all 7 renormalized', () => {
  assert.equal(SMC_SHADOW_WEIGHT, 15);
  assert.deepEqual(SHADOW_DEFAULTS.weights, { r_factor: 25, pattern: 25, sector: 20, news: 10, market_trend: 10, time: 10, smc: 15 });
  assert.deepEqual(SHADOW_HELPERS, ['r_factor', 'pattern', 'sector', 'news', 'market_trend', 'time', 'smc']);
  // nothing here ever touches the live Judge's own defaults
  assert.deepEqual(JUDGE_DEFAULTS.weights, { r_factor: 25, pattern: 25, sector: 20, news: 10, market_trend: 10, time: 10 });
});

test('a perfect long with 3 aligned SMC tags: hand-worked contributions and score (weights renormalized over 115)', async () => {
  const d = await mk()(base());
  // totalW = 115. factor = 100/115.
  // r_factor: (3-1)/(3-1)=1 x (25/115*100=21.73913) = 21.7
  // pattern: order_block 0.9 x 21.73913 = 19.6
  // sector: 80/100=0.8 x (20/115*100=17.39130) = 13.9
  // news: (50+100)/200=0.75 x (10/115*100=8.69565) = 6.5
  // market_trend: up, with the trade -> 1 x 8.69565 = 8.7
  // time: 10:30 IST, steady part -> 1 x 8.69565 = 8.7
  // smc: 3 tags ending _up, 0 against, 3/3=1 x (15/115*100=13.04348) = 13.0
  assert.deepEqual(d.contributions, { r_factor: 21.7, pattern: 19.6, sector: 13.9, news: 6.5, market_trend: 8.7, time: 8.7, smc: 13.0 });
  // sum of UNROUNDED fractions*weight: (25+22.5+16+7.5+10+10+15)/115*100 = 106/115*100 = 92.173913... -> 92.2
  assert.equal(d.score, 92.2);
  assert.equal(d.take, true);
  assert.equal(d.blocked, null);
  assert.match(d.basis, /^Shadow \(SMC\): long scores 92\.2\/100, needs 65/);
  assert.match(d.basis, /Would take/);
  assert.match(d.basis, /never a live decision/);
});

test('no SMC tags on the setup: smc earns half credit (0.5), same "unavailable" convention as every other helper here, not judge2\'s zero/na', async () => {
  const d = await mk()({ ...base(), smcTags: [] });
  assert.ok(d.unavailable.includes('smc'));
  // smc: 0.5 x 13.04348 = 6.5
  assert.equal(d.contributions.smc, 6.5);
});

test('SMC tags against the trade lower (never raise) the smc fraction, and the real Judge for the same candidate is untouched (same call signature, same scorers, no smc field read)', async () => {
  const against = await mk()({ ...base(), smcTags: ['order_block_down', 'fvg_retest_down'] }); // 2 tags against an 'up' trade
  assert.equal(against.contributions.smc, 0); // (0 - 0.5*2)/3 clamped to 0
  const real = await createJudge({ stockSectorView: async () => null, newsScore: async () => 0, eventBlock: async () => ({ block: false }) })(base());
  // judge.js has no `smc` key at all - proof the live Judge's scheme is untouched by this module.
  assert.deepEqual(Object.keys(real.contributions), ['r_factor', 'pattern', 'sector', 'news', 'market_trend', 'time']);
  assert.equal(real.score, 91); // exact figure from test/paperJudge.test.js's "perfect long" case
});

test('a hard block (event block) overrides the shadow score too, same convention as judge.js / judge2.js', async () => {
  const d = await mk()({ ...base(), eventBlock: { block: true, reason: 'results tomorrow' } });
  assert.equal(d.take, false);
  assert.match(d.blocked, /event block: results tomorrow/);
});

test('no direction: score 0, not taken, nothing guessed', async () => {
  const d = await mk()({ market: 'nse' });
  assert.deepEqual([d.score, d.take, d.blocked], [0, false, 'no direction']);
});
