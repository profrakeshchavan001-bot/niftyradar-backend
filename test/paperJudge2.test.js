'use strict';
// CC2 round 2 item 3: Judge v2, a PARALLEL scorer (never used for a live decision).
// Hand-worked totals for two cases: everything available (NSE), and several
// helpers excluded + rescaled (crypto - sector/news never apply there, and no
// SMC tags / EMA cross were supplied).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createJudge2 } = require('../src/paper/decision/judge2');

test('judge2: every helper available (NSE) - hand-worked score and contributions', async () => {
  const judge2 = createJudge2({ stockSectorView: null, newsScore: null, eventBlock: null });
  const d = await judge2({
    market: 'nse', direction: 'up', rFactor: 3, patterns: [{ name: 'order_block', direction: 'up' }],
    smcTags: ['bos_up', 'order_block_up', 'fvg_retest_up'], emaCross: 'fresh_with',
    sectorView: { score: 80, label: 'strong' }, newsScore: 20, time: Date.UTC(2026, 10, 16, 6, 0, 0), // 11:30 IST, mid-session
  });
  // r_factor: (3-1)/(3-1)=1 x 25 = 25. pattern: order_block strength 0.9 x 25 = 22.5.
  // smc: 3 aligned tags, 0 against, 3/3=1 x 15 = 15. ema: fresh_with=1 x 10 = 10.
  // sector: strong 80/100=0.8 x 10 = 8. news: (20+100)/200=0.6 x 10 = 6. time: mid-session=1 x 5 = 5.
  // none excluded, so no rescale: total = 25+22.5+15+10+8+6+5 = 91.5
  assert.deepEqual(d.contributions, { r_factor: 25, pattern: 22.5, smc: 15, ema_trend: 10, sector: 8, news: 6, time: 5 });
  assert.equal(d.score, 91.5);
  assert.equal(d.take, true);
  assert.equal(d.na.length, 0);
});

test('judge2: crypto - sector/news always excluded; no SMC tags or EMA cross -> also excluded; weights rescaled to 100', async () => {
  const judge2 = createJudge2({ stockSectorView: null, newsScore: null, eventBlock: null });
  const d = await judge2({ market: 'crypto', direction: 'down', rFactor: 2, patterns: [{ name: 'hammer', direction: 'down' }] });
  // Active helpers only: r_factor (25), pattern (25), time (5) -> totalW = 55, each rescaled to /55*100.
  // r_factor: (2-1)/(3-1)=0.5 x (25/55*100=45.4545) = 22.7
  // pattern: hammer strength 0.6 x 45.4545 = 27.3
  // time: crypto trades round the clock, neutral 0.5 x (5/55*100=9.0909) = 4.5
  assert.deepEqual(d.na, ['smc', 'ema_trend', 'sector', 'news']);
  assert.deepEqual(d.contributions, { r_factor: 22.7, pattern: 27.3, smc: null, ema_trend: null, sector: null, news: null, time: 4.5 });
  // 22.727273 + 27.272727 + 4.545455 = 54.545455 -> rounds to 54.5
  assert.equal(d.score, 54.5);
  assert.equal(d.take, false);
});

test('judge2: no direction -> score 0, not taken, nothing guessed', async () => {
  const judge2 = createJudge2({ stockSectorView: null, newsScore: null, eventBlock: null });
  const d = await judge2({ market: 'nse' });
  assert.deepEqual([d.score, d.take, d.blocked], [0, false, 'no direction']);
});

test('judge2: a hard block (event block) overrides the score, same convention as judge v1', async () => {
  const judge2 = createJudge2({ stockSectorView: null, newsScore: null, eventBlock: null });
  const d = await judge2({ market: 'nse', direction: 'up', rFactor: 3, patterns: [{ name: 'order_block', direction: 'up' }], eventBlock: { block: true, reason: 'results tomorrow' } });
  assert.equal(d.take, false);
  assert.match(d.blocked, /event block: results tomorrow/);
});
