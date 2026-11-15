'use strict';
// Task Group B: filter-strictness report (src/paper/decision/filterStrictness.js).
// No live database needed: a small synthetic paper_skips / paper_trades dataset, built by hand, the same
// way test/paperJudge2.test.js hand-works its own numbers. Proves: (1) reasons are categorised into the
// right filter, (2) the tally ranks filters by how many candidates each one blocked, (3) the
// take_threshold win-rate estimate is a real score-band lookup against taken trades (and says "no
// conclusion" when there are too few of them, never a guessed number), (4) the report/markdown wiring
// does not throw and carries the required "suggestions only" disclaimer.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  categorize, tallyFilters, bandOf, scoreBandWinRates, takeThresholdEstimate,
  buildFilterStrictnessReport, toMarkdown, SCORE_BAND, MIN_BAND_TRADES,
} = require('../src/paper/decision/filterStrictness');

test('categorize: maps the exact stored reason strings to the right filter', () => {
  assert.equal(categorize('judge 58/100: not taken, weakest: sector (WEAK)'), 'take_threshold');
  assert.equal(categorize('news filter: blocked headline about RELIANCE'), 'news_block');
  assert.equal(categorize('max 3 trades for the day already taken'), 'max_trades_per_day');
  assert.equal(categorize('lot size not known for this stock'), 'lot_size_unknown');
  assert.equal(categorize('one lot (50 x Rs 120) is bigger than the 2% risk size or the free cash'), 'position_size');
  assert.equal(categorize('not enough 5-min candles yet (need 20)'), 'candle_availability');
  assert.equal(categorize('no fresh candle (market closed or data feed stale)'), 'stale_candle');
  assert.equal(categorize('pattern hammer (up) is against the 15-min trend (down) or VWAP side (below)'), 'pattern_trend_disagree');
  assert.equal(categorize('patterns disagree: hammer (up), shooting_star (down)'), 'pattern_disagree');
  assert.equal(categorize('no pattern'), 'no_pattern');
  assert.equal(categorize('momentum score 1.2 is below 2'), 'momentum_score');
  assert.equal(categorize('reward/risk 1.2 is below 1.5 (target 101 before swing high 1h 101.5, stop 99)'), 'rr_below_min');
  assert.equal(categorize('no resistance level found above the entry, so no target'), 'no_level_found');
  assert.equal(categorize('every support level found is within 1 x ATR14 (0.5) of the entry, no room for a target'), 'no_level_found');
  assert.equal(categorize('not enough 15-min candles for ATR14, no stop can be set'), 'no_stop_possible');
  assert.equal(categorize('no free virtual USDT balance'), 'no_free_balance');
  assert.equal(categorize('event block: results tomorrow'), 'event_block');
  assert.equal(categorize('sector block: Metals is WEAK (20/100), against a long'), 'sector_block');
  assert.equal(categorize('something nobody wrote a rule for'), 'other');
  assert.equal(categorize(null), 'other');
});

test('tallyFilters: ranks filters by how many candidates each one blocked, with share%', () => {
  const skips = [
    { reason: 'judge 58/100: ...' }, { reason: 'judge 60/100: ...' }, { reason: 'judge 62/100: ...' },
    { reason: 'news filter: blocked' },
    { reason: 'not enough 5-min candles yet (need 20)' }, { reason: 'not enough 5-min candles yet (need 20)' },
  ];
  const tally = tallyFilters(skips);
  assert.equal(tally[0].key, 'take_threshold');
  assert.equal(tally[0].count, 3);
  assert.equal(tally[0].sharePct, 50); // 3/6
  assert.equal(tally.find((f) => f.key === 'candle_availability').count, 2);
  assert.equal(tally.find((f) => f.key === 'news_block').count, 1);
  // ranking is sorted descending by count
  for (let i = 1; i < tally.length; i += 1) assert.ok(tally[i - 1].count >= tally[i].count);
  // every row keeps a couple of real examples, never fabricated ones
  assert.equal(tally[0].examples.length <= 3, true);
});

test('tallyFilters: empty input gives an empty, not a crashing, report', () => {
  assert.deepEqual(tallyFilters([]), []);
  assert.deepEqual(tallyFilters(undefined), []);
});

test('bandOf: 10-point score bands, floor-aligned', () => {
  assert.equal(bandOf(62), '60-70');
  assert.equal(bandOf(60), '60-70');
  assert.equal(bandOf(69.9), '60-70');
  assert.equal(bandOf(0), '0-10'); // 0 is a real score and lands in the first band
  assert.equal(bandOf(null), null); // not a real score - never guessed into a band
  assert.equal(bandOf(NaN), null);
});

function closedTrade({ pnl, judge2_score }) {
  return { status: 'closed', pnl_inr: pnl, judge2_score };
}

test('scoreBandWinRates: a band needs MIN_BAND_TRADES trades before it reports a number', () => {
  // Only 2 trades in the 60-70 band - fewer than MIN_BAND_TRADES (20, judge.js's own bar) -> no conclusion.
  const closed = [closedTrade({ pnl: 100, judge2_score: 62 }), closedTrade({ pnl: -50, judge2_score: 65 })];
  const bands = scoreBandWinRates(closed);
  assert.equal(bands['60-70'].trades, 2);
  assert.equal(bands['60-70'].enough, false);
});

