"""Block G: why is it moving? Cause label + confidence + one-line reason, and a stock behaviour profile.

Rules are pure functions over the day's features and bar. Each rule yields (label, strength 0..1, reason);
the strongest wins, the rest become tags. Nothing here reads data after `asof`.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from timing import exec_config

LABELS = ("short_covering", "long_buildup", "fresh_shorts", "long_unwinding", "delivery_spike",
          "volume_spike_no_news", "gap_and_fade", "unclear")
QUAD_LABEL = {"short_covering": "short_covering", "long_buildup": "long_buildup",
              "short_buildup": "fresh_shorts", "long_unwinding": "long_unwinding"}
QUAD_TEXT = {"short_covering": "shorts closing", "long_buildup": "fresh longs being added",
             "short_buildup": "fresh shorts being added", "long_unwinding": "longs closing"}
DEFAULTS = dict(delivery_spike_mult=1.5, vol_spike_mult=2.0, gap_min_pct=1.5, fade_retrace=0.6,
                sector_min_abs=2.0, sector_share=0.6, stock_excess=3.0, tie_margin=0.05, profile_lookback=500)


def cause_config(cfg: dict | None = None) -> dict:
    return {**DEFAULTS, **(cfg or exec_config()).get("cause", {})}


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(v) or math.isinf(v) else v


# ------------------------------------------------------------------ rules
def rule_quadrant(row, c):
    q = str(row.get("quadrant", "neutral"))
    p, o = _num(row.get("price_chg_pct")), _num(row.get("oi_chg_pct"))
    if q not in QUAD_LABEL or p is None or o is None:
        return None
    s = 0.5 + 0.2 * min(abs(o) / 5.0, 1.0) + 0.15 * min(abs(p) / 3.0, 1.0)
    dr = _num(row.get("deliv_ratio"))
    if q in ("long_buildup", "short_buildup") and dr is not None and dr >= c["delivery_spike_mult"]:
        s += 0.1
    name = QUAD_LABEL[q].replace("_", " ").capitalize()
    return QUAD_LABEL[q], min(s, 1.0), f"{name}: price {p:+.1f}% with futures OI {o:+.1f}% ({QUAD_TEXT[q]})"


def rule_delivery(row, c):
    dr, p = _num(row.get("deliv_ratio")), _num(row.get("price_chg_pct"))
    if dr is None or dr < c["delivery_spike_mult"]:
        return None
    s = 0.4 + 0.3 * min((dr - c["delivery_spike_mult"]) / 1.5, 1.0)
    quiet = p is not None and abs(p) < 1.0
    if quiet:
        s += 0.2
    return "delivery_spike", min(s, 1.0), (f"Delivery spike: {dr:.2f}x its 20-day average"
                                           + (" with little price change (quiet buying/selling)" if quiet else ""))


def rule_volume(row, bar, ctx, c):
    if not bar:
        return None
    v, avg = _num(bar.get("volume")), _num(bar.get("vol_avg20"))
    if v is None or not avg or avg <= 0:
        return None
    ratio = v / avg
    if ratio < c["vol_spike_mult"]:
        return None
    ev = (ctx or {}).get("event_near")
    if ev:                       # a scheduled event explains the volume
        return None
    s = 0.4 + 0.3 * min((ratio - c["vol_spike_mult"]) / 2.0, 1.0)
    note = "no scheduled event in the calendar (news not checked)" if ev is False else "event calendar unavailable"
    if ev is None:
        s -= 0.1
    return "volume_spike_no_news", max(s, 0.0), f"Volume {ratio:.1f}x its 20-day average, {note}"


def rule_gap_fade(bar, c):
    if not bar:
        return None
    o, cl, pc = _num(bar.get("open")), _num(bar.get("close")), _num(bar.get("prev_close"))
    if None in (o, cl, pc) or pc <= 0:
        return None
    gap = o / pc - 1
    if abs(gap) * 100 < c["gap_min_pct"]:
        return None
    retrace = (o - cl) / (o - pc)          # 1.0 = closed back at the previous close
    if retrace < c["fade_retrace"]:
        return None
    return "gap_and_fade", min(0.5 + 0.4 * min(retrace, 1.0), 1.0), (
        f"Gap {gap * 100:+.1f}% at the open, {min(retrace, 1.0) * 100:.0f}% of it given back by the close")


def driver_of(row, c) -> tuple[str, str]:
    """('sector' | 'stock' | 'mixed' | 'unknown', short text) from stock RS vs sector RS."""
    rs, srs = _num(row.get("rs")), _num(row.get("sector_rs"))
    if rs is None or srs is None:
        return "unknown", "RS unavailable"
    if abs(srs) >= c["sector_min_abs"] and srs * rs > 0 and abs(srs) >= c["sector_share"] * abs(rs):
        return "sector", f"sector-driven (sector RS {srs:+.1f} vs stock {rs:+.1f})"
    if abs(rs) - (abs(srs) if srs * rs > 0 else -abs(srs)) >= c["stock_excess"]:
        return "stock", f"stock-specific (stock RS {rs:+.1f} vs sector {srs:+.1f})"
    return "mixed", f"mixed (stock RS {rs:+.1f}, sector {srs:+.1f})"


def classify_cause(row, bar=None, ctx=None, cfg=None) -> dict:
    """row: features (quadrant, price_chg_pct, oi_chg_pct, deliv_ratio, rs, sector_rs, ...);
    bar: dict(open, close, prev_close, volume, vol_avg20); ctx: {'event_near': True|False|None}."""
    c = cause_config(cfg)
    cands = [r for r in (rule_quadrant(row, c), rule_delivery(row, c), rule_volume(row, bar, ctx, c),
                         rule_gap_fade(bar, c)) if r]
    drv, drv_text = driver_of(row, c)
    if not cands:
        return dict(label="unclear", confidence=0.0, level="low", driver=drv, tags=[],
                    reason=f"No rule fired; {drv_text}")
    order = {k: i for i, k in enumerate(LABELS)}
    cands.sort(key=lambda r: (-r[1], order[r[0]]))
    top = cands[0]
    conf = top[1]
    if len(cands) > 1 and cands[1][1] >= top[1] - c["tie_margin"]:
        conf -= 0.1                                   # two explanations about equally strong
    conf = round(max(min(conf, 1.0), 0.0), 2)
    level = "high" if conf >= 0.7 else "medium" if conf >= 0.5 else "low"
    return dict(label=top[0], confidence=conf, level=level, driver=drv, tags=[r[0] for r in cands[1:]],
                reason=f"{top[2]}; {drv_text}.")


def bar_context(cash: pd.DataFrame, symbol: str, asof) -> dict | None:
    """Today's bar plus the prior-20-day average volume (data up to asof only)."""
    c = cash[(cash["symbol"] == symbol) & (cash["date"] <= pd.Timestamp(asof))].sort_values("date")
    if c.empty or c["date"].iloc[-1] != pd.Timestamp(asof):
        return None
    last, prior = c.iloc[-1], c.iloc[-21:-1]
    return dict(open=last["open"], high=last["high"], low=last["low"], close=last["close"],
                prev_close=last["prev_close"], volume=last["volume"],
                vol_avg20=float(prior["volume"].mean()) if len(prior) >= 5 else None)


