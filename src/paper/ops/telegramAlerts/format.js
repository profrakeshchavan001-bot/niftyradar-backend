'use strict';
/**
 * Pure message formatting + the INR estimate math for Telegram trade alerts (add-on v2, items 1-2).
 * No network, no clock, no store - every function here is deterministic and unit-testable.
 */
const { resolveExitLevels } = require('../../lib/legacyExit');

// Same default round-trip cost (2 x fee_pct_per_side + slippage_pct) as src/paper/scalp/config.js's
// costPct() with SCALP_DEFAULTS (0.1% x2 + 0.03% = 0.23%) - used only as a fallback when the trade's own
// bot did not store one; always labelled "≈" because it is an estimate either way.
const DEFAULT_COST_PCT = 0.0023;

// Root-cause fix (null target/stop showing as "null" and an implied risk 40-150x too large): the legacy
// fixed rule's own target_pct/stop_pct, used ONLY to reconstruct a missing target_price/sl_price for
// display (src/paper/lib/legacyExit.js) - never read from live config here (this file stays pure), and
// never a fresh decision. nse/nse_scalp prices are already in rupees with their own (wider) legacy rule
// (paperbot/config.js DEFAULTS.nse: target_pct 10 / stop_pct 5); every other bot here is crypto-
// denominated and shares the one legacy rule documented in paperbot/bot.js's cryptoMonitor (DEFAULTS.crypto:
// target_pct 2 / stop_pct 1).
const NSE_LEGACY_PCT = { targetPct: 10, stopPct: 5 };
const CRYPTO_LEGACY_PCT = { targetPct: 2, stopPct: 1 };
const legacyPctFor = (botLabel) => (botLabel === 'nse' || botLabel === 'nse_scalp' ? NSE_LEGACY_PCT : CRYPTO_LEGACY_PCT);

// Task 1 root-cause fix (entry alerts showed "$X (rate n/a)"): a crypto trade's own `fx_rate` is set ONLY
// at exit time (paperbot/bot.js's closeTrade), so it is always absent on an OPEN trade, and USDINR_FALLBACK
// is usually unset too - `fxInfo` used to return null in exactly that gap. This is the same literal number
// as paperbot/config.js's DEFAULTS.crypto.usdt_inr_fallback (and every other crypto bot's own *_DEFAULTS -
// src/paper/scalp/config.js, src/paper/bots/exhaustion_only|trend_smc/config.js all set 88 too), kept as a
// literal here (format.js stays pure/dependency-free) rather than required from paperbot/config, so this is
// genuinely the LAST resort, after the trade's own rate, a live rate and the env fallback have all failed.
const HARD_FALLBACK_USDT_INR = 88;

/** "15-Nov 10:41 PM IST" for a Date/ISO string; 'n/a' when missing or invalid (never throws). */
function istTime(value) {
  if (!value) return 'n/a';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'n/a';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(d);
  const g = (t) => (parts.find((x) => x.type === t) || {}).value || '';
  return `${g('day')}-${g('month')} ${g('hour')}:${g('minute')} ${String(g('dayPeriod')).toUpperCase()} IST`;
}

const tradeTag = (trade) => (trade.id != null ? `Trade #${trade.id}` : 'Trade');

const emojiDir = (direction) => (direction === 'LONG' ? '🟢 LONG' : '🔴 SHORT');

/**
 * { rate, source }, in priority order: (a) the trade row's own stored fx_rate (exit - the exact historical
 * rate) > (b) `liveRate` - a rate already resolved FOR THIS ALERT by the caller (register.js, via the same
 * shared `usdtInr()` the live crypto bot calls before every real exit - paperbot/sources.js's
 * createCryptoSource) > (c) the env USDINR_FALLBACK > (d) the hard-coded last resort above. Task 1 root-
 * cause fix: for a crypto-denominated bot this NEVER returns null any more - there is always at least a
 * configured number, so "$X (rate n/a)" can no longer happen. (A nativeInr bot never calls this - it
 * passes `{ rate: 1 }` itself, see formatEntry/formatExit/capitalLine below.)
 */
function fxInfo(trade, usdInrFallback, liveRate) {
  if (trade.fx_rate != null && Number(trade.fx_rate) > 0) return { rate: Number(trade.fx_rate), source: trade.fx_source || 'trade row' };
  if (liveRate && Number(liveRate.rate) > 0) return { rate: Number(liveRate.rate), source: liveRate.source || 'live rate' };
  const fb = Number(usdInrFallback);
  if (fb > 0) return { rate: fb, source: 'USDINR_FALLBACK' };
  return { rate: HARD_FALLBACK_USDT_INR, source: 'default_fallback' };
}

