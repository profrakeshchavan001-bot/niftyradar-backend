"""Fear/greed meter 0-100 from free inputs. Each reading is placed on 0-100 against its OWN trailing
year (percentile), so no hand-set thresholds and no future data. Higher = greedier.
Inputs used when available: breadth (50/200-day), net 52-week highs, advance/decline, India VIX (else
Nifty realised volatility, labelled), stock-option put/call OI ratio, Nifty vs 125-day average."""
from __future__ import annotations

import numpy as np
import pandas as pd


def _trail_pct(s: pd.Series, window: int, min_window: int) -> pd.Series:
    """Percentile (0-100) of today's value within the trailing `window` values including today."""
    a = s.to_numpy(dtype=float)
    out = np.full(len(a), np.nan)
    for i in range(len(a)):
        if np.isnan(a[i]):
            continue
        w = a[max(0, i - window + 1): i + 1]
        w = w[~np.isnan(w)]
        if len(w) >= min_window:
            out[i] = ((w < a[i]).sum() + 0.5 * (w == a[i]).sum()) / len(w) * 100
    return pd.Series(out, index=s.index)


def label(x: float, bands) -> str:
    names = ["Extreme fear", "Fear", "Neutral", "Greed", "Extreme greed"]
    return names[sum(x >= b for b in bands)]


def readings(P, R) -> dict[str, tuple[pd.Series, str]]:
    """name -> (raw daily series where higher = greedier, plain note)."""
    I, ok = R.extra["ind"], R.status == "ok"
    c = P.close
    n_ok = ok.sum(axis=1).where(lambda x: x > 0)
    above = lambda ma: ((c > ma) & ok).sum(axis=1) / n_ok * 100  # noqa: E731
    ret1 = c.pct_change(1, fill_method=None)
    adv, dec = ((ret1 > 0) & ok).sum(axis=1), ((ret1 < 0) & ok).sum(axis=1)
    hi = ((c >= I["hi252"] * 0.9999) & ok).sum(axis=1)
    lo = ((c <= I["lo252"] * 1.0001) & ok).sum(axis=1)
    out = {
        "Stocks above 50-day average": (above(I["ma"][50]), "share of stocks above their 50-day average"),
        "Stocks above 200-day average": (above(I["ma"][200]), "share of stocks above their 200-day average"),
        "Net 52-week highs": ((hi - lo) / n_ok * 100, "stocks at 52-week highs minus lows"),
        "Advance / decline (10-day)": ((adv / (adv + dec).where(lambda x: x > 0)).rolling(10, min_periods=5).mean() * 100,
                                       "advancers as a share of movers"),
        "Nifty vs 125-day average": ((P.nifty / I["n_ma125"] - 1) * 100, "Nifty 50 distance from its 125-day average"),
    }
    if P.vix is not None and P.vix.notna().sum() > 60:
        out["India VIX"] = (-P.vix, "India VIX (lower = calmer)")
    else:
        rv = np.log(P.nifty / P.nifty.shift(1)).rolling(20, min_periods=15).std() * np.sqrt(252) * 100
        out["Nifty volatility (India VIX not loaded)"] = (-rv, "20-day Nifty volatility (lower = calmer)")
    if P.pcr is not None and P.pcr.notna().sum() > 60:
        out["Put/call OI ratio (stock options)"] = (-P.pcr, "put OI / call OI (lower = more call-heavy)")
    return out


def compute(P, R, cfg: dict) -> dict:
    fg = cfg["fear_greed"]
    rd = readings(P, R)
    scored = pd.DataFrame({k: _trail_pct(v[0], fg["window"], fg["min_window"]) for k, v in rd.items()})
    meter = scored.mean(axis=1, skipna=True).where(scored.notna().sum(axis=1) >= 3).round(0)
    return {"readings": rd, "scored": scored, "meter": meter, "bands": fg["bands"]}


def public(P, R, day, cfg: dict, hist: int = 250) -> dict:
    F = compute(P, R, cfg)
    m = F["meter"]
    v = m.loc[day]
    pos = P.dates.get_loc(day)
    part = []
    for k, (raw, note) in F["readings"].items():
        s = F["scored"][k].loc[day]
        part.append({"name": k, "value": None if pd.isna(s) else int(round(s)),
                     "label": None if pd.isna(s) else label(s, F["bands"]), "note": note})
    missing = [k for k, _ in [("India VIX", 1), ("Put/call OI ratio (stock options)", 1)] if k not in F["readings"]]
    h = m.iloc[max(0, pos - hist + 1): pos + 1].dropna()
    return {"value": None if pd.isna(v) else int(v), "label": None if pd.isna(v) else label(v, F["bands"]),
            "parts": part, "not_available": missing,
            "history": [{"d": f"{d:%Y-%m-%d}", "v": int(x)} for d, x in h.items()]}
