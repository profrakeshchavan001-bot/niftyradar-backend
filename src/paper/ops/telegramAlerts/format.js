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
function formatEntry(trade, botLabel, { costPct = DEFAULT_COST_PCT, usdInrFallback, nativeInr = false } = {}) {
  const fx = nativeInr ? { rate: 1, source: 'native INR (no FX step for this bot)' } : fxInfo(trade, usdInrFallback);
  const target = estimateMove(trade.entry_price, trade.target_price, trade.qty, costPct, fx);
  const stop = estimateMove(trade.entry_price, trade.sl_price, trade.qty, costPct, fx);
  const rr = trade.rr != null ? Number(trade.rr) : (stop.usd > 0 ? Math.round((target.usd / stop.usd) * 100) / 100 : null);
  const money = (m, sign) => (fx ? `${sign}₹${m.inr.toLocaleString('en-IN')}` : `${sign}$${m.usd} (rate n/a)`);
  return [
    `${tradeTag(trade)} | ${botLabel}`,
    `${emojiDir(trade.direction)} ${trade.symbol}`,
    `Entry time: ${istTime(trade.entry_time)}`,
    `Entry: ${trade.entry_price}`,
    `Target: ${trade.target_price} (${trade.target_type || 'fixed %'})`,
    `Stop: ${trade.sl_price} (${trade.stop_type || 'fixed %'})`,
    `Target lagne par ≈ ${money(target, '+')}`,
    `Stop lagne par ≈ ${money(stop, '-')}`,
    `Reward:Risk ${rr != null && Number.isFinite(rr) ? rr.toFixed(2) : 'n/a'}`,
    '',
    `Kyu: ${firstTwoLines(trade.basis)}`,
  ].join('\n');
}

/** Exit alert text (item 2): result, net INR, time in trade. */
function formatExit(trade, botLabel) {
  const minutes = trade.entry_time && trade.exit_time ? Math.round((new Date(trade.exit_time).getTime() - new Date(trade.entry_time).getTime()) / 60000) : null;
  const net = trade.pnl_inr != null ? Number(trade.pnl_inr) : null;
  const resultWord = { target: 'TARGET hit', stop: 'STOP hit', breakeven: 'breakeven' }[trade.exit_reason] || (trade.exit_reason || 'closed');
  return [
    `EXIT ${tradeTag(trade)} | ${botLabel}`,
    `${trade.symbol} closed - ${resultWord}`,
    `Entry time: ${istTime(trade.entry_time)}`,
    `Exit time: ${istTime(trade.exit_time)}`,
    net != null ? `Net: ${net >= 0 ? '+' : '-'}₹${Math.abs(Math.round(net)).toLocaleString('en-IN')}` : 'Net: n/a',
    minutes != null ? `Time in trade: ${minutes} min` : null,
  ].filter(Boolean).join('\n');
}

module.exports = { istTime, formatEntry, formatExit, estimateMove, fxInfo, firstTwoLines, DEFAULT_COST_PCT };