/**
 * qty x distance to a level, minus an estimated round-trip cost, in USD; and in INR when a rate exists.
 *
 * Root-cause fix (Nov 2026 incident - a null/undefined target or stop showed an implied risk ~40-150x
 * too large): `Number(null)` and `Number(undefined)` are `0`/`NaN`, so a missing `level` used to make
 * `distance = Math.abs(0 - entryPrice) = entryPrice` - silently treating "no stored level" as "the price
 * went all the way to zero", a ~100%-of-entry-price move. A missing/invalid level, entry price or qty
 * now returns `{ usd: null, inr: null }` ('n/a' at the call site) instead of ever computing a number out
 * of a 0-coerced input.
 */
function estimateMove(entryPrice, level, qty, costPct, fx) {
  // `Number(null)` is 0 (finite!), not NaN - checking `!= null` FIRST is the actual fix; `Number.isFinite`
  // alone would let a null level/entryPrice/qty straight through as a silent 0, reproducing the exact bug.
  if (entryPrice == null || level == null || qty == null) return { usd: null, inr: null };
  const entry = Number(entryPrice);
  const lvl = Number(level);
  const q = Number(qty);
  if (!Number.isFinite(entry) || !Number.isFinite(lvl) || !Number.isFinite(q)) return { usd: null, inr: null };
  const distance = Math.abs(lvl - entry);
  const grossUsd = distance * q;
  const costUsd = entry * q * costPct;
  const netUsd = Math.max(0, Math.round((grossUsd - costUsd) * 100) / 100);
  return { usd: netUsd, inr: fx ? Math.round(netUsd * fx.rate) : null };
}

