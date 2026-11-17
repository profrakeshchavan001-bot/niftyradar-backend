'use strict';
/**
 * Daily Telegram report (05:00 IST), Hinglish, short. Pure text/data builder - no I/O, no Telegram, no
 * clock side effects (everything takes `now` as a parameter), so every case is testable without a
 * database. See fetch.js for how the trade lists this takes in are gathered.
 *
 * Period = yesterday 05:00 IST to today 05:00 IST (the 24 hours since the LAST report, since this runs
 * daily at 05:00). A trade's own exit_time decides which period it closed in (entry_time as a fallback,
 * same convention src/paper/bots/leaderboard/stats.js's exitMs() already uses).
 */
const { istParts, istDayStart } = require('../../../../paperbot/time');
const { computeBotStats } = require('../../bots/leaderboard/stats');
const { inr } = require('../../../../paperbot/report');
const { MIRROR_OF, REVERSE_OF } = require('./fetch');

const FIVE_AM_MS = 5 * 60 * 60 * 1000;

/** { startMs, endMs, endDate } for the 24h window ending at today's 05:00 IST, where "today" is whichever IST calendar day `now` falls in. */
function periodBounds(now = Date.now()) {
  const endMs = istDayStart(now) + FIVE_AM_MS; // today 05:00 IST
  return { startMs: endMs - 24 * 3600000, endMs, endDate: istParts(endMs).date };
}

const netOf = (t) => t.pnl_inr ?? t.net_pnl_inr ?? 0;
const grossOf = (t) => (Number.isFinite(t.gross_pnl_inr) ? t.gross_pnl_inr : netOf(t));
const exitMs = (t) => (t.exit_time ? Date.parse(t.exit_time) : Date.parse(t.entry_time));
const inPeriod = (t, b) => { const ms = exitMs(t); return Number.isFinite(ms) && ms >= b.startMs && ms < b.endMs; };
const round2 = (n) => Math.round(n * 100) / 100;

/** Every bot's trades that closed inside the period, flattened with their bot name attached, numbered 1..N in that order. */
function periodTrades(closedByBot, bounds) {
  let n = 0;
  const out = [];
  for (const [bot, trades] of Object.entries(closedByBot)) {
    for (const t of trades) {
      if (!inPeriod(t, bounds)) continue;
      n += 1;
      out.push({ n, bot, symbol: t.symbol, direction: t.direction, net: round2(netOf(t)) });
    }
  }
  return out;
}

function tradeLine(t) {
  const sign = t.net < 0 ? '-' : '+';
  const party = t.net > 0 ? ' \u{1F389}' : ''; // party popper for winners
  return `${t.n}. ${t.bot} | ${t.symbol} | ${t.direction} | ${sign}Rs ${Math.abs(t.net).toLocaleString('en-IN')}${party}`;
}

const MANY_TRADES_LIMIT = 30;
const TOP_N = 5;

/** The period section's lines (requirement 3): grouped by bot under the limit, top winners/losers + counts over it. */
function periodSection(trades, wins, losses, breakeven, netPeriod) {
  if (!trades.length) return ['Aaj 0 trade', `Period P&L: ${inr(netPeriod)}`];
  const lines = [`Aaj: ${trades.length} trade band hua (${wins} win, ${losses} loss, ${breakeven} BE)`, `Period P&L: ${inr(netPeriod)}`, ''];
  if (trades.length <= MANY_TRADES_LIMIT) {
    const byBot = new Map();
    for (const t of trades) { if (!byBot.has(t.bot)) byBot.set(t.bot, []); byBot.get(t.bot).push(t); }
    for (const [bot, botTrades] of byBot) {
      lines.push(`${bot}:`);
      for (const t of botTrades) lines.push(tradeLine(t));
    }
  } else {
    const bySize = [...trades].sort((a, b) => b.net - a.net);
    const topWinners = bySize.filter((t) => t.net > 0).slice(0, TOP_N);
    const topLosers = bySize.filter((t) => t.net < 0).slice(-TOP_N).reverse();
    lines.push(`${trades.length} trade the (top 5 winners + top 5 losers neeche):`, '', 'Top 5 Winners:');
    topWinners.forEach((t, i) => lines.push(`${i + 1}. ${tradeLine(t).replace(/^\d+\.\s*/, '')}`));
    lines.push('', 'Top 5 Losers:');
    topLosers.forEach((t, i) => lines.push(`${i + 1}. ${tradeLine(t).replace(/^\d+\.\s*/, '')}`));
  }
  return lines;
}

