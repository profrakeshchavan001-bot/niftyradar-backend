'use strict';
// Shared engine glue for the four ccy_* bots (USDINR/EURINR/GBPINR/JPYINR currency futures, PAPER ONLY).
// Pattern detection, trend filter, VWAP and ATR-based stop are NOT duplicated here: analyseWide() and
// evaluateExit() are imported straight from src/paper/scalp/engine.js (the scalp_wide rule this task was
// asked to reuse) and used completely unchanged - they are pure functions of candles + cfg, so a 5-minute
// INR candle works through them exactly like a 5-minute USDT candle does. Only two things are genuinely
// different for a rupee-quoted NSE instrument and are written fresh, right here:
//   - sizeLots():  position size in whole LOTS (a futures contract, unlike a crypto coin, cannot be
//                  fractional), not a continuous qty.
//   - settleInr(): P&L straight in rupees, no USDT/fx_rate step at all (the price is already in rupees -
//                  same "no FX step" convention paperbot/bot.js's NSE P&L already uses, documented in
//                  src/paper/ops/telegramAlerts/register.js's file header).
const { round } = require('../../../paperbot/patterns');
const { analyseWide, evaluateExit } = require('../scalp/engine');
// costPct() (src/paper/scalp/config.js): 2 x fee_pct_per_side + slippage_pct. analyseWide() ALREADY calls
// this internally for its own reward/risk-after-costs gate, reading it straight off the same `cfg` object
// a ccy_* bot loads (src/paper/lib/currencyConfig.js) - so settleInr() below reuses the exact same
// function for the EXIT side's cost, instead of inventing a second, possibly-inconsistent cost number.
const { costPct } = require('../scalp/config');

// NSE currency futures standard lot size: 1 lot = USD 1000 notional for USDINR/EURINR/GBPINR (confirmed
// against NSE's own contract specification - no existing constant for this in the repo, which is
// crypto-only today). JPYINR's REAL NSE lot is JPY 100,000 (JPY being a much smaller-value unit), but the
// task explicitly asked for one uniform "$1000-equivalent" default across all four pairs for this demo,
// and no existing config constant says otherwise - so JPYINR uses the same 1000-unit convention as the
// other three for consistency, logged here and in the PR description as the deliberate simplification it
// is (a real JPYINR lot is 100x bigger). Either way this is a PAPER/DEMO lot size, never used to place a
// real order.
const LOT_UNITS = 1000;

// Risk-based lot sizing (position sizing style, same spirit as paperbot/engine.js's sizeCrypto): caps
// notional at capital x riskPct / stopPct, at capital / pairs (one bucket per currency pair, so one pair
// never eats the whole book) and at whatever free INR cash is actually left; then floors to whole lots
// (a futures contract is never fractional). Returns null when even 1 lot does not fit any of those caps.
function sizeLots({ capitalInr, riskPct, stopPct, freeCashInr, price, pairs, lotUnits = LOT_UNITS }) {
  if (!(price > 0) || !(stopPct > 0) || !(pairs > 0)) return null;
  const lotValue = price * lotUnits;
  const notionalCap = Math.min(capitalInr * riskPct / 100 / (stopPct / 100), capitalInr / pairs, freeCashInr);
  if (!(notionalCap > 0) || !(lotValue > 0)) return null;
  const lots = Math.floor(notionalCap / lotValue);
  if (lots < 1) return null;
  return { lots, qty: lots * lotUnits, value: round(lots * lotValue, 2) };
}

// Gross/net P&L of a closed currency-futures trade, straight in rupees - no fx_rate multiply anywhere
// (the trade's own entry/exit prices are already rupees-per-unit-of-base-currency). Cost model: the SAME
// costPct(cfg) (fee_pct_per_side x2 + slippage_pct) analyseWide() already used to gate this trade's
// entry, applied to the entry value - cfg.fee_pct_per_side/slippage_pct default to 0 in
// src/paper/lib/currencyConfig.js (same "no cost model, net == gross" convention the NSE cash bot already
// uses) so a bot can be run cost-free until the owner wants a more realistic brokerage figure.
function settleInr({ trade, exitPrice, cfg }) {
  const long = trade.direction === 'LONG';
  const gross = (exitPrice - trade.entry_price) * trade.qty * (long ? 1 : -1);
  const entryVal = trade.entry_price * trade.qty;
  const cost = (costPct(cfg) / 100) * entryVal;
  const net = gross - cost;
  return { gross_pnl_inr: round(gross, 2), cost_inr: round(cost, 2), net_pnl_inr: round(net, 2), pnl_inr: round(net, 2) };
}

module.exports = { analyseWide, evaluateExit, sizeLots, settleInr, LOT_UNITS };
