'use strict';
// Pure stats for /api/paper/bots-report (docs/BOTS.md "Leaderboard"). No I/O, no clock - just arrays of closed trades in, numbers out.
const { round } = require('../../lib/indicators');

const NO_CONCLUSION = 'too few trades, no conclusion';
const MIN_TRADES = 20;

const netOf = (t) => t.pnl_inr ?? t.net_pnl_inr ?? 0; // every bot's trade row carries pnl_inr = net, in rupees (docs/SCALP.md, docs/BOTS.md)
const grossOf = (t) => (Number.isFinite(t.gross_pnl_inr) ? t.gross_pnl_inr : netOf(t)); // no cost model recorded (e.g. intraday) = gross == net
const minutesOf = (t) => (t.exit_time && t.entry_time ? (Date.parse(t.exit_time) - Date.parse(t.entry_time)) / 60000 : null);
const exitMs = (t) => (t.exit_time ? Date.parse(t.exit_time) : Date.parse(t.entry_time));

// Max drawdown of the bot's own virtual balance: walks closed trades in the order they closed, tracks the running peak of
// cumulative net P&L, and returns the largest peak-to-trough drop seen (0 if the balance only ever grew).
function maxDrawdownInr(closed) {
  const ordered = [...closed].sort((a, b) => exitMs(a) - exitMs(b));
  let equity = 0; let peak = 0; let maxDd = 0;
  for (const t of ordered) {
    equity += netOf(t);
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return round(maxDd, 2);
}

function computeBotStats(closed, minTrades = MIN_TRADES) {
  const wins = closed.filter((t) => netOf(t) > 0);
  const losses = closed.filter((t) => netOf(t) < 0);
  const net = closed.reduce((s, t) => s + netOf(t), 0);
  const gross = closed.reduce((s, t) => s + grossOf(t), 0);
  const costs = gross - net;
  const mins = closed.map(minutesOf).filter((m) => Number.isFinite(m));
  return {
    trades: closed.length,
    winRatePct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
    netPnlInr: round(net, 2),
    grossPnlInr: round(gross, 2),
    costsInr: round(costs, 2),
    costPctOfGrossPnl: gross > 0 ? round((costs / gross) * 100, 1) : null, // gross <= 0: cost % of a non-positive gross is not a meaningful ratio
    avgWinInr: wins.length ? round(wins.reduce((s, t) => s + netOf(t), 0) / wins.length, 2) : null,
    avgLossInr: losses.length ? round(losses.reduce((s, t) => s + netOf(t), 0) / losses.length, 2) : null,
    maxDrawdownInr: maxDrawdownInr(closed),
    avgMinutes: mins.length ? round(mins.reduce((a, b) => a + b, 0) / mins.length, 1) : null,
    conclusion: closed.length >= minTrades ? 'enough trades' : NO_CONCLUSION,
    ranked: closed.length >= minTrades,
    lossAfterCosts: closed.length > 0 && net < 0,
  };
}

// Which bot's net INR that day was the highest, across every bot (no 20-trade floor here - it is just "who won the day", not a claim).
function dailyWinners(byBot) {
  const days = new Map(); // date -> Map(bot -> net)
  for (const [bot, closed] of Object.entries(byBot)) {
    for (const t of closed) {
      const date = new Date(exitMs(t)).toISOString().slice(0, 10);
      if (!days.has(date)) days.set(date, new Map());
      const m = days.get(date);
      m.set(bot, round((m.get(bot) || 0) + netOf(t), 2));
    }
  }
  return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, m]) => {
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1]);
    return { date, winner: rows[0][0], netInr: rows[0][1], all: Object.fromEntries(rows) };
  });
}

module.exports = { computeBotStats, dailyWinners, maxDrawdownInr, NO_CONCLUSION, MIN_TRADES, netOf, grossOf };