/** First two non-empty lines/sentences of a basis string (pattern, trend/VWAP, key level - item 1). */
function firstTwoLines(basis) {
  return String(basis || '').split(/\r?\n|(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(' ');
}

/**
 * Live running capital state for one bot's own book, at the moment an alert fires (replaces the old
 * per-trade-only "left" line). `capitalTotal` is the bot's own starting demo capital (same config as
 * capitalLine's own total, never invented); `fx` is the already-resolved { rate } used to express that
 * total in rupees (nativeInr bots pass { rate: 1 } since their capital is already INR - see capitalLine).
 *
 * realizedNet = sum of `pnl_inr` over every CLOSED trade of this bot's own book (pnl_inr is always stored
 * in rupees already, nativeInr or not - docs/BOTS.md). locked = sum of `entry_price x qty` over every
 * currently OPEN trade of this bot's own book, each converted to rupees with THAT trade's own fx_rate when
 * it has one, else the same `liveRate`/`usdInrFallback` fallback tiers `fxInfo` uses for the alert's own
 * trade (Task 1/2 fix: an open crypto trade almost never has its own fx_rate yet - it is only ever set at
 * exit - so before this fix almost every open trade silently contributed 0 to `locked`, undercounting the
 * live balance the exact same way the old "rate n/a" entry line did). `tfx` can no longer be null (see
 * fxInfo above), so every open trade with a real qty/entry_price is now actually counted.
 *
 * Deliberately does NOT special-case the alert's own trade: `openTrades`/`closedTrades` are the bot's
 * current book snapshot as the caller already read it, and the current trade is simply wherever it
 * already sits in that snapshot (in `openTrades` if still open, in `closedTrades` once closed) - counting
 * it once, in the right bucket, is what "the honest current state of the book" means here.
 *
 * capitalLeft = capitalTotal (in INR) + realizedNet - locked, floored at 0 (Root-cause backstop,
 * backfill bug report: a bot whose `openTrades` legitimately holds far more than it should - e.g. a
 * backfill replay that has not finished resolving every row yet - must never show a negative "left now";
 * the real fix is each caller never handing this a locked figure that large in the first place, but the
 * floor itself costs nothing and keeps this always presentable). Returns null only when `capitalTotal` or
 * `fx` make even the total impossible to express in rupees (never a half-guessed number).
 */
function computeCapitalState({ capitalTotal, closedTrades = [], openTrades = [], nativeInr = false, usdInrFallback, fx, liveRate } = {}) {
  const total = Number(capitalTotal);
  if (!(total > 0) || !fx) return null;
  const totalInr = total * fx.rate;
  const realizedNetInr = closedTrades.reduce((sum, t) => {
    const net = Number(t.pnl_inr);
    return sum + (Number.isFinite(net) ? net : 0);
  }, 0);
  let lockedInr = 0;
  for (const t of openTrades) {
    const qty = Number(t.qty);
    const entry = Number(t.entry_price);
    if (!Number.isFinite(qty) || !Number.isFinite(entry)) continue;
    const nativeAmount = entry * qty;
    if (nativeInr) { lockedInr += nativeAmount; continue; }
    const tfx = fxInfo(t, usdInrFallback, liveRate);
    if (tfx) lockedInr += nativeAmount * tfx.rate;
  }
  return {
    totalInr: Math.round(totalInr),
    realizedNetInr: Math.round(realizedNetInr),
    lockedInr: Math.round(lockedInr),
    capitalLeftInr: Math.max(0, Math.round(totalInr + realizedNetInr - lockedInr)),
  };
}

/**
 * Capital line (every bot/mirror, entry AND exit): total demo capital configured for this bot, how much
 * of it THIS trade uses (entry_price x qty - already each trade's own fields, nothing invented), in
 * rupees and as a % of the total, the LIVE running balance left in the bot's own book right now (Task:
 * live running capital balance - `computeCapitalState` above), and that book's running realized net P&L.
 * `capitalTotal` is the bot's own config capital (e.g. DEFAULTS.crypto.capital_usdt /
 * DEFAULTS.nse.capital_inr in paperbot/config.js, or each bot's own *_DEFAULTS.capital_usdt - see
 * telegramAlerts/register.js) - this pure formatter never invents one, so passing no `capitalTotal`
 * simply omits the line (used by every existing test/call site that predates this feature). `closedTrades`
 * / `openTrades` are this bot's own current book snapshot, read by the caller (register.js) from the same
 * stores it already reads for everything else - this formatter stays pure and never reaches a database
 * itself; omitting them is read as "no other activity known" (realizedNet 0, locked 0), not as "unknown".
 * `liveRate` (Task 1/2 fix): a rate already resolved FOR THIS ALERT by register.js (the same shared
 * `usdtInr()` the live crypto bot already calls before every real exit) - the last fallback tier `fxInfo`
 * tries before its own hard-coded default, so a crypto bot's capital line is never shown in USD/"rate n/a"
 * again (the branch below is kept only as defence in depth; `fxInfo` can no longer return null).
 */
function capitalLine(trade, { capitalTotal, nativeInr = false, usdInrFallback, closedTrades = [], openTrades = [], liveRate } = {}) {
  const total = Number(capitalTotal);
  const qty = Number(trade.qty);
  const entry = Number(trade.entry_price);
  if (!(total > 0) || !Number.isFinite(qty) || !Number.isFinite(entry)) return null;
  const usedNative = entry * qty;
  const pct = Math.round((usedNative / total) * 1000) / 10;
  const fx = nativeInr ? { rate: 1 } : fxInfo(trade, usdInrFallback, liveRate);
  if (!fx) {
    // Defence in depth only - fxInfo() always returns a usable rate now (Task 1 fix), so this branch is
    // never reached in practice; kept so a future caller that misuses fxInfo still degrades safely.
    const left = Math.round((total - usedNative) * 100) / 100;
    return `Capital: $${total} total | this trade $${Math.round(usedNative * 100) / 100} (${pct}%) | $${left} left (rate n/a, per-trade only)`;
  }
  const totalInr = Math.round(total * fx.rate);
  const usedInr = Math.round(usedNative * fx.rate);
  const state = computeCapitalState({ capitalTotal: total, closedTrades, openTrades, nativeInr, usdInrFallback, fx, liveRate });
  const net = state.realizedNetInr;
  const netTxt = `${net >= 0 ? '+' : '-'}₹${Math.abs(net).toLocaleString('en-IN')}`;
  return `Capital: ₹${totalInr.toLocaleString('en-IN')} total | this trade ₹${usedInr.toLocaleString('en-IN')} (${pct}%) | ₹${state.capitalLeftInr.toLocaleString('en-IN')} left now\n`
    + `Running net P&L: ${netTxt}`;
}

/**
 * Entry alert text (item 1). `trade` needs: direction, symbol, entry_price, target_price, sl_price,
 * target_type, stop_type, qty, rr (optional), basis, fx_rate/fx_source (optional).
 *
 * `nativeInr` (Task Group C, extending coverage to the rupee-denominated bots): true for a bot whose own
 * entry/target/stop prices and qty are ALREADY in rupees with no separate FX step - the NSE main bot and
 * nse_scalp (option premium x lot-sized qty; paperbot/bot.js's own P&L calc is `(exit - entry) * qty`, no
 * cost%/FX multiply, so costPct is passed as 0 for these by the caller - see register.js). false (default,
 * unchanged) is the original crypto convention: entry/target/stop are in USDT, qty in coins, and a real
 * rupee figure needs `fxInfo` (the trade's own fx_rate, else `liveRate`, else `usdInrFallback`, else the
 * hard-coded last resort - Task 1 fix: never "rate n/a" any more for a crypto-denominated bot). `liveRate`
 * is a rate register.js already resolved once per source per poll tick via the shared crypto source's
 * `usdtInr()` (the exact mechanism the live bot calls before every real exit) - this formatter stays pure
 * and never fetches one itself.
 */
function formatEntry(trade, botLabel, { costPct = DEFAULT_COST_PCT, usdInrFallback, nativeInr = false, capitalTotal, closedTrades, openTrades, liveRate } = {}) {
  const fx = nativeInr ? { rate: 1, source: 'native INR (no FX step for this bot)' } : fxInfo(trade, usdInrFallback, liveRate);
  // Root-cause fix: a trade whose row predates level-based exits stores target_price/sl_price as null
  // (paperbot/bot.js's cryptoMonitor legacy path) - reconstruct the REAL price the trade actually closes
  // on (src/paper/lib/legacyExit.js), the same single fix point src/paper/lib/mirror.js's buildMirrorEntry
  // uses for the mirror side of the exact same gap. A normal, level-based trade is returned unchanged.
  const levels = resolveExitLevels(trade, legacyPctFor(botLabel));
  const target = estimateMove(trade.entry_price, levels.target, trade.qty, costPct, fx);
  const stop = estimateMove(trade.entry_price, levels.stop, trade.qty, costPct, fx);
  const rr = trade.rr != null ? Number(trade.rr) : (stop.usd > 0 ? Math.round((target.usd / stop.usd) * 100) / 100 : null);
  const money = (m, sign) => {
    if (m.usd == null) return 'n/a';
    return fx ? `${sign}₹${m.inr.toLocaleString('en-IN')}` : `${sign}$${m.usd} (rate n/a)`;
  };
  const targetLabel = trade.target_type || (levels.reconstructed ? 'legacy fixed % (reconstructed)' : 'fixed %');
  const stopLabel = trade.stop_type || (levels.reconstructed ? 'legacy fixed % (reconstructed)' : 'fixed %');
  const lines = [
    `${tradeTag(trade)} | ${botLabel}`,
    `${emojiDir(trade.direction)} ${trade.symbol}`,
    `Entry time: ${istTime(trade.entry_time)}`,
    `Entry: ${trade.entry_price != null ? trade.entry_price : 'n/a'}`,
    `Target: ${levels.target != null ? levels.target : 'n/a'} (${targetLabel})`,
    `Stop: ${levels.stop != null ? levels.stop : 'n/a'} (${stopLabel})`,
    `Target lagne par ≈ ${money(target, '+')}`,
    `Stop lagne par ≈ ${money(stop, '-')}`,
    `Reward:Risk ${rr != null && Number.isFinite(rr) ? rr.toFixed(2) : 'n/a'}`,
  ];
  const capLine = capitalLine(trade, { capitalTotal, nativeInr, usdInrFallback, closedTrades, openTrades, liveRate });
  if (capLine) lines.push(capLine);
  lines.push('', `Kyu: ${firstTwoLines(trade.basis)}`);
  return lines.join('\n');
}

/**
 * Exit alert text (item 2): result, net INR, time in trade, and (Task: live capital balance) the same
 * capital line as the entry. `liveRate` is passed through to `capitalLine` for the SAME reason as
 * `formatEntry` above: even at exit (when the alert's own trade already has its own stored `fx_rate`),
 * the bot's OTHER currently-open trades usually do not yet, so the "locked" part of the live balance
 * needs the same fallback tiers.
 */
function formatExit(trade, botLabel, { usdInrFallback, nativeInr = false, capitalTotal, closedTrades, openTrades, liveRate } = {}) {
  const minutes = trade.entry_time && trade.exit_time ? Math.round((new Date(trade.exit_time).getTime() - new Date(trade.entry_time).getTime()) / 60000) : null;
  const net = trade.pnl_inr != null ? Number(trade.pnl_inr) : null;
  const resultWord = { target: 'TARGET hit', stop: 'STOP hit', breakeven: 'breakeven' }[trade.exit_reason] || (trade.exit_reason || 'closed');
  const lines = [
    `EXIT ${tradeTag(trade)} | ${botLabel}`,
    `${trade.symbol} closed - ${resultWord}`,
    `Entry time: ${istTime(trade.entry_time)}`,
    `Exit time: ${istTime(trade.exit_time)}`,
    net != null ? `Net: ${net >= 0 ? '+' : '-'}₹${Math.abs(Math.round(net)).toLocaleString('en-IN')}` : 'Net: n/a',
    minutes != null ? `Time in trade: ${minutes} min` : null,
  ];
  const capLine = capitalLine(trade, { capitalTotal, nativeInr, usdInrFallback, closedTrades, openTrades, liveRate });
  if (capLine) lines.push(capLine);
  return lines.filter(Boolean).join('\n');
}

module.exports = { istTime, formatEntry, formatExit, estimateMove, fxInfo, firstTwoLines, capitalLine, computeCapitalState, DEFAULT_COST_PCT, HARD_FALLBACK_USDT_INR };
