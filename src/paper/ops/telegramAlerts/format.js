'use strict';
/**
 * Pure message formatting + the INR estimate math for Telegram trade alerts (add-on v2, items 1-2).
 * No network, no clock, no store - every function here is deterministic and unit-testable.
 */
// Same default round-trip cost (2 x fee_pct_per_side + slippage_pct) as src/paper/scalp/config.js's
// costPct() with SCALP_DEFAULTS (0.1% x2 + 0.03% = 0.23%) - used only as a fallback when the trade's own
// bot did not store one; always labelled "≈" because it is an estimate either way.
const DEFAULT_COST_PCT = 0.0023;

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

/** { rate, source } from the trade row's own fx_rate/fx_source, else the env fallback, else null (never invented). */
function fxInfo(trade, usdInrFallback) {
  if (trade.fx_rate != null && Number(trade.fx_rate) > 0) return { rate: Number(trade.fx_rate), source: trade.fx_source || 'trade row' };
  const fb = Number(usdInrFallback);
  if (fb > 0) return { rate: fb, source: 'USDINR_FALLBACK' };
  return null;
}

/** qty x distance to a level, minus an estimated round-trip cost, in USD; and in INR when a rate exists. */
function estimateMove(entryPrice, level, qty, costPct, fx) {
  const distance = Math.abs(Number(level) - Number(entryPrice));
  const grossUsd = distance * Number(qty);
  const costUsd = Number(entryPrice) * Number(qty) * costPct;
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
 * currently OPEN trade of this bot's own book, each converted to rupees with THAT trade's own
 * fx_rate/nativeInr - the exact same per-trade conversion capitalLine already uses for "this trade uses"
 * - never the alert's own trade's rate applied to a different trade. An open trade with no fx_rate and no
 * usdInrFallback contributes nothing to `locked` (never an invented rate) rather than failing the whole
 * calculation.
 *
 * Deliberately does NOT special-case the alert's own trade: `openTrades`/`closedTrades` are the bot's
 * current book snapshot as the caller already read it, and the current trade is simply wherever it
 * already sits in that snapshot (in `openTrades` if still open, in `closedTrades` once closed) - counting
 * it once, in the right bucket, is what "the honest current state of the book" means here.
 *
 * capitalLeft = capitalTotal (in INR) + realizedNet - locked. Returns null only when `capitalTotal` or
 * `fx` make even the total impossible to express in rupees (never a half-guessed number).
 */
function computeCapitalState({ capitalTotal, closedTrades = [], openTrades = [], nativeInr = false, usdInrFallback, fx } = {}) {
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
    const tfx = fxInfo(t, usdInrFallback);
    if (tfx) lockedInr += nativeAmount * tfx.rate; // no rate for this one open trade: skip it, never invent one
  }
  return {
    totalInr: Math.round(totalInr),
    realizedNetInr: Math.round(realizedNetInr),
    lockedInr: Math.round(lockedInr),
    capitalLeftInr: Math.round(totalInr + realizedNetInr - lockedInr),
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
 */
function capitalLine(trade, { capitalTotal, nativeInr = false, usdInrFallback, closedTrades = [], openTrades = [] } = {}) {
  const total = Number(capitalTotal);
  const qty = Number(trade.qty);
  const entry = Number(trade.entry_price);
  if (!(total > 0) || !Number.isFinite(qty) || !Number.isFinite(entry)) return null;
  const usedNative = entry * qty;
  const pct = Math.round((usedNative / total) * 1000) / 10;
  const fx = nativeInr ? { rate: 1 } : fxInfo(trade, usdInrFallback);
  if (!fx) {
    // No rate anywhere (crypto bot, no trade fx_rate and no USDINR_FALLBACK): the live balance needs an
    // INR rate to even express `capitalTotal` in rupees, so it is shown as "rate n/a" too, same as before.
    const left = Math.round((total - usedNative) * 100) / 100;
    return `Capital: $${total} total | this trade $${Math.round(usedNative * 100) / 100} (${pct}%) | $${left} left (rate n/a, per-trade only)`;
  }
  const totalInr = Math.round(total * fx.rate);
  const usedInr = Math.round(usedNative * fx.rate);
  const state = computeCapitalState({ capitalTotal: total, closedTrades, openTrades, nativeInr, usdInrFallback, fx });
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
 * rupee figure needs `fxInfo` (the trade's own fx_rate, else `usdInrFallback`, else shown in USD with
 * "rate n/a" - never an invented rate).
 */
function formatEntry(trade, botLabel, { costPct = DEFAULT_COST_PCT, usdInrFallback, nativeInr = false, capitalTotal, closedTrades, openTrades } = {}) {
  const fx = nativeInr ? { rate: 1, source: 'native INR (no FX step for this bot)' } : fxInfo(trade, usdInrFallback);
  const target = estimateMove(trade.entry_price, trade.target_price, trade.qty, costPct, fx);
  const stop = estimateMove(trade.entry_price, trade.sl_price, trade.qty, costPct, fx);
  const rr = trade.rr != null ? Number(trade.rr) : (stop.usd > 0 ? Math.round((target.usd / stop.usd) * 100) / 100 : null);
  const money = (m, sign) => (fx ? `${sign}₹${m.inr.toLocaleString('en-IN')}` : `${sign}$${m.usd} (rate n/a)`);
  const lines = [
    `${tradeTag(trade)} | ${botLabel}`,
    `${emojiDir(trade.direction)} ${trade.symbol}`,
    `Entry time: ${istTime(trade.entry_time)}`,
    `Entry: ${trade.entry_price}`,
    `Target: ${trade.target_price} (${trade.target_type || 'fixed %'})`,
    `Stop: ${trade.sl_price} (${trade.stop_type || 'fixed %'})`,
    `Target lagne par ≈ ${money(target, '+')}`,
    `Stop lagne par ≈ ${money(stop, '-')}`,
    `Reward:Risk ${rr != null && Number.isFinite(rr) ? rr.toFixed(2) : 'n/a'}`,
  ];
  const capLine = capitalLine(trade, { capitalTotal, nativeInr, usdInrFallback, closedTrades, openTrades });
  if (capLine) lines.push(capLine);
  lines.push('', `Kyu: ${firstTwoLines(trade.basis)}`);
  return lines.join('\n');
}

/** Exit alert text (item 2): result, net INR, time in trade, and (Task: live capital balance) the same capital line as the entry. */
function formatExit(trade, botLabel, { usdInrFallback, nativeInr = false, capitalTotal, closedTrades, openTrades } = {}) {
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
  const capLine = capitalLine(trade, { capitalTotal, nativeInr, usdInrFallback, closedTrades, openTrades });
  if (capLine) lines.push(capLine);
  return lines.filter(Boolean).join('\n');
}

module.exports = { istTime, formatEntry, formatExit, estimateMove, fxInfo, firstTwoLines, capitalLine, computeCapitalState, DEFAULT_COST_PCT };
