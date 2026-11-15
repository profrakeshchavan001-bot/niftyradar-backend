'use strict';
// FILTER-STRICTNESS REPORT (overnight brief, Task Group B: "why so few trades").
// REPORT-ONLY, SUGGESTIONS ONLY: nothing in this file changes a live filter, threshold or Judge weight.
// judge.js's JUDGE_DEFAULTS and every other live config default are read, never written.
//
// Data sources, all read-only through the existing store (paperbot/store.js):
//  - paper_skips rows: every skip() call site in paperbot/bot.js (plus decision.reason from
//    paperbot/engine.js's decideEntry() and the reasons paperbot/cryptoLevels.js's planTrade() returns)
//    writes one of a small, fixed set of `reason` strings - see docs/JUDGE.md, docs/PAPER-BOT.md.
//    categorize() below maps each stored reason back to the filter that produced it.
//  - closed paper_trades: for the win-rate estimates.
//
// Win-rate "what if this filter were loosened/removed" numbers are RETROSPECTIVE SIMULATION ESTIMATES
// on past data, NOT a guarantee of future results - same caveat docs/REPLAY.md gives its own numbers.
// paper_skips does NOT store the OHLC candles of a skipped setup (only pattern names, a trend_state
// snapshot and the parallel Judge v2 score - see paperbot/bot.js skip()), so a true candle-by-candle
// replay of a skipped NSE/crypto candidate (the kind src/paper/replay/ does for the scalp bots) is not
// possible from this data alone. Instead:
//  - for take_threshold, every blocked candidate that carries a judge2_score (computed on EVERY skip
//    row already, NEVER used for a live decision - src/paper/decision/judge2.js) is bucketed by that
//    score, and the win rate of ACTUALLY TAKEN trades scoring similarly on the same parallel judge is
//    used as the estimate - a historical analogy by score band, not a candle simulation. Clearly
//    labelled wherever this number is shown.
//  - for the Judge's own helper weights (r_factor, pattern, sector, news, market_trend, time), this
//    reuses judge.js's own, already-tested ablation() exactly as the weekly report does - the real,
//    data-backed "does this helper's weight add value" measurement is not duplicated here.
//  - the liquidity/turnover floor is NOT recorded per-candidate in paper_skips at all (see
//    UNMEASURED_NOTE below) - said plainly rather than inventing a number for it.
const { JUDGE_DEFAULTS, ablation } = require('./judge');

const SCORE_BAND = 10; // bucket width for the judge2-score win-rate analogy
const MIN_BAND_TRADES = JUDGE_DEFAULTS.min_trades_for_conclusion; // same "too few trades" bar judge.js's own ablation() uses

// ---- categorising one paper_skips.reason string into a named "filter" ---------------------------------
// Matches the exact reason text each skip() call site writes (paperbot/bot.js, paperbot/engine.js
// decideEntry(), paperbot/cryptoLevels.js planTrade()). Order matters: more specific checks first.
const FILTERS = [
  { key: 'take_threshold', label: 'Judge score below take_threshold (65)', test: (r) => /^judge \d/.test(r) },
  { key: 'news_block', label: 'News filter (headline block)', test: (r) => r.startsWith('news filter:') },
  { key: 'max_trades_per_day', label: 'Daily NSE trade cap already reached', test: (r) => /^max \d+ trades for the day/.test(r) },
  { key: 'lot_size_unknown', label: 'Lot size not known for the stock', test: (r) => r === 'lot size not known for this stock' },
  { key: 'position_size', label: 'Position too big for the risk size / free cash', test: (r) => /bigger than the \d+(\.\d+)?% risk size/.test(r) },
  { key: 'candle_availability', label: 'Not enough closed candles yet', test: (r) => /^not enough \d+-min candles yet/.test(r) },
  { key: 'stale_candle', label: 'No fresh candle (feed stale / market closed)', test: (r) => r === 'no fresh candle (market closed or data feed stale)' },
  { key: 'pattern_trend_disagree', label: 'Pattern against the 15-min trend / VWAP side', test: (r) => / is against the 15-min trend/.test(r) },
  { key: 'pattern_disagree', label: 'Patterns disagree on direction', test: (r) => r.startsWith('patterns disagree:') },
  { key: 'no_pattern', label: 'No candle/SMC pattern fired', test: (r) => r === 'no pattern' },
  { key: 'momentum_score', label: 'Crypto momentum score below minimum', test: (r) => /^momentum score .* is below/.test(r) },
  { key: 'rr_below_min', label: 'Reward/risk below minRr (crypto levels)', test: (r) => /^reward\/risk .* is below/.test(r) },
  { key: 'no_level_found', label: 'No support/resistance level found for a target', test: (r) => /no (resistance|support) level found|every (resistance|support) level found is within/.test(r) },
  { key: 'no_stop_possible', label: 'No stop level could be set', test: (r) => /no stop can be set|no pattern low \/ high and no 15-min swing/.test(r) },
  { key: 'no_free_balance', label: 'No free capital/balance left', test: (r) => r === 'no free virtual USDT balance' },
  { key: 'event_block', label: 'Event block (results / big event due)', test: (r) => r.includes('event block') },
  { key: 'sector_block', label: 'Sector block (sector against the trade)', test: (r) => r.includes('sector block') },
];