test('scoreBandWinRates: enough trades in a band reports the real, computed win rate', () => {
  const closed = [];
  for (let i = 0; i < 15; i += 1) closed.push(closedTrade({ pnl: 100, judge2_score: 72 })); // 15 wins
  for (let i = 0; i < 5; i += 1) closed.push(closedTrade({ pnl: -50, judge2_score: 75 })); // 5 losses, same band
  const bands = scoreBandWinRates(closed);
  assert.equal(bands['70-80'].trades, 20);
  assert.equal(bands['70-80'].enough, true);
  assert.equal(bands['70-80'].winRatePct, 75); // 15/20
});

test('takeThresholdEstimate: blocked candidates are matched to the win rate of similarly-scored taken trades, labelled as an estimate', () => {
  const closed = [];
  for (let i = 0; i < 20; i += 1) closed.push(closedTrade({ pnl: i < 14 ? 100 : -50, judge2_score: 72 })); // 70% win in the 70-80 band
  const skips = [
    { reason: 'judge 58/100: not taken', judge2_score: 62 }, // 60-70 band, no comparable taken trades
    { reason: 'judge 61/100: not taken', judge2_score: 63 }, // also 60-70
    { reason: 'news filter: blocked', judge2_score: 80 }, // not a take_threshold skip - must not be counted here
  ];
  const est = takeThresholdEstimate(skips, closed);
  assert.equal(est.filter, 'take_threshold');
  assert.equal(est.totalBlocked, 2);
  assert.equal(est.scoredBlocked, 2);
  assert.equal(est.unscored, 0);
  assert.match(est.label, /RETROSPECTIVE SIMULATION ESTIMATE/);
  const band = est.byScoreBand.find((b) => b.judge2ScoreBand === '60-70');
  assert.equal(band.candidatesBlocked, 2);
  assert.equal(band.estimatedWinRatePct, null); // no taken trades at all in 60-70 -> no conclusion, never guessed
  assert.match(band.note, /too few|Too few/i);
});

test('takeThresholdEstimate: skip rows with no judge2_score are counted as unscored, not silently dropped', () => {
  const skips = [{ reason: 'judge 50/100: not taken' }, { reason: 'judge 55/100: not taken', judge2_score: 58 }];
  const est = takeThresholdEstimate(skips, []);
  assert.equal(est.totalBlocked, 2);
  assert.equal(est.scoredBlocked, 1);
  assert.equal(est.unscored, 1);
});

test('buildFilterStrictnessReport + toMarkdown: end-to-end on a synthetic dataset, carries the "suggestions only" disclaimer', () => {
  const skips = [
    { reason: 'judge 58/100: not taken', judge2_score: 62, market: 'nse', symbol: 'RELIANCE', skip_date: '2026-11-14' },
    { reason: 'judge 60/100: not taken', judge2_score: 64, market: 'nse', symbol: 'TCS', skip_date: '2026-11-14' },
    { reason: 'not enough 5-min candles yet (need 20)', market: 'nse', symbol: 'INFY', skip_date: '2026-11-14' },
    { reason: 'news filter: blocked', market: 'nse', symbol: 'HDFC', skip_date: '2026-11-14' },
  ];
  const closed = [
    { status: 'closed', pnl_inr: 100, judge_score: 70, judge_contributions: { r_factor: 25, pattern: 25, sector: 20, news: 10, market_trend: 10, time: 10 }, judge2_score: 72 },
    { status: 'closed', pnl_inr: -40, judge_score: 68, judge_contributions: { r_factor: 20, pattern: 20, sector: 18, news: 9, market_trend: 9, time: 9 }, judge2_score: 70 },
  ];
  const report = buildFilterStrictnessReport({ skips, closedTrades: closed });
  assert.equal(report.paperOnly, true);
  assert.match(report.disclaimer, /Suggestions only/);
  assert.equal(report.totalSkips, 4);
  assert.equal(report.totalClosedTrades, 2);
  assert.equal(report.filterTally[0].key, 'take_threshold'); // 2 of the 4 skips, the most common reason
  assert.equal(report.filterTally[0].count, 2);
  assert.ok(Array.isArray(report.helperWeightImpact)); // reused straight from judge.js's own ablation()
  assert.equal(report.helperWeightImpact.length, 6);
  assert.match(report.unmeasuredNote, /liquidity\/turnover floor/);

  const md = toMarkdown(report);
  assert.match(md, /# Filter-strictness report/);
  assert.match(md, /Suggestions only/);
  assert.match(md, /RETROSPECTIVE SIMULATION ESTIMATE/);
  assert.match(md, /Not measurable from stored data today/);
  assert.match(md, /liquidity\/turnover floor/);
});

test('MIN_BAND_TRADES reuses judge.js\'s own "too few trades" bar, not a separately invented number', () => {
  const { JUDGE_DEFAULTS } = require('../src/paper/decision/judge');
  assert.equal(MIN_BAND_TRADES, JUDGE_DEFAULTS.min_trades_for_conclusion);
});

test('SCORE_BAND is exported and positive (sanity: the module did not silently change its bucket width)', () => {
  assert.equal(typeof SCORE_BAND, 'number');
  assert.ok(SCORE_BAND > 0);
});
