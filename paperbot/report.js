'use strict';
// Paper bot reports: end-of-day summary, per-pattern stats, Sunday suggestions.
// Reports only describe what happened. They never change a rule.
const P = require('./patterns');
const { weeklyAblationReport, loadJudgeConfig } = require('../src/paper/decision/judge');
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

// Overnight item 2: one normalized line per skip reason, shared by the daily and the weekly report so
// "skips grouped by reason" means the same thing in both places. Strips the specific numbers/quotes/symbol
// text out of a reason so "RSI 71.3 > 70" and "RSI 68.9 > 70" count as the same reason.
function normalizeReason(reason) {
  return String(reason || '').replace(/"[^"]*"/g, '"..."').replace(/\(.*?\)/g, '').replace(/\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 80);
}
function groupSkipsByReason(skips, top = 8) {
  const reasons = new Map();
  for (const s of skips) { const key = normalizeReason(s.reason); reasons.set(key, (reasons.get(key) || 0) + 1); }
  return [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([reason, count]) => ({ reason, count }));
}

// Net P&L of each trade (INR for nse/nse_scalp, net_pnl_usdt→INR via fx_rate for crypto variants when
// pnl_inr itself was not stored). Falls back to pnl_inr, which is already in INR for every bot today.
const pnlOf = (t) => (t.pnl_inr != null ? t.pnl_inr : 0);

// Overnight item 2: net INR, wins/losses and the day's best/worst trade for each bot. `tradesByBot` =
// { label: trades[] } (today's trades of one market/bot variant, open or closed). Pure; never guesses a
// number for a bot with zero trades today - it is just left out.
function perBotBreakdown(tradesByBot) {
  const rows = [];
  for (const [bot, trades] of Object.entries(tradesByBot)) {
    const closed = trades.filter((t) => t.status === 'closed');
    if (!trades.length) continue;
    const wins = closed.filter((t) => pnlOf(t) > 0).length;
    const losses = closed.filter((t) => pnlOf(t) <= 0).length;
    const netInr = P.round(closed.reduce((s, t) => s + pnlOf(t), 0), 2);
    rows.push({ bot, trades: trades.length, closed: closed.length, open: trades.length - closed.length, wins, losses, netInr });
  }
  return rows;
}

// Best and worst CLOSED trade of a list by P&L, or null when there are none. Ties keep the earlier one.
function bestWorstTrade(trades) {
  const closed = trades.filter((t) => t.status === 'closed');
  if (!closed.length) return null;
  const best = closed.reduce((a, b) => (pnlOf(b) > pnlOf(a) ? b : a));
  const worst = closed.reduce((a, b) => (pnlOf(b) < pnlOf(a) ? b : a));
  return { best: { symbol: best.symbol, pnlInr: pnlOf(best), basis: best.basis }, worst: { symbol: worst.symbol, pnlInr: pnlOf(worst), basis: worst.basis } };
}

// Overnight item 2, "what to learn": suggestions only, from patterns that fired today, worded so nothing
// reads as applied. Never claims a conclusion below minTrades.
function whatToLearn(todaysClosed, allClosedStats, minTrades) {
  if (todaysClosed.length < minTrades) return [`Too few trades today (${todaysClosed.length}) to learn anything new. Suggestion only, nothing changed.`];
  const today = patternStats(todaysClosed, 1).sort((a, b) => b.avgPnlInr - a.avgPnlInr);
  if (!today.length) return ['No pattern fired today.'];
  const lines = [];
  const good = today[0];
  const sinceStart = allClosedStats.find((s) => s.pattern === good.pattern);
  lines.push(`${good.pattern} looked best today (avg ${inr(good.avgPnlInr)})${sinceStart && sinceStart.enough ? `, and since the start it is ${sinceStart.avgPnlInr > 0 ? 'still profitable' : 'still a net loss'} (${sinceStart.trades} trades) - worth a look, nothing changed automatically.` : '. One day is not a conclusion; nothing changed automatically.'}`);
  return lines;
}

