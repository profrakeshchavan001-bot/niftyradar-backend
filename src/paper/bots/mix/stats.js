'use strict';
// Mix: SUGGESTIONS ONLY (docs/BOTS.md). Never trades, never changes anything - a read-only "what would a score-weighted vote of the
// bots have done" view, built purely from trades every bot ALREADY took. Pure functions, no I/O.
const { round } = require('../../lib/indicators');
const { netOf, rFactorOf } = require('../leaderboard/stats');

const dirSign = (d) => (d === 'LONG' || d === 'up' ? 1 : d === 'SHORT' || d === 'down' ? -1 : 0);

// weight[bot] = that bot's own win rate (0-1), but ONLY for bots with >= minTrades closed trades; every other bot gets weight 0 -
// "suggested weights only from bots with 20+ trades" (docs/BOTS.md). Not normalized here; normalized per-event in buildSuggestions
// (so a vote only ever reflects the bots that actually had an opinion on that one candle).
function computeWeights(statsByBot, minTrades = 20) {
  const weights = {};
  for (const [bot, s] of Object.entries(statsByBot)) {
    weights[bot] = s.trades >= minTrades ? (s.winRatePct || 0) / 100 : 0;
  }
  return weights;
}

// `tradesByBot`: { bot: [closed trade, ...] }. Groups trades by (symbol, trigger_t) - the same candle, looked at by 2+ bots - and
// for each such group with at least one non-zero weight, works out the score-weighted vote and a weighted-average paper result
// (an APPROXIMATION: each bot's own entry/stop/target differ slightly, so this is the blend of what each bot actually scored on
// that candle, not a fresh backtest of a single combined position - said so again in the report itself, not just here).
function buildSuggestions(tradesByBot, weights) {
  const groups = new Map(); // "symbol|trigger_t" -> [{bot, direction, pnl_inr}]
  for (const [bot, trades] of Object.entries(tradesByBot)) {
    for (const t of trades) {
      const key = `${t.symbol}|${t.trigger_t}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ bot, symbol: t.symbol, trigger_t: t.trigger_t, direction: t.direction, pnl_inr: netOf(t) });
    }
  }
  const out = [];
  for (const [key, entries] of groups) {
    if (entries.length < 2) continue; // only one bot ever looked at this candle - nothing to vote on
    const weighted = entries.filter((e) => (weights[e.bot] || 0) > 0);
    if (!weighted.length) continue; // no participant has 20+ trades yet - no suggested weight to vote with
    const totalW = weighted.reduce((s, e) => s + weights[e.bot], 0);
    const score = weighted.reduce((s, e) => s + weights[e.bot] * dirSign(e.direction), 0) / totalW;
    const suggestedDirection = score > 0.05 ? 'LONG' : score < -0.05 ? 'SHORT' : 'no agreement';
    const weightedPnlInr = round(weighted.reduce((s, e) => s + weights[e.bot] * e.pnl_inr, 0) / totalW, 2);
    out.push({
      symbol: entries[0].symbol, trigger_t: entries[0].trigger_t, score: round(score, 3), suggestedDirection, weightedPnlInr,
      bots: entries.map((e) => ({ bot: e.bot, direction: e.direction, pnl_inr: e.pnl_inr, weight: round(weights[e.bot] || 0, 3) })),
    });
  }
  return out.sort((a, b) => a.trigger_t - b.trigger_t);
}

// ---- "mix candidate" analysis (Task Group C): descriptive only, never wired to anything that trades. ---------------------------
// For each bot, looks at which entry pattern / SMC tag shows up most, in the bot's own best-performing trades, compared to all of
// its trades, and what that bot's own static filter floor (min reward/risk after costs) already is. The output is a plain
// description of what a "best-of" combined bot's entry+filter rule-set would look like if assembled from these slices - it never
// changes a live filter, threshold or bot, and builds no new engine.

// Known, static per-bot filter floors (docs/BOTS.md / each bot's own config.js min_rr - read here, never written).
const KNOWN_MIN_RR = { scalp: 1.0, scalp_wide: 1.0, exhaustion_only: 1.2, trend_smc: 1.5 };

// basis text -> named tag. Matches the exact phrases each bot's engine.js writes into `basis` (docs/BOTS.md worked examples).
const TAG_PATTERNS = [
  ['order_block', /order block/i],
  ['fvg_retest', /\bfvg\b/i],
  ['liquidity_sweep', /liquidity sweep/i],
  ['ema_cross', /ema9\/21 cross/i],
  ['exhaustion_reversal', /exhaustion/i],
  ['engulfing', /engulfing/i],
  ['hammer', /hammer/i],
  ['shooting_star', /shooting star/i],
  ['morning_star', /morning star/i],
  ['evening_star', /evening star/i],
  ['inside_bar', /inside bar/i],
  ['discount_zone', /discount zone/i],
  ['premium_zone', /premium zone/i],
];

function tagsOf(basis) {
  const text = String(basis ?? '');
  return TAG_PATTERNS.filter(([, re]) => re.test(text)).map(([tag]) => tag);
}

function tagCounts(trades) {
  const out = {};
  for (const t of trades) for (const tag of tagsOf(t.basis)) out[tag] = (out[tag] || 0) + 1;
  return out;
}

const avgOf = (arr) => (arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 2) : null);

// The bot's own best-performing slice: top `fraction` of its closed trades by net P&L (at least `minCount`, never more than it has),
// kept only where that trade was actually a winner - a "best slice" of an all-losing bot is not a best-practice example of anything.
function bestSlice(closed, fraction = 0.3, minCount = 3) {
  const sorted = [...closed].sort((a, b) => netOf(b) - netOf(a));
  const n = Math.min(sorted.length, Math.max(minCount, Math.ceil(sorted.length * fraction)));
  return sorted.slice(0, n).filter((t) => netOf(t) > 0);
}

// One bot's slice of the analysis: its best trades' tag mix and avg R vs its trades overall, plus its own static filter floor.
function mixCandidateForBot(bot, closed) {
  const best = bestSlice(closed);
  const bestCounts = tagCounts(best);
  const allCounts = tagCounts(closed);
  const topTags = Object.entries(bestCounts)
    .map(([tag, bestCount]) => ({
      tag, bestCount,
      bestSharePct: best.length ? round((bestCount / best.length) * 100, 1) : null,
      allSharePct: closed.length ? round(((allCounts[tag] || 0) / closed.length) * 100, 1) : null,
    }))
    .sort((a, b) => b.bestSharePct - a.bestSharePct)
    .slice(0, 3);
  return {
    totalClosed: closed.length,
    bestCount: best.length,
    avgRFactorBest: avgOf(best.map(rFactorOf).filter((v) => v != null)),
    avgRFactorAll: avgOf(closed.map(rFactorOf).filter((v) => v != null)),
    knownMinRr: KNOWN_MIN_RR[bot] ?? null, // the bot's own, unchanged, static reward/risk floor - context, not a measurement
    topTagsInBestTrades: topTags,
  };
}

// One line per bot with enough best trades to say anything, describing what its slice of a combined rule-set would look like.
function describeMixCandidate(perBot) {
  const lines = [];
  for (const [bot, m] of Object.entries(perBot)) {
    if (!m.bestCount) { lines.push(`${bot}: not enough winning trades yet to say which entry/filter its best slice shares.`); continue; }
    const top = m.topTagsInBestTrades[0];
    const tagPart = top ? `leans on "${top.tag}" (${top.bestSharePct}% of its best trades vs ${top.allSharePct}% of all its trades)` : 'shows no single pattern/tag standing out in its best trades yet';
    const rrPart = m.knownMinRr != null ? `, gated at its own reward/risk floor >= ${m.knownMinRr}` : '';
    lines.push(`${bot}: its best trades ${tagPart}, averaging R ${m.avgRFactorBest ?? '-'} vs ${m.avgRFactorAll ?? '-'} overall${rrPart}.`);
  }
  return lines;
}

// Across every bot's slice: which single bot+tag combination looks the strongest candidate "building block" for a hypothetical
// best-of mix - picked by the highest bestSharePct lift (best share minus overall share) among bots with at least 1 best trade, a
// plain ranking of the same numbers above, never a new decision rule.
function strongestCandidate(perBot) {
  let winner = null;
  for (const [bot, m] of Object.entries(perBot)) {
    const top = m.topTagsInBestTrades[0];
    if (!top || !m.bestCount) continue;
    const lift = (top.bestSharePct ?? 0) - (top.allSharePct ?? 0);
    if (!winner || lift > winner.lift) winner = { bot, tag: top.tag, lift: round(lift, 1), bestSharePct: top.bestSharePct, avgRFactorBest: m.avgRFactorBest };
  }
  return winner;
}

// Builds the whole mix-candidate section from { bot: [closed trade, ...] }. Pure, no I/O - the route supplies the trades.
function buildMixCandidate(tradesByBot) {
  const perBot = Object.fromEntries(Object.entries(tradesByBot).map(([bot, closed]) => [bot, mixCandidateForBot(bot, closed)]));
  return { perBot, description: describeMixCandidate(perBot), strongest: strongestCandidate(perBot) };
}

module.exports = { computeWeights, buildSuggestions, buildMixCandidate, tagsOf, KNOWN_MIN_RR };
