'use strict';
// GROUP 7: weekly scoreboard, pure text/data builder - no I/O, no clock side effects, no Telegram. Covers
// EVERY demo bot in the repo, existing ones included, read-only aggregation (never alters any bot's data).
// Reuses computeBotStats (src/paper/bots/leaderboard/stats.js) exactly as the daily report already does
// (src/paper/ops/dailyReport/report.js) - no new metric math is invented here.
const { computeBotStats } = require('../../bots/leaderboard/stats');
const { inr } = require('../../../../paperbot/report');
const { istParts, istDayStart } = require('../../../../paperbot/time');

const SEVEN_DAYS_MS = 7 * 86400000;
const MIN_TRADES_FOR_VERDICT = 30; // "too early" below this, per the task's own instruction

const exitMs = (t) => (t.exit_time ? Date.parse(t.exit_time) : Date.parse(t.entry_time));

/**
 * Status label heuristic (documented here, as the task asks, since this is the ONE place it is decided):
 *   - fewer than MIN_TRADES_FOR_VERDICT (30) trades, lifetime -> "too early" (no verdict is honest with this few)
 *   - net P&L lifetime > 0 AND win rate >= 40% -> "ahead" (profitable, and not just from a couple of huge wins
 *     dragging a mostly-losing system into the black - the win-rate floor guards against that)
 *   - everything else (net <= 0, or net > 0 but win rate below 40%) -> "under review" (not yet trusted either way)
 * This is a REPORTING heuristic only - it never disables, pauses or changes any bot's behaviour.
 */
function statusLabel(stats) {
  if (stats.trades < MIN_TRADES_FOR_VERDICT) return 'too early';
  if (stats.netPnlInr > 0 && stats.winRatePct >= 40) return 'ahead';
  return 'under review';
}

/** { startMs, endMs } for the 7 days ending at today's 09:00 IST (the report's own run time, Sunday 09:00 IST). */
function periodBounds(now = Date.now()) {
  const endMs = istDayStart(now) + 9 * 3600000;
  return { startMs: endMs - SEVEN_DAYS_MS, endMs };
}

function weeklyStats(closedByBot, bounds) {
  const out = {};
  for (const [bot, trades] of Object.entries(closedByBot)) {
    const inWeek = trades.filter((t) => { const ms = exitMs(t); return Number.isFinite(ms) && ms >= bounds.startMs && ms < bounds.endMs; });
    out[bot] = { week: computeBotStats(inWeek, 0), lifetime: computeBotStats(trades, 0) };
  }
  return out;
}

function buildWeeklyScoreboard({ now = Date.now(), closedByBot }) {
  const bounds = periodBounds(now);
  const stats = weeklyStats(closedByBot, bounds);
  const rows = Object.entries(stats).filter(([, s]) => s.lifetime.trades > 0 || s.week.trades > 0).sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [`Weekly Scoreboard (Sunday 09:00 IST) - week ending ${istParts(bounds.endMs).date}`, ''];
  let grandWeekNet = 0; let grandLifeNet = 0; let grandLifeTrades = 0;
  if (!rows.length) {
    lines.push('No demo bot has a closed trade yet.');
  } else {
    for (const [bot, s] of rows) {
      const label = statusLabel(s.lifetime);
      grandWeekNet += s.week.netPnlInr || 0; grandLifeNet += s.lifetime.netPnlInr || 0; grandLifeTrades += s.lifetime.trades;
      lines.push(`${bot}: this week ${s.week.trades}T ${inr(s.week.netPnlInr || 0)} | lifetime ${s.lifetime.trades}T, ${s.lifetime.winRatePct == null ? '-' : s.lifetime.winRatePct + '%'} win, ${inr(s.lifetime.netPnlInr || 0)} -> ${label}`);
    }
  }
  lines.push('', `GRAND TOTAL: this week net ${inr(Math.round(grandWeekNet * 100) / 100)} | lifetime ${grandLifeTrades}T, net ${inr(Math.round(grandLifeNet * 100) / 100)}`);
  return {
    text: lines.join('\n'),
    data: { period: { from: new Date(bounds.startMs).toISOString(), to: new Date(bounds.endMs).toISOString() }, stats, grandWeekNetInr: Math.round(grandWeekNet * 100) / 100, grandLifetimeNetInr: Math.round(grandLifeNet * 100) / 100 },
  };
}

module.exports = { buildWeeklyScoreboard, statusLabel, periodBounds, weeklyStats, MIN_TRADES_FOR_VERDICT };
