"""Indian trading cost model used by every strategy backtest in this directory.

Rates are the standard, publicly published 2024/2025-era rates for a discount broker
(e.g. Zerodha) on NSE cash equity, NSE equity futures, and a typical Indian crypto
exchange (e.g. WazirX/CoinDCX-style 0.1% maker/taker). These are *estimates* meant to be
realistic, not a single broker's exact bill -- documented inline so they're easy to swap.

Nothing here reads market data; it only turns (side, entry_price, exit_price, qty) into a
rupee cost, so it has no lookahead risk by construction.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CostResult:
    turnover: float
    brokerage: float
    stt: float
    exchange_txn: float
    gst: float
    stamp_duty: float
    sebi_fee: float
    slippage: float
    total: float


def _round2(x: float) -> float:
    return round(x, 2)


def equity_delivery_costs(buy_value: float, sell_value: float, slippage_bps: float = 5.0) -> CostResult:
    """Cash equity, delivery (no same-day square-off). STT on both legs at 0.1%."""
    turnover = buy_value + sell_value
    brokerage = 0.0  # most discount brokers: zero brokerage on delivery
    stt = buy_value * 0.001 + sell_value * 0.001
    exchange_txn = turnover * 0.0000297
    stamp_duty = buy_value * 0.00015  # buy side only, NSE delivery
    sebi_fee = turnover * 0.0000001
    gst = (brokerage + exchange_txn + sebi_fee) * 0.18
    slippage = turnover * (slippage_bps / 10000.0)
    total = brokerage + stt + exchange_txn + gst + stamp_duty + sebi_fee + slippage
    return CostResult(_round2(turnover), _round2(brokerage), _round2(stt), _round2(exchange_txn),
                       _round2(gst), _round2(stamp_duty), _round2(sebi_fee), _round2(slippage), _round2(total))


def equity_intraday_costs(buy_value: float, sell_value: float, slippage_bps: float = 8.0) -> CostResult:
    """Cash equity, intraday square-off (used for S5/S8 style intraday-only trades)."""
    turnover = buy_value + sell_value
    brokerage = min(20.0, turnover * 0.0003) * 2  # 0.03% or Rs20/order, whichever lower, both legs
    stt = sell_value * 0.00025  # intraday STT: sell side only, 0.025%
    exchange_txn = turnover * 0.0000297
    stamp_duty = buy_value * 0.00003
    sebi_fee = turnover * 0.0000001
    gst = (brokerage + exchange_txn + sebi_fee) * 0.18
    slippage = turnover * (slippage_bps / 10000.0)
    total = brokerage + stt + exchange_txn + gst + stamp_duty + sebi_fee + slippage
    return CostResult(_round2(turnover), _round2(brokerage), _round2(stt), _round2(exchange_txn),
                       _round2(gst), _round2(stamp_duty), _round2(sebi_fee), _round2(slippage), _round2(total))


def futures_costs(buy_value: float, sell_value: float, slippage_bps: float = 4.0) -> CostResult:
    """NSE index/stock futures (used for S1 on Nifty/BankNifty, S9 if run on futures)."""
    turnover = buy_value + sell_value
    brokerage = min(20.0, turnover * 0.0003) * 2
    stt = sell_value * 0.0002  # futures STT: sell side, 0.02% of sell value (on exercise N/A here)
    exchange_txn = turnover * 0.0000173
    stamp_duty = buy_value * 0.00002
    sebi_fee = turnover * 0.0000001
    gst = (brokerage + exchange_txn + sebi_fee) * 0.18
    slippage = turnover * (slippage_bps / 10000.0)
    total = brokerage + stt + exchange_txn + gst + stamp_duty + sebi_fee + slippage
    return CostResult(_round2(turnover), _round2(brokerage), _round2(stt), _round2(exchange_txn),
                       _round2(gst), _round2(stamp_duty), _round2(sebi_fee), _round2(slippage), _round2(total))


def index_spot_proxy_costs(buy_value: float, sell_value: float, slippage_bps: float = 4.0) -> CostResult:
    """Used only where a strategy trades the *index itself* as a notional proxy (S7 overnight,
    S5/S8 Nifty first/last-30-min). Real execution would be via futures, so this reuses the
    (lower) futures cost structure rather than cash-equity STT, which does not apply to an index."""
    return futures_costs(buy_value, sell_value, slippage_bps)


def crypto_costs(buy_value: float, sell_value: float, fee_pct: float = 0.1, slippage_bps: float = 5.0) -> CostResult:
    """BTC on a typical Indian/global exchange: flat taker fee both legs, no STT/GST/stamp duty."""
    turnover = buy_value + sell_value
    fee = turnover * (fee_pct / 100.0)
    slippage = turnover * (slippage_bps / 10000.0)
    total = fee + slippage
    return CostResult(_round2(turnover), _round2(fee), 0.0, 0.0, 0.0, 0.0, 0.0, _round2(slippage), _round2(total))


COST_MODEL_BY_INSTRUMENT = {
    "equity_delivery": equity_delivery_costs,
    "equity_intraday": equity_intraday_costs,
    "futures": futures_costs,
    "index_proxy": index_spot_proxy_costs,
    "crypto": crypto_costs,
}
