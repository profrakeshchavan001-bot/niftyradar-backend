"""Layer 3 vetoes. Each rule returns (vetoed: bool, reason: str); unknown inputs never veto
unless the matching `veto_on_missing_*` flag is set. All inputs are as-of the previous close."""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from common import ROOT, load_config

DEFAULTS = {
    "chop_er_threshold": 0.25, "chop_lookback": 20, "iv_pct_max": 70, "iv_lookback": 252,
    "event_days": 2, "hold_days": 1, "spread_max_pct": 2.0,
    "veto_on_missing_iv": False, "veto_on_missing_quote": False,
}


def veto_config(cfg: dict | None = None) -> dict:
    cfg = cfg or load_config(ROOT / "config_exec.yaml")
    return {**DEFAULTS, **cfg.get("vetoes", {})}


# ------------------------------------------------------------- rules
def efficiency_ratio(closes, n: int = 20) -> float:
    """|net move| / sum of |daily moves| over the last n changes; 1 = straight line, 0 = pure chop."""
    c = np.asarray(closes, dtype=float)
    if len(c) < n + 1:
        return float("nan")
    w = c[-(n + 1):]
    path = np.abs(np.diff(w)).sum()
    return float(abs(w[-1] - w[0]) / path) if path > 0 else 0.0


def chop_veto(closes, v: dict) -> tuple[bool, str]:
    er = efficiency_ratio(closes, v["chop_lookback"])
    if math.isnan(er):
        return False, "chop: not enough history"
    return er < v["chop_er_threshold"], f"chop regime (ER {er:.2f} < {v['chop_er_threshold']})" \
        if er < v["chop_er_threshold"] else f"trend ok (ER {er:.2f})"


def iv_percentile(iv_series, lookback: int = 252) -> float:
    """Percent of the PRIOR `lookback` values that are below the latest value."""
    s = pd.Series(iv_series).dropna()
    if len(s) < 30:
        return float("nan")
    cur, hist = s.iloc[-1], s.iloc[-(lookback + 1):-1]
    return float(100.0 * (hist < cur).mean())


def iv_veto(iv_series, v: dict) -> tuple[bool, str]:
    if iv_series is None or len(iv_series) == 0:
        return v["veto_on_missing_iv"], "IV unavailable"
    p = iv_percentile(iv_series, v["iv_lookback"])
    if math.isnan(p):
        return v["veto_on_missing_iv"], "IV history too short"
    return p > v["iv_pct_max"], f"IV percentile {p:.0f} {'>' if p > v['iv_pct_max'] else '<='} {v['iv_pct_max']}"


def event_veto(trade_date, event_dates, trading_days, v: dict) -> tuple[bool, str]:
    """Veto if an event falls on the trade day or within the next `event_days` trading days."""
    td = pd.DatetimeIndex(trading_days)
    t0 = pd.Timestamp(trade_date)
    ahead = td[td > t0][: v["event_days"]]
    end = ahead[-1] if len(ahead) == v["event_days"] else t0 + pd.offsets.BDay(v["event_days"])
    for e in sorted(pd.to_datetime(list(event_dates))):
        if t0 <= e <= end:
            return True, f"event on {e:%Y-%m-%d} within {v['event_days']} days"
    return False, "no event in window"


def expiry_veto(trade_date, expiries) -> tuple[bool, str]:
    t0 = pd.Timestamp(trade_date).normalize()
    hit = t0 in {pd.Timestamp(e).normalize() for e in expiries}
    return hit, "expiry day" if hit else "not expiry day"


def expected_move(price: float, iv: float | None, hold_days: int = 1, daily_vol: float | None = None) -> float:
    """1-sigma move over hold_days: price * iv * sqrt(days/252), or price * daily_vol * sqrt(days)."""
    if iv is not None and not math.isnan(iv):
        return float(price * iv * math.sqrt(hold_days / 252.0))
    if daily_vol is not None and not math.isnan(daily_vol):
        return float(price * daily_vol * math.sqrt(hold_days))
    return float("nan")


def target_veto(entry: float, target: float, move: float) -> tuple[bool, str]:
    if move is None or math.isnan(move):
        return False, "expected move unknown"
    dist = abs(target - entry)
    return dist > move, f"target {dist:.2f} {'>' if dist > move else '<='} expected move {move:.2f}"


def spread_veto(spread_pct: float | None, v: dict) -> tuple[bool, str]:
    """spread_pct = (ask - bid) / premium in percent."""
    if spread_pct is None or (isinstance(spread_pct, float) and math.isnan(spread_pct)):
        return v["veto_on_missing_quote"], "option quote unavailable"
    return spread_pct > v["spread_max_pct"], \
        f"option spread {spread_pct:.2f}% {'>' if spread_pct > v['spread_max_pct'] else '<='} {v['spread_max_pct']}%"


# ------------------------------------------------------------- combined
def apply_vetoes(ctx: dict, v: dict | None = None) -> dict:
    """ctx keys: closes, iv_series, trade_date, event_dates, trading_days, expiries,
    entry, target, spread_pct, daily_vol. Missing keys are skipped. Returns
    {vetoed: bool, checks: [(rule, vetoed, detail)]} so the desk can show every check."""
    v = v or veto_config()
    checks = []
    if ctx.get("closes") is not None:
        checks.append(("chop regime", *chop_veto(ctx["closes"], v)))
    checks.append(("IV percentile", *iv_veto(ctx.get("iv_series"), v)))
    if ctx.get("trade_date") is not None:
        checks.append(("event within 2 days", *event_veto(ctx["trade_date"], ctx.get("event_dates", []),
                                                         ctx.get("trading_days", []), v)))
        checks.append(("expiry day", *expiry_veto(ctx["trade_date"], ctx.get("expiries", []))))
    if ctx.get("entry") is not None and ctx.get("target") is not None:
        iv_now = None
        s = ctx.get("iv_series")
        if s is not None and len(s):
            iv_now = float(pd.Series(s).dropna().iloc[-1]) if pd.Series(s).notna().any() else None
        mv = expected_move(ctx["entry"], iv_now, v["hold_days"], ctx.get("daily_vol"))
        checks.append(("target vs expected move", *target_veto(ctx["entry"], ctx["target"], mv)))
    checks.append(("option spread", *spread_veto(ctx.get("spread_pct"), v)))
    return {"vetoed": any(c[1] for c in checks), "checks": checks}
