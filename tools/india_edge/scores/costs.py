"""Indian equity-delivery trading costs, as a fraction of traded value. Rates live in config.yaml
(`costs:`) because they change; every report DOUBLES them (multiplier) as a stress rule.

Statutory + broker part is deterministic; slippage is a fraction of the stock's average true range.
"""
from __future__ import annotations


def statutory_fraction(side: str, notional: float, c: dict) -> float:
    """Costs excluding slippage, as a fraction of `notional` (before the multiplier)."""
    if side not in ("buy", "sell"):
        raise ValueError(side)
    pct = c["brokerage_pct"] + c["exchange_pct"] + c["sebi_pct"]
    gst = pct * c["gst_pct"] / 100
    total = (pct + gst + c["stt_pct"]) / 100                     # percent -> fraction
    if side == "buy":
        total += c["stamp_buy_pct"] / 100
    else:
        total += c["dp_sell_rs"] / notional if notional > 0 else 0.0
    return total


def side_fraction(side: str, notional: float, atr_pct: float, c: dict, multiplier: float | None = None) -> float:
    """Total cost of one side as a fraction of notional, multiplied (default config multiplier)."""
    m = c["multiplier"] if multiplier is None else multiplier
    slip = c["slippage_atr_frac"] * (0.0 if atr_pct != atr_pct else atr_pct)   # NaN ATR -> no slippage term (flagged by caller)
    return m * (statutory_fraction(side, notional, c) + slip)


def round_trip_fraction(notional: float, atr_pct: float, c: dict, multiplier: float | None = None) -> float:
    return side_fraction("buy", notional, atr_pct, c, multiplier) + side_fraction("sell", notional, atr_pct, c, multiplier)
