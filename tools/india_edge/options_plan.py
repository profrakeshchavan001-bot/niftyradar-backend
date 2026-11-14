"""Block D: option plan. Pure functions, no live data.

ATM or 1-ITM strike (1-ITM when IV percentile is high), expiry 10-15 days out, premium from the
bhavcopy when a matching row exists (else Black-Scholes with IV or realised vol), SL/target on the
premium from the underlying levels, premium-based sizing at 1-2% risk, max 2 positions.
Missing IV or quotes never veto: the plan says what was unavailable.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from timing import exec_config
from vetoes import iv_percentile

STRIKE_STEPS = [(100, 2.5), (250, 5), (500, 10), (1000, 20), (2500, 50), (5000, 100), (float("inf"), 250)]
DEFAULTS = dict(expiry_min_days=10, expiry_max_days=15, itm_iv_pct=50, risk_pct=1.0, max_positions=2, rate=0.07,
                min_premium_stop_frac=0.2, max_cost_pct_capital=20.0)


def options_config(cfg: dict | None = None) -> dict:
    return {**DEFAULTS, **(cfg or exec_config()).get("options", {})}


# ------------------------------------------------------------------ pricing
def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_price(spot: float, strike: float, t_years: float, iv: float, rate: float, kind: str) -> float:
    """Black-Scholes price; falls back to intrinsic value when time or vol is zero."""
    intrinsic = max(spot - strike, 0.0) if kind == "CE" else max(strike - spot, 0.0)
    if t_years <= 0 or iv <= 0 or spot <= 0 or strike <= 0:
        return intrinsic
    d1 = (math.log(spot / strike) + (rate + 0.5 * iv * iv) * t_years) / (iv * math.sqrt(t_years))
    d2 = d1 - iv * math.sqrt(t_years)
    df = math.exp(-rate * t_years)
    if kind == "CE":
        return spot * norm_cdf(d1) - strike * df * norm_cdf(d2)
    return strike * df * norm_cdf(-d2) - spot * norm_cdf(-d1)


def bs_delta(spot: float, strike: float, t_years: float, iv: float, rate: float, kind: str) -> float:
    if t_years <= 0 or iv <= 0:
        return (1.0 if spot > strike else 0.0) if kind == "CE" else (-1.0 if spot < strike else 0.0)
    d1 = (math.log(spot / strike) + (rate + 0.5 * iv * iv) * t_years) / (iv * math.sqrt(t_years))
    return norm_cdf(d1) if kind == "CE" else norm_cdf(d1) - 1.0


def realized_vol(closes, n: int = 20) -> float | None:
    c = np.asarray(closes, dtype=float)
    c = c[~np.isnan(c)]
    if len(c) < 6:
        return None
    r = np.diff(np.log(c[-(n + 1):]))
    return float(r.std(ddof=1) * math.sqrt(252)) if len(r) > 2 else None


# ------------------------------------------------------------------ selection
def strike_step(price: float) -> float:
    return next(step for lim, step in STRIKE_STEPS if price < lim)


def choose_expiry(expiries, trade_date, min_days: int = 10, max_days: int = 15) -> dict | None:
    """First expiry 10-15 calendar days out; else the nearest one at least min_days out; else the
    furthest available. None when there are no future expiries at all."""
    t0 = pd.Timestamp(trade_date).normalize()
    ex = sorted({pd.Timestamp(e).normalize() for e in expiries if pd.notna(e) and pd.Timestamp(e) >= t0})
    if not ex:
        return None
    days = [(e - t0).days for e in ex]
    for e, d in zip(ex, days):
        if min_days <= d <= max_days:
            return dict(expiry=e, days=d, in_window=True)
    for e, d in zip(ex, days):
        if d >= min_days:
            return dict(expiry=e, days=d, in_window=False)
    return dict(expiry=ex[-1], days=days[-1], in_window=False)


def monthly_expiry_rule(year: int, month: int) -> pd.Timestamp:
    """NSE stock-option monthly expiry: last Thursday, or last Tuesday from September 2025."""
    wd = 3 if (year, month) < (2025, 9) else 1
    d = pd.Timestamp(year=year, month=month, day=1) + pd.offsets.MonthEnd(0)
    while d.weekday() != wd:
        d -= pd.Timedelta(days=1)
    return d


def upcoming_monthly(trade_date, n: int = 3) -> list[pd.Timestamp]:
    """The next n monthly expiries on or after trade_date (holiday shifts are not modelled)."""
    t0, out, m = pd.Timestamp(trade_date).normalize(), [], pd.Timestamp(trade_date).normalize().replace(day=1)
    while len(out) < n:
        e = monthly_expiry_rule(m.year, m.month)
        if e >= t0:
            out.append(e)
        m += pd.offsets.MonthBegin(1)
    return out


def choose_moneyness(iv_pct: float | None, itm_iv_pct: float = 50) -> str:
    """1-ITM when implied vol is rich (less vega per rupee), ATM otherwise or when IV is unknown."""
    return "itm1" if (iv_pct is not None and iv_pct >= itm_iv_pct) else "atm"


def choose_strike(spot: float, side: str, moneyness: str = "atm", step: float | None = None, strikes=None) -> dict:
    kind = "CE" if side == "long" else "PE"
    if strikes is not None and len(strikes):
        ks = sorted({float(k) for k in strikes})
        i = int(np.argmin([abs(k - spot) for k in ks]))
        atm = ks[i]
        if moneyness == "itm1":
            j = i - 1 if kind == "CE" else i + 1
            strike = ks[j] if 0 <= j < len(ks) else atm
        else:
            strike = atm
        return dict(type=kind, strike=strike, atm=atm, step=None)
    step = step or strike_step(spot)
    atm = round(spot / step) * step
    strike = atm - step if (moneyness == "itm1" and kind == "CE") else atm + step if moneyness == "itm1" else atm
    return dict(type=kind, strike=float(strike), atm=float(atm), step=step)


def iv_percentile_from(iv_df: pd.DataFrame | None, symbol: str, asof, lookback: int = 252) -> dict:
    """IV percentile from iv.parquet if present; otherwise status 'unavailable' (never a veto)."""
    miss = dict(pct=None, iv_now=None, status="unavailable")
    if iv_df is None or len(iv_df) == 0 or "iv" not in iv_df.columns:
        return miss
    s = iv_df[(iv_df["symbol"] == symbol) & (iv_df["date"] <= pd.Timestamp(asof))].sort_values("date")["iv"].dropna()
    if len(s) < 30:
        return miss
    p = iv_percentile(s.to_numpy(), lookback)
    return miss if math.isnan(p) else dict(pct=float(p), iv_now=float(s.iloc[-1]), status="ok")


def lookup_premium(fo: pd.DataFrame | None, symbol: str, expiry, strike: float, kind: str, asof) -> float | None:
    """Last bhavcopy close of that exact contract on or before asof, or None."""
    if fo is None or len(fo) == 0 or "opt_type" not in fo.columns:
        return None
    d = fo[(fo["symbol"] == symbol) & (fo["instr"] == "STO") & (fo["opt_type"] == kind)
           & (fo["date"] <= pd.Timestamp(asof)) & (abs(fo["strike"] - strike) < 1e-6)]
    if d.empty:
        return None
    d = d[pd.to_datetime(d["expiry"], errors="coerce") == pd.Timestamp(expiry)]
    d = d[d["close"] > 0].sort_values("date")
    return float(d["close"].iloc[-1]) if len(d) else None


# ------------------------------------------------------------------ plan
def option_plan(side: str, spot: float, stop: float, target: float, symbol: str, asof, trade_date, expiries,
                capital: float, *, fo=None, iv_df=None, closes=None, lot_size: int | None = None,
                strikes=None, cfg: dict | None = None, reprice=None) -> dict:
    """Plan an option trade for an underlying setup. `reprice(S)` overrides the pricing model (tests)."""
    c = options_config(cfg)
    notes: list[str] = []
    plan = dict(symbol=symbol, side=side, status="ok", notes=notes, underlying=dict(spot=spot, stop=stop, target=target))
    ivi = iv_percentile_from(iv_df, symbol, asof)
    plan.update(iv_percentile=ivi["pct"], iv_status=ivi["status"], iv=ivi["iv_now"])
    if ivi["status"] != "ok":
        notes.append("IV percentile unavailable; ATM used, no veto applied")
    ex = choose_expiry(expiries, trade_date, c["expiry_min_days"], c["expiry_max_days"])
    if ex is None:
        plan.update(status="no_expiry")
        notes.append("no future expiry in the data")
        return plan
    mny = choose_moneyness(ivi["pct"], c["itm_iv_pct"])
    k = choose_strike(spot, side, mny, strikes=strikes)
    plan.update(type=k["type"], strike=k["strike"], moneyness=mny, expiry=f"{ex['expiry']:%Y-%m-%d}",
                days_to_expiry=ex["days"], expiry_in_window=ex["in_window"])
    if not ex["in_window"]:
        notes.append(f"no expiry {c['expiry_min_days']}-{c['expiry_max_days']} days out; using {ex['days']} days")
    iv_used = ivi["iv_now"]
    iv_src = "iv.parquet"
    if iv_used is None:
        iv_used, iv_src = realized_vol(closes) if closes is not None else None, "realised vol"
    t = ex["days"] / 365.0
    prem = lookup_premium(fo, symbol, ex["expiry"], k["strike"], k["type"], asof)
    src = "bhavcopy"
    if reprice is None:
        if iv_used:
            reprice = lambda s: bs_price(s, k["strike"], t, iv_used, c["rate"], k["type"])  # noqa: E731
        else:
            reprice = None
    if prem is None:
        if reprice is None:
            plan.update(status="no_premium")
            notes.append("no bhavcopy premium and no IV or price history to model one")
            return plan
        prem, src = reprice(spot), f"model ({iv_src})"
    if reprice is None:
        plan.update(status="no_premium", premium=prem, premium_source=src)
        notes.append("premium found but cannot reprice SL/target without IV or price history")
        return plan
    base = reprice(spot)
    p_stop = max(prem + (reprice(stop) - base), c["min_premium_stop_frac"] * prem)
    p_tgt = prem + (reprice(target) - base)
    risk_unit = prem - p_stop
    rr = (p_tgt - prem) / risk_unit if risk_unit > 0 else None
    risk_pct = min(max(c["risk_pct"], 1.0), 2.0)
    risk_amt = capital * risk_pct / 100.0
    units = math.floor(risk_amt / risk_unit) if risk_unit > 0 else 0
    cap_units = math.floor(capital * c["max_cost_pct_capital"] / 100.0 / prem) if prem > 0 else 0
    if units > cap_units:
        units = cap_units
        notes.append(f"size capped at {c['max_cost_pct_capital']:.0f}% of capital")
    lots = None
    qty = units
    if lot_size:
        lots = units // lot_size
        qty = lots * lot_size
    else:
        notes.append("lot size unknown; quantity in units")
    plan.update(premium=prem, premium_source=src, premium_stop=p_stop, premium_target=p_tgt, risk_per_unit=risk_unit,
                reward_risk=rr, risk_pct=risk_pct, risk_amt=risk_amt, lot_size=lot_size, lots=lots, qty=int(qty),
                cost=float(qty * prem), risk_at_stop=float(qty * risk_unit))
    if qty < 1:
        plan["status"] = "size_zero"
        notes.append("one lot risks more than the allowed amount" if lot_size else "risk amount too small")
    return plan


def select_positions(plans: list[dict], open_count: int = 0, max_positions: int = 2) -> list[dict]:
    """Keep plans in priority order until the position cap; others get status 'skipped'."""
    room = max(max_positions - open_count, 0)
    out = []
    for p in plans:
        p = dict(p)
        if p.get("status") == "ok" and room > 0:
            room -= 1
        elif p.get("status") == "ok":
            p["status"] = "skipped"
            p["notes"] = list(p["notes"]) + [f"max {max_positions} positions"]
        out.append(p)
    return out