function openSection(openByBot) {
  const byBot = Object.entries(openByBot).filter(([, rows]) => rows.length);
  const count = byBot.reduce((s, [, rows]) => s + rows.length, 0);
  if (!count) return ['Abhi Open: 0 trade'];
  return [`Abhi Open: ${count} trade (${byBot.map(([bot, rows]) => `${bot}: ${rows.length}`).join(', ')})`];
}

/** computeBotStats() for every bot (reused directly, docs/BOTS.md), keyed by bot name - the "overall status since start" numbers. */
function overallStats(closedByBot) {
  return Object.fromEntries(Object.keys(closedByBot).map((bot) => [bot, computeBotStats(closedByBot[bot], 0)])); // minTrades 0: this section never hides a bot behind "too few trades"
}

function overallSection(stats) {
  const lines = ['', 'OVERALL STATUS (shuruaat se):'];
  let grandTrades = 0; let grandNet = 0; let grandFees = 0;
  for (const [original, mirror] of Object.entries(MIRROR_OF)) {
    // 3-way where a REVERSE bot exists (this task: intraday, scalp_wide) - original/MIRROR/REVERSE in
    // the same group; every other original stays original/MIRROR only, exactly as before.
    for (const bot of [original, mirror, REVERSE_OF[original]].filter(Boolean)) {
      const s = stats[bot];
      if (!s) continue;
      grandTrades += s.trades; grandNet += s.netPnlInr; grandFees += s.costsInr;
      lines.push(`${bot}: ${s.trades}T | ${s.winRatePct == null ? '-' : s.winRatePct + '%'} win | ${inr(s.netPnlInr)} | fees ${inr(s.costsInr)}`);
    }
  }
  lines.push('', `GRAND TOTAL: ${grandTrades}T | net ${inr(round2(grandNet))} | fees ${inr(round2(grandFees))}`);
  const withTrades = Object.entries(stats).filter(([, s]) => s.trades > 0);
  if (withTrades.length) {
    const best = withTrades.reduce((a, b) => (b[1].netPnlInr > a[1].netPnlInr ? b : a));
    const worst = withTrades.reduce((a, b) => (b[1].netPnlInr < a[1].netPnlInr ? b : a));
    lines.push(`Best bot so far: ${best[0]} (${inr(best[1].netPnlInr)})`, `Worst bot so far: ${worst[0]} (${inr(worst[1].netPnlInr)})`);
  } else {
    lines.push('Best bot so far: n/a (koi trade nahi abhi)', 'Worst bot so far: n/a (koi trade nahi abhi)');
  }
  return lines;
}

/** Builds the full report. Pure: `now`, `closedByBot`, `openByBot` are all inputs, nothing read here. */
function buildDailyReport({ now = Date.now(), closedByBot, openByBot }) {
  const bounds = periodBounds(now);
  const trades = periodTrades(closedByBot, bounds);
  const wins = trades.filter((t) => t.net > 0).length;
  const losses = trades.filter((t) => t.net < 0).length;
  const breakeven = trades.length - wins - losses;
  const netPeriod = round2(trades.reduce((s, t) => s + t.net, 0));
  const stats = overallStats(closedByBot);
  const lines = [
    `Daily Report (05:00 IST) - ${bounds.endDate}`, '',
    ...periodSection(trades, wins, losses, breakeven, netPeriod), '',
    ...openSection(openByBot),
    ...overallSection(stats),
  ];
  return {
    text: lines.join('\n'),
    data: {
      period: { from: new Date(bounds.startMs).toISOString(), to: new Date(bounds.endMs).toISOString() },
      trades: trades.length, wins, losses, breakeven, netPeriodInr: netPeriod,
      open: Object.fromEntries(Object.entries(openByBot).map(([k, v]) => [k, v.length])),
      stats,
    },
  };
}

module.exports = { buildDailyReport, periodBounds, periodTrades, overallStats, netOf, grossOf, exitMs };
