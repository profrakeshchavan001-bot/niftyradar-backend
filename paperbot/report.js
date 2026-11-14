'use strict';
// Paper bot reports: end-of-day summary, per-pattern stats, Sunday suggestions.
// Reports only describe what happened. They never change a rule.
const P = require('./patterns');
const { istParts } = require('./time');

const inr = (x) => `Rs ${x >= 0 ? '+' : '-'}${Math.abs(Math.round(x)).toLocaleString('en-IN')}`;

// Win-rate and average P&L per pattern over closed trades. A trade that fired
// two patterns counts once under each of them.
function patternStats(closed, minTrades = 20) {
  const by = new Map();
  for (const t of closed) {
    for (const name of t.patterns || []) {
      if (!by.has(name)) by.set(name, { pattern: name, trades: 0, wins: 0, pnl: 0 });
      const s = by.get(name);
      s.trades += 1;
      if (t.pnl_inr > 0) s.wins += 1;
      s.pnl += t.pnl_inr || 0;
    }
  }
  return [...by.values()].map((s) => ({
    pattern: s.pattern, trades: s.trades, wins: s.wins,
    winRatePct: P.round(s.wins / s.trades * 100, 1), avgPnlInr: P.round(s.pnl / s.trades, 2), totalPnlInr: P.round(s.pnl, 2),
    enough: s.trades >= minTrades,
  })).sort((a, b) => b.trades - a.trades || a.pattern.localeCompare(b.pattern));
}

function statsLines(stats, minTrades) {
  if (!stats.length) return ['(no closed trades yet)'];
  return stats.map((s) => `${s.pattern}: ${s.trades} trades, win ${s.winRatePct}%, avg ${inr(s.avgPnlInr)}${s.enough ? '' : ` (fewer than ${minTrades} trades, no conclusion)`}`);
}

function triggerText(t) {
  return (t.trigger_candles || []).map((g) => `${g.pattern}: ${g.candles.map((k) => `O${k.o} H${k.h} L${k.l} C${k.c}`).join(' | ')}`).join('\n   ');
}

// End-of-day text for one market. `trades` = the day's trades (open or closed),
// `allClosed` = every closed trade of that market since the start.
function dailySummary({ market, date, trades, allClosed, minTrades = 20 }) {
  const label = market === 'nse' ? 'NSE' : 'CRYPTO';
  const lines = [`NiftyRadar PAPER bot (demo, no real money)`, `${label} summary ${date}`, ''];
  if (!trades.length) lines.push('No trades today.');
  trades.forEach((t, i) => {
    const score = market === 'nse' ? `R ${t.r_factor}${t.legacy_rf != null ? ` (old move-size value ${t.legacy_rf})` : ''}` : `score ${t.r_factor}`;
    lines.push(`${i + 1}) ${t.symbol} ${t.direction} · ${score} · ${(t.patterns || []).join(' + ')}${t.simulated_option ? ' · SIMULATED option price' : ''}`);
    lines.push(`   ${triggerText(t)}`);
    lines.push(`   Why: ${t.basis}`);
    lines.push(t.status === 'closed'
      ? `   In ${t.entry_price} -> out ${t.exit_price} · exit: ${t.exit_reason} · P&L ${inr(t.pnl_inr)}`
      : `   In ${t.entry_price} · still open`);
  });
  const closed = trades.filter((t) => t.status === 'closed');
  const wins = closed.filter((t) => t.pnl_inr > 0).length;
  const pnl = closed.reduce((s, t) => s + (t.pnl_inr || 0), 0);
  lines.push('', `Day total: ${trades.length} trades, ${wins} wins, P&L ${inr(pnl)}${trades.length > closed.length ? ` (${trades.length - closed.length} still open)` : ''}`);
  const stats = patternStats(allClosed, minTrades);
  lines.push('', 'Per pattern since start:', ...statsLines(stats, minTrades));
  return { text: lines.join('\n'), data: { market, date, trades: trades.length, closed: closed.length, wins, pnlInr: P.round(pnl, 2), patternStats: stats } };
}

