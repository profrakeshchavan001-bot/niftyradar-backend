"""Rupee cost model for index-option selling/buying (hedged structures only).

Rates are the standard, publicly documented 2024/2025-era charges for NSE index options at a
discount broker (e.g. Zerodha):
  - Brokerage: Rs 20 or 0.03% per executed order, whichever is lower (flat Rs 20 in practice for
    options since premium*0.03% is almost always smaller... actually the opposite: use min(20, ...)
    only applies to intraday equity; NSE options brokerage at discount brokers is flat Rs 20/order).
  - STT: 0.1% of premium on the SELL side of an option (as of the 2023 STT hike), nothing on buy.
  - Exchange transaction charge: NSE options ~Rs 35.03 per lakh of premium turnover (~0.03503%).
  - GST: 18% on (brokerage + exchange txn + SEBI fee).
  - SEBI fee: Rs 10 per crore of premium turnover.
  - Stamp duty: 0.003% of buy-side premium (options).
  - Slippage: bid-ask, modelled as a configurable fraction of the quoted premium per leg per side
    (entry + exit), since this is the one cost NOT fixed by a published rate.

This module does not fetch or assume any market data. Every number taken from a trade is passed
in by the caller.
"""
from __future__ import annotations

from dataclasses import dataclass

BROKERAGE_PER_ORDER = 20.0
STT_SELL_RATE = 0.001          # 0.1% of premium, sell side only
EXCHANGE_TXN_RATE = 0.0003503  # ~Rs 35.03 per lakh
GST_RATE = 0.18
SEBI_FEE_RATE = 0.0000001      # Rs 10 per crore
STAMP_DUTY_BUY_RATE = 0.00003  # 0.003% of buy-side premium


@dataclass(frozen=True)
class LegCost:
    side: str            # "sell" or "buy"
    action: str          # "entry" or "exit"
    premium_value: float  # premium * lot_size * num_lots, at execution price
    brokerage: float
    stt: float
    exchange_txn: float
    stamp_duty: float
    sebi_fee: float
    gst: float
    slippage: float
    total: float


def leg_cost(side: str, action: str, premium: float, lot_size: int, num_lots: int,
             slippage_bps_of_premium: float = 150.0) -> LegCost:
    """Cost of one option leg's one fill (entry or exit). `slippage_bps_of_premium` is basis
    points OF THE PREMIUM (not notional) -- index-option bid-ask spreads are a meaningful
    fraction of premium, especially far OTM, so this is deliberately not in notional bps.
    Default 150 bps = 1.5% of premium per fill, a conservative mid-liquidity estimate; callers
    doing a sensitivity pass should vary this explicitly.
    """
    premium_value = premium * lot_size * num_lots
    brokerage = BROKERAGE_PER_ORDER
    stt = premium_value * STT_SELL_RATE if side == "sell" else 0.0
    exchange_txn = premium_value * EXCHANGE_TXN_RATE
    sebi_fee = premium_value * SEBI_FEE_RATE
    stamp_duty = premium_value * STAMP_DUTY_BUY_RATE if side == "buy" else 0.0
    gst = (brokerage + exchange_txn + sebi_fee) * GST_RATE
    slippage = premium_value * (slippage_bps_of_premium / 10000.0)
    total = brokerage + stt + exchange_txn + sebi_fee + stamp_duty + gst + slippage
    return LegCost(side, action, round(premium_value, 2), brokerage, round(stt, 2),
                   round(exchange_txn, 2), round(stamp_duty, 2), round(sebi_fee, 2),
                   round(gst, 2), round(slippage, 2), round(total, 2))


def structure_round_trip_cost(legs: list[dict], lot_size: int, num_lots: int,
                               slippage_bps_of_premium: float = 150.0) -> float:
    """Total cost in rupees for a full structure's entry + exit, all legs.

    `legs` = [{"side": "sell"/"buy", "entry_premium": x, "exit_premium": y}, ...]
    e.g. iron condor = 4 legs (sell call, sell put, buy call wing, buy put wing).
    """
    total = 0.0
    for leg in legs:
        total += leg_cost(leg["side"], "entry", leg["entry_premium"], lot_size, num_lots,
                           slippage_bps_of_premium).total
        total += leg_cost(leg["side"], "exit", leg["exit_premium"], lot_size, num_lots,
                           slippage_bps_of_premium).total
    return round(total, 2)