function categorize(reason) {
  const r = String(reason || '');
  for (const f of FILTERS) { if (f.test(r)) return f.key; }
  return 'other';
}

const labelOf = (key) => (FILTERS.find((f) => f.key === key) || {}).label || 'Other / uncategorised reason';

// ---- 1) tally: which filter blocks the most candidates -------------------------------------------------
function tallyFilters(skips) {
  const counts = new Map();
  for (const s of skips || []) {
    const key = categorize(s && s.reason);
    if (!counts.has(key)) counts.set(key, { key, label: labelOf(key), count: 0, examples: [] });
    const row = counts.get(key);
    row.count += 1;
    if (row.examples.length < 3) row.examples.push({ market: s.market, symbol: s.symbol, skip_date: s.skip_date, reason: s.reason });
  }
  const total = (skips || []).length;
  return [...counts.values()]
    .map((r) => ({ ...r, sharePct: total ? Math.round((r.count / total) * 1000) / 10 : null }))
    .sort((a, b) => b.count - a.count);
}

// ---- 2) win-rate "what if" estimate, by judge2-score band -----------------------------------------------
function bandOf(score) {
  if (score === null || score === undefined || score === '') return null; // missing, never coerced to 0
  const s = Number(score);
  if (!Number.isFinite(s)) return null;
  const lo = Math.max(0, Math.floor(s / SCORE_BAND) * SCORE_BAND);
  return `${lo}-${lo + SCORE_BAND}`;
}

// Buckets CLOSED trades by their stored judge2_score into SCORE_BAND-wide bands and reports each band's
// real, historical win rate. A band with fewer than MIN_BAND_TRADES real trades is "too few trades, no
// conclusion" (same bar judge.js's own ablation() uses) rather than guessed.
function scoreBandWinRates(closedTrades) {
  const bands = new Map();
  for (const t of closedTrades || []) {
    if (!t || t.status === 'open' || !Number.isFinite(Number(t.pnl_inr))) continue;
    const b = bandOf(t.judge2_score);
    if (!b) continue;
    if (!bands.has(b)) bands.set(b, []);
    bands.get(b).push(t);
  }
  const out = {};
  for (const [band, list] of bands) {
    const wins = list.filter((t) => Number(t.pnl_inr) > 0).length;
    out[band] = { trades: list.length, winRatePct: Math.round((wins / list.length) * 1000) / 10, enough: list.length >= MIN_BAND_TRADES };
  }
  return out;
}

// For take_threshold specifically: every skip row categorised as take_threshold that carries its own
// judge2_score is bucketed by score band, and each band's blocked count is matched against the REAL win
// rate of taken trades scoring similarly on the same parallel judge (scoreBandWinRates above). This is a
// historical analogy by score band, not a candle replay (paper_skips stores no OHLC - see file header).
function takeThresholdEstimate(skips, closedTrades) {
  const bands = scoreBandWinRates(closedTrades);
  const allBlocked = (skips || []).filter((s) => s && categorize(s.reason) === 'take_threshold');
  const scored = allBlocked.filter((s) => Number.isFinite(Number(s.judge2_score)));
  const byBand = new Map();
  for (const s of scored) {
    const b = bandOf(s.judge2_score);
    if (!b) continue;
    byBand.set(b, (byBand.get(b) || 0) + 1);
  }
  const byScoreBand = [...byBand.entries()].map(([band, blockedCount]) => {
    const live = bands[band];
    return {
      judge2ScoreBand: band,
      candidatesBlocked: blockedCount,
      comparableLiveTrades: live ? live.trades : 0,
      estimatedWinRatePct: live && live.enough ? live.winRatePct : null,
      note: live && live.enough
        ? `Estimate from ${live.trades} actually-taken trades that scored ${band} on Judge v2.`
        : `Too few comparable taken trades (band ${band}: ${live ? live.trades : 0}, needs ${MIN_BAND_TRADES}) - no conclusion.`,
    };
  }).sort((a, b) => b.candidatesBlocked - a.candidatesBlocked);
  return {
    filter: 'take_threshold',
    totalBlocked: allBlocked.length,
    scoredBlocked: scored.length,
    unscored: allBlocked.length - scored.length, // skip rows with no judge2_score (recorded before judge2 existed)
    byScoreBand,
    label: 'RETROSPECTIVE SIMULATION ESTIMATE - NOT A GUARANTEE. Historical analogy by Judge v2 score band (no OHLC stored per skip for a true candle replay).',
  };
}