// End-of-day text for one market. `trades` = the day's trades (open or closed) of the MAIN market
// ('nse'/'crypto'), `allClosed` = every closed trade of that market since the start, `skipsToday` = today's
// skips of that market, `variantTrades` = { 'nse_scalp': trades[], ... } other bots of the same market
// family that ran today (own markets, see sql/paper_bot.sql's market CHECK), for the per-bot breakdown.
function dailySummary({ market, date, trades, allClosed, minTrades = 20, skipsToday = [], variantTrades = {} }) {
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

  const byBot = perBotBreakdown({ [market]: trades, ...variantTrades });
  if (byBot.length > 1) { // more than just the main market itself: a variant bot also traded today
    lines.push('', 'By bot:');
    byBot.forEach((b) => lines.push(`${b.bot}: ${b.trades} trades (${b.wins}W/${b.losses}L${b.open ? `, ${b.open} open` : ''}), net ${inr(b.netInr)}`));
  }

  const allOfDay = [trades, ...Object.values(variantTrades)].flat();
  const bw = bestWorstTrade(allOfDay);
  if (bw) lines.push('', `Best trade: ${bw.best.symbol} ${inr(bw.best.pnlInr)}`, `Worst trade: ${bw.worst.symbol} ${inr(bw.worst.pnlInr)}`);

  const skipGroups = groupSkipsByReason(skipsToday);
  lines.push('', 'Skips today (by reason):');
  if (!skipGroups.length) lines.push('No skips recorded today.');
  else skipGroups.forEach((g) => lines.push(`${g.count}x ${g.reason}`));

  const stats = patternStats(allClosed, minTrades);
  lines.push('', 'Per pattern since start:', ...statsLines(stats, minTrades));
  lines.push('', 'What to learn (suggestion only, nothing changed):', ...whatToLearn(allOfDay.filter((t) => t.status === 'closed'), stats, minTrades));
  return {
    text: lines.join('\n'),
    data: { market, date, trades: trades.length, closed: closed.length, wins, pnlInr: P.round(pnl, 2), patternStats: stats, byBot, bestWorst: bw, skipsByReason: skipGroups },
  };
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
  const weeklySkipGroups = groupSkipsByReason(skips);
  if (!weeklySkipGroups.length) lines.push('No skips recorded.');
  weeklySkipGroups.forEach((g) => lines.push(`${g.count}x ${g.reason}`));
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

// Overnight item 2: the 04:45 IST morning brief. Pure; every count below is real (closed trades' pnlOf(),
// `openByBot`'s actual row counts, `alertsOvernight`'s actual stored rows) - never a guessed number.
function morningBrief({ date, yesterday, nseYesterday, cryptoOvernight, openByBot, alertsOvernight = [] }) {
  const netOf = (trades) => P.round(trades.filter((t) => t.status === 'closed').reduce((s, t) => s + pnlOf(t), 0), 2);
  const lines = [`NiftyRadar PAPER bot (demo, no real money)`, `Morning brief ${date} (overnight, since the evening summaries)`, ''];
  lines.push(`NSE yesterday (${yesterday}): ${nseYesterday.length} trade(s)${nseYesterday.length ? `, net ${inr(netOf(nseYesterday))}` : ''}.`);
  lines.push(`Crypto overnight: ${cryptoOvernight.length} trade(s)${cryptoOvernight.length ? `, net ${inr(netOf(cryptoOvernight))}` : ''}.`);
  lines.push('', 'Open right now:');
  const openRows = Object.entries(openByBot).filter(([, trades]) => trades.length);
  if (!openRows.length) lines.push('No open trades.');
  openRows.forEach(([bot, trades]) => lines.push(`${bot}: ${trades.length} open (${trades.map((t) => t.symbol).join(', ')})`));
  lines.push('', 'Alerts overnight:');
  if (!alertsOvernight.length) lines.push('No alerts.');
  else alertsOvernight.forEach((a) => lines.push(`${a.kind} (${a.subject}): ${a.message}`));
  return {
    text: lines.join('\n'),
    data: { date, nseYesterdayCount: nseYesterday.length, cryptoOvernightCount: cryptoOvernight.length, openCounts: Object.fromEntries(Object.entries(openByBot).map(([k, v]) => [k, v.length])), alertsOvernightCount: alertsOvernight.length },
  };
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

// Bot variants that share a main market's family (sql/paper_bot.sql's market CHECK), for the daily
// summary's "by bot" section and the morning brief's open-trades snapshot. exhaustion_only is NOT here:
// it keeps its own table (src/paper/bots/exhaustion_only/store.js) and its own report page on purpose -
// see docs/decisions/CC4.md for why it is out of scope for this summary.
const VARIANT_MARKETS = { nse: ['nse_scalp'], crypto: ['crypto_scalp', 'crypto_wide_scalp'] };

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
      const variants = VARIANT_MARKETS[market] || [];
      const [trades, allClosed, skipsSinceToday, ...variantTradesArr] = await Promise.all([
        store.tradesForDay(market, date), store.closedTrades(market), store.skipsSince(date, market),
        ...variants.map((v) => store.tradesForDay(v, date)),
      ]);
      const skipsToday = skipsSinceToday.filter((s) => s.skip_date === date);
      const variantTrades = Object.fromEntries(variants.map((v, i) => [v, variantTradesArr[i]]));
      const report = dailySummary({ market, date, trades, allClosed, minTrades: cfg.learning.min_trades_for_conclusion, skipsToday, variantTrades });
      return publish(`${market}_daily`, date, report);
    },
    // Overnight item 2: stored at 04:45 IST, covering since the evening summaries (NSE 15:45, crypto
    // 23:55) - yesterday's full NSE day (in case it was missed), crypto trades since then, every open
    // trade right now, and any alerts the alerts plugin stored overnight. Real counts only.
    async morningBrief() {
      const date = istParts(now()).date;
      const yesterday = istParts(now() - 86400000).date;
      const openMarkets = ['nse', ...VARIANT_MARKETS.nse, 'crypto', ...VARIANT_MARKETS.crypto];
      const [nseYesterday, cryptoYesterday, cryptoToday, ...openArr] = await Promise.all([
        store.tradesForDay('nse', yesterday), store.tradesForDay('crypto', yesterday), store.tradesForDay('crypto', date),
        ...openMarkets.map((m) => store.openTrades(m)),
      ]);
      const openByBot = Object.fromEntries(openMarkets.map((m, i) => [m, openArr[i]]));
      let alertsOvernight = [];
      if (typeof store.query === 'function') {
        try { alertsOvernight = (await store.query('SELECT kind, subject, message, created_at FROM paper_alerts WHERE created_at > $1 ORDER BY created_at', [new Date(now() - 12 * 3600000).toISOString()])).rows; }
        catch (e) { /* alerts table may not exist yet (plugin not loaded, or db down) - the brief still goes out */ }
      }
      const report = morningBrief({ date, yesterday, nseYesterday, cryptoOvernight: [...cryptoYesterday, ...cryptoToday], openByBot, alertsOvernight });
      return publish('morning_brief', date, report);
    },
    async weekly() {
      const cfg = await loadConfig(store);
      const date = istParts(now()).date;
      const weekAgo = istParts(now() - 7 * 86400000).date;
      const report = weeklySuggestions({ date, closed: await store.closedTrades(null), skips: await store.skipsSince(weekAgo), minTrades: cfg.learning.min_trades_for_conclusion, config: cfg });
      const out = await publish('weekly_suggestions', date, report);
      // which judge helper adds value (docs/JUDGE.md): a second message; suggestions only, nothing is applied
      try {
        const jr = weeklyAblationReport({ date, closed: await store.closedTrades(null), config: await loadJudgeConfig(store) });
        await publish('judge_ablation', date, jr);
      } catch (e) { log(`[paperbot] judge ablation report failed: ${e.message}`); }
      return out;
    },
  };
}

module.exports = {
  patternStats, dailySummary, weeklySuggestions, morningBrief, sendTelegram, createReporter, inr,
  groupSkipsByReason, perBotBreakdown, bestWorstTrade, whatToLearn, VARIANT_MARKETS,
};