def event_near(events: pd.DataFrame | None, symbol: str, asof, days: int = 1) -> bool | None:
    """True/False if the calendar is known, None if there is no events table at all."""
    if events is None or len(events) == 0:
        return None
    e = events[events["symbol"].isin([symbol, "ALL"])]["date"]
    a = pd.Timestamp(asof)
    return bool(((e >= a - pd.Timedelta(days=days)) & (e <= a + pd.Timedelta(days=days))).any())


# ------------------------------------------------------------------ behaviour profile
def stock_profile(cash: pd.DataFrame, symbol: str, asof, fo: pd.DataFrame | None = None,
                  lookback: int = 500, cfg=None) -> dict:
    """Recurring patterns from the last `lookback` sessions up to asof: same-day gap fill rate,
    5-day drift after volume spikes, and how expiry week behaves versus other weeks."""
    c = cause_config(cfg)
    d = cash[(cash["symbol"] == symbol) & (cash["date"] <= pd.Timestamp(asof))].sort_values("date").tail(lookback)
    d = d.reset_index(drop=True)
    out = dict(sessions=int(len(d)), gap_fill=None, post_spike=None, expiry_week=None, summary="insufficient history")
    if len(d) < 60:
        return out
    # 1. gap fill: |gap| >= 1% and the day's range touches the previous close
    gap = d["open"] / d["prev_close"] - 1
    g = d[gap.abs() >= 0.01]
    if len(g) >= 5:
        up = g["open"] > g["prev_close"]
        filled = np.where(up, g["low"] <= g["prev_close"], g["high"] >= g["prev_close"])
        out["gap_fill"] = dict(n=int(len(g)), rate=float(filled.mean()),
                               up_rate=float(filled[up.to_numpy()].mean()) if up.any() else None,
                               down_rate=float(filled[~up.to_numpy()].mean()) if (~up).any() else None)
    # 2. drift after volume spikes (window must be fully inside the data)
    avg = d["volume"].shift(1).rolling(20, min_periods=10).mean()
    spike = (d["volume"] >= c["vol_spike_mult"] * avg) & avg.notna()
    ret1 = d["close"].pct_change()
    nxt5 = d["close"].shift(-5) / d["close"] - 1
    idx = [i for i in np.nonzero(spike.to_numpy())[0] if i + 5 < len(d) and not math.isnan(ret1.iloc[i])]
    if len(idx) >= 5:
        sign = np.sign(ret1.iloc[idx].to_numpy())
        drift = sign * nxt5.iloc[idx].to_numpy() * 100
        out["post_spike"] = dict(n=len(idx), avg_drift_pct=float(drift.mean()),
                                 continuation_rate=float((drift > 0).mean()))
    # 3. expiry week: days within 4 calendar days up to a monthly expiry vs the rest
    if fo is not None and len(fo):
        exp = pd.to_datetime(pd.Series(fo.loc[fo["symbol"] == symbol, "expiry"].unique()), errors="coerce").dropna()
        if len(exp):
            ex = np.sort(exp.to_numpy())
            dd = d["date"].to_numpy()
            pos = np.searchsorted(ex, dd)
            nxt = ex[np.minimum(pos, len(ex) - 1)]
            days_to = np.where(pos < len(ex), (nxt - dd) / np.timedelta64(1, "D"), np.nan)
            in_week = (days_to >= 0) & (days_to <= 4)
            r = ret1.to_numpy()
            ok = ~np.isnan(r)
            a, b = in_week & ok, (~in_week) & ok
            if a.sum() >= 10 and b.sum() >= 10:
                out["expiry_week"] = dict(
                    n=int(a.sum()), avg_abs_move_pct=float(np.abs(r[a]).mean() * 100),
                    other_abs_move_pct=float(np.abs(r[b]).mean() * 100),
                    ratio=float(np.abs(r[a]).mean() / max(np.abs(r[b]).mean(), 1e-12)),
                    avg_move_pct=float(r[a].mean() * 100))
    parts = []
    if out["gap_fill"]:
        parts.append(f"{out['gap_fill']['rate'] * 100:.0f}% of gaps fill the same day (n={out['gap_fill']['n']})")
    if out["post_spike"]:
        ps = out["post_spike"]
        parts.append(f"after volume spikes the 5-day drift is {ps['avg_drift_pct']:+.1f}% "
                     f"({ps['continuation_rate'] * 100:.0f}% continue, n={ps['n']})")
    if out["expiry_week"]:
        parts.append(f"expiry-week moves are {out['expiry_week']['ratio']:.2f}x a normal day")
    out["summary"] = "; ".join(parts) if parts else "no recurring pattern with enough samples"
    return out