// ---- 3) soft-weight Judge helpers: reuse judge.js's own, already-tested ablation() -------------------
function helperWeightImpact(closedTrades, config) {
  return ablation(closedTrades, config);
}

// ---- 4) filters that are NOT recorded per-candidate in paper_skips today ------------------------------
const UNMEASURED_NOTE = 'The liquidity/turnover floor (nse.min_turnover_inr, docs/UNIVERSE.md) is applied in '
  + "paperbot/bot.js's rankNse(), BEFORE a candidate ever reaches skip() - only an aggregate count is logged "
  + '(console.log), nothing is written to paper_skips for it. It cannot be tallied or estimated from stored '
  + 'data; instrumenting it is a follow-up, not invented here. (candle_availability IS tallied above - that '
  + 'check happens inside analyse(), after ranking, and does call skip().)';

// ---- top-level report -------------------------------------------------------------------------------
function buildFilterStrictnessReport({ skips, closedTrades, judgeConfig } = {}) {
  return {
    paperOnly: true,
    generatedAt: new Date().toISOString(),
    disclaimer: 'Suggestions only. Nothing here changes a live filter, threshold or Judge weight; the owner decides.',
    totalSkips: (skips || []).length,
    totalClosedTrades: (closedTrades || []).filter((t) => t && t.status !== 'open').length,
    filterTally: tallyFilters(skips),
    takeThresholdEstimate: takeThresholdEstimate(skips, closedTrades),
    helperWeightImpact: helperWeightImpact(closedTrades, judgeConfig),
    unmeasuredNote: UNMEASURED_NOTE,
  };
}

function toMarkdown(report) {
  const lines = [];
  lines.push('# Filter-strictness report (paper bot)');
  lines.push('');
  lines.push(`Generated ${report.generatedAt}. ${report.disclaimer}`);
  lines.push('');
  lines.push(`Stored skips examined: ${report.totalSkips}. Closed trades examined: ${report.totalClosedTrades}.`);
  lines.push('');
  lines.push('## Which filter blocks the most candidates');
  lines.push('');
  lines.push('| Filter | Blocked | Share of all skips |');
  lines.push('|---|---|---|');
  for (const f of report.filterTally) lines.push(`| ${f.label} | ${f.count} | ${f.sharePct == null ? '-' : `${f.sharePct}%`} |`);
  lines.push('');
  lines.push('## take_threshold (score 65+): retrospective win-rate estimate if loosened');
  lines.push('');
  lines.push(report.takeThresholdEstimate.label);
  lines.push('');
  const tt = report.takeThresholdEstimate;
  lines.push(`${tt.totalBlocked} candidates blocked by take_threshold (${tt.scoredBlocked} carry a Judge v2 score to estimate from; ${tt.unscored} do not, usually older rows).`);
  lines.push('');
  lines.push('| Judge v2 score band | Candidates blocked | Estimated win rate | Note |');
  lines.push('|---|---|---|---|');
  for (const r of tt.byScoreBand) lines.push(`| ${r.judge2ScoreBand} | ${r.candidatesBlocked} | ${r.estimatedWinRatePct == null ? 'no conclusion' : `${r.estimatedWinRatePct}%`} | ${r.note} |`);
  lines.push('');
  lines.push('## Judge helper weights: do they add value? (reuses the weekly ablation report, judge.js ablation())');
  lines.push('');
  lines.push('| Helper | Weight | With (trades / win%) | Without (trades / win%) | Verdict |');
  lines.push('|---|---|---|---|---|');
  for (const h of report.helperWeightImpact) {
    lines.push(`| ${h.helper} | ${h.weight} | ${h.with.trades} / ${h.with.winRatePct ?? '-'}% | ${h.without.trades} / ${h.without.winRatePct ?? '-'}% | ${h.verdict} |`);
  }
  lines.push('');
  lines.push('## Not measurable from stored data today');
  lines.push('');
  lines.push(report.unmeasuredNote);
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  categorize, FILTERS, tallyFilters, bandOf, scoreBandWinRates, takeThresholdEstimate, helperWeightImpact,
  buildFilterStrictnessReport, toMarkdown, SCORE_BAND, MIN_BAND_TRADES, UNMEASURED_NOTE,
};