// Sunday report. Suggestions only: the bot applies nothing by itself.
function weeklySuggestions({ date, closed, skips, minTrades = 20, config }) {
  const lines = ['NiftyRadar PAPER bot: weekly suggestions', `Week ending ${date}`, 'Nothing below is applied. Rules change only when the owner says so.', ''];
  const stats = patternStats(closed, minTrades);
  const keep = [];
  const drop = [];
  const unsure = [];
  for (const s of stats) {
    if (!s.enough) unsure.push(s);
    else if (s.avgPnlInr > 0) keep.push(s);
    else drop.push(s);
  }
  lines.push('PATTERNS');
  if (!stats.length) lines.push('No closed trades yet.');
  keep.forEach((s) => lines.push(`Worked: ${s.pattern} (${s.trades} trades, win ${s.winRatePct}%, avg ${inr(s.avgPnlInr)}). Suggest: keep.`));
  drop.forEach((s) => lines.push(`Did not work: ${s.pattern} (${s.trades} trades, win ${s.winRatePct}%, avg ${inr(s.avgPnlInr)}). Suggest: consider dropping.`));
  unsure.forEach((s) => lines.push(`${s.pattern}: ${s.trades} trades. Too few trades, no conclusion.`));

  lines.push('', 'FILTERS (setups skipped in the last 7 days)');
  const reasons = new Map();
  for (const s of skips) {
    const key = s.reason.replace(/"[^"]*"/g, '"..."').replace(/\(.*?\)/g, '').replace(/\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 80);
    reasons.set(key, (reasons.get(key) || 0) + 1);
  }
  if (!reasons.size) lines.push('No skips recorded.');
  [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([r, n]) => lines.push(`${n}x ${r}`));
  lines.push('The bot does not know how skipped setups would have ended, so it cannot say if a filter helped.');

  lines.push('', 'THRESHOLDS');
  for (const market of ['nse', 'crypto']) {
    const rows = closed.filter((t) => t.market === market);
    const cfg = config[market];
    if (rows.length < minTrades) { lines.push(`${market.toUpperCase()}: ${rows.length} closed trades. Too few trades, no conclusion.`); continue; }
    const by = (r) => rows.filter((t) => String(t.exit_reason).startsWith(r)).length;
    const stopped = rows.filter((t) => t.exit_reason === 'stop');
    const half = cfg.target_pct / 2;
    const nearMiss = stopped.filter((t) => (t.max_fav_pct || 0) >= half).length;
    lines.push(`${market.toUpperCase()}: ${rows.length} closed trades. Target ${by('target')}, stop ${by('stop')}, time/other ${rows.length - by('target') - by('stop')}.`);
    lines.push(`Of ${stopped.length} stopped trades, ${nearMiss} were first up ${half}% or more (half the target).`);
    if (stopped.length && nearMiss / stopped.length >= 0.4) lines.push(`Idea to review: a smaller target (near ${half}%) or moving the stop to cost after +${half}% may look better. Not applied.`);
    else lines.push('No threshold change suggested by this data.');
  }
  return { text: lines.join('\n'), data: { date, patternStats: stats, keep: keep.map((s) => s.pattern), drop: drop.map((s) => s.pattern), tooFew: unsure.map((s) => s.pattern) } };
}

// Sends text to the existing Telegram bot (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
// Returns false when the env vars are missing or the send fails; the caller
// stores the summary in daily_summaries either way.
async function sendTelegram(axios, env, text, log = console.log) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    for (let i = 0; i < text.length; i += 3900) {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: text.slice(i, i + 3900), disable_web_page_preview: true }, { timeout: 15000 });
    }
    return true;
  } catch (e) {
    log(`[paperbot] Telegram send failed: ${e.response?.status || 'network error'}`); // never log the URL: it holds the token
    return false;
  }
}

function createReporter({ store, axios, env = process.env, now = Date.now, log = console.log, loadConfig }) {
  async function publish(kind, date, report) {
    const sent = await sendTelegram(axios, env, report.text, log); // Telegram first: it must not depend on the database
    let stored = true;
    try { await store.saveSummary({ kind, summary_date: date, body: report.text, data: report.data, telegram_sent: sent }); } catch (e) { stored = false; log(`[paperbot] ${kind} could not be stored: ${e.message}`); }
    log(`[paperbot] ${kind} ${date}: ${stored ? 'stored' : 'NOT stored'}, ${sent ? 'sent to Telegram' : 'Telegram not sent'}`);
    return { ...report, telegram_sent: sent };
  }
  return {
    async daily(market) {
      const cfg = await loadConfig(store);
      const date = istParts(now()).date;
      const report = dailySummary({ market, date, trades: await store.tradesForDay(market, date), allClosed: await store.closedTrades(market), minTrades: cfg.learning.min_trades_for_conclusion });
      return publish(`${market}_daily`, date, report);
    },
    async weekly() {
      const cfg = await loadConfig(store);
      const date = istParts(now()).date;
      const weekAgo = istParts(now() - 7 * 86400000).date;
      const report = weeklySuggestions({ date, closed: await store.closedTrades(null), skips: await store.skipsSince(weekAgo), minTrades: cfg.learning.min_trades_for_conclusion, config: cfg });
      return publish('weekly_suggestions', date, report);
    },
  };
}

module.exports = { patternStats, dailySummary, weeklySuggestions, sendTelegram, createReporter, inr };
