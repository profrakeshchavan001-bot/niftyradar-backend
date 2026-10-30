"""Scores engine. Formulas live ONLY here (server side). All features are trailing windows, so the
score for day t uses data up to and including t (tests/test_leak.py proves it).

Every score = weighted mean of component sub-scores (0-100). Components with no data (NaN) drop out
and the remaining weights renormalise; a score with no usable component is NaN.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd
import yaml

HERE = Path(__file__).resolve().parent
NAMES = ("trend", "momentum", "relative_strength", "volume_delivery", "volatility", "quality", "valuation")
LABEL = {"trend": "Trend", "momentum": "Momentum", "relative_strength": "Relative strength",
         "volume_delivery": "Volume & delivery", "volatility": "Stability", "quality": "Quality",
         "valuation": "Valuation", "overall": "Overall"}


def load_cfg(path: Path | None = None) -> dict:
    with open(path or HERE / "config.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def sub(x, lo, hi):
    """Linear 0-100 between lo (->0) and hi (->100), clipped. lo > hi gives an inverted scale."""
    return ((x - lo) / (hi - lo)).clip(0, 1) * 100


def pr(df: pd.DataFrame) -> pd.DataFrame:
    """Cross-sectional percentile 0-100 (per date, across symbols)."""
    return df.rank(axis=1, pct=True) * 100


@dataclass
class Comp:
    name: str
    raw: pd.DataFrame          # the plain reading (used for the sentence)
    score: pd.DataFrame        # 0-100
    w: float
    fmt: Callable[[float], str]


@dataclass
class Result:
    comps: dict[str, list[Comp]] = field(default_factory=dict)
    scores: dict[str, pd.DataFrame] = field(default_factory=dict)   # incl. "overall"
    status: pd.Series | None = None
    extra: dict = field(default_factory=dict)


def wmean(comps: list[Comp], attr: str = "score") -> pd.DataFrame:
    num = sum(getattr(c, attr).fillna(0) * c.w for c in comps)
    den = sum(getattr(c, attr).notna().astype(float) * c.w for c in comps)
    return (num / den.where(den > 0)).round(1)


def _rsi(close: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    return 100 - 100 / (1 + up / dn.where(dn > 0))


def indicators(P) -> dict:
    """Shared trailing-window building blocks (also used by screeners / rotation / fear-greed)."""
    c, h, l, v, d, o = P.close, P.high, P.low, P.volume, P.deliv, P.open
    n = P.nifty
    ma = {k: c.rolling(k, min_periods=k).mean() for k in (20, 50, 200)}
    ret = {k: c.pct_change(k, fill_method=None) for k in (1, 5, 21, 63, 126, 252)}
    tr = pd.concat([(h - l), (h - c.shift(1)).abs(), (l - c.shift(1)).abs()]).groupby(level=0).max()
    atr = tr.rolling(14, min_periods=14).mean()
    r1 = np.log(c / c.shift(1))
    up = (c > c.shift(1))
    dn = (c < c.shift(1))
    ind = {
        "ma": ma, "ret": ret, "atr_pct": atr / c, "rsi": _rsi(c),
        "vol60": r1.rolling(60, min_periods=40).std() * np.sqrt(252),
        "dd60": c / c.rolling(60, min_periods=40).max() - 1,
        "gap60": ((o / c.shift(1) - 1).abs() > 0.02).astype(float).where(o.notna() & c.shift(1).notna())
                 .rolling(60, min_periods=40).mean(),
        "hi252": c.rolling(252, min_periods=60).max(), "lo252": c.rolling(252, min_periods=60).min(),
        "hi20_prior": c.shift(1).rolling(20, min_periods=20).max(),
        "vr": v.rolling(5, min_periods=5).mean() / v.shift(5).rolling(20, min_periods=15).mean(),
        "vol_today": v / v.shift(1).rolling(20, min_periods=15).mean(),
        "dr": d.rolling(5, min_periods=3).mean() / d.shift(5).rolling(20, min_periods=15).mean(),
        "udvol": (v.where(up).rolling(20, min_periods=10).sum() / v.where(dn).rolling(20, min_periods=10).sum()),
        "val_tr": (c * v).rolling(20, min_periods=15).mean() / (c * v).rolling(60, min_periods=40).mean(),
        "nret": {k: n.pct_change(k, fill_method=None) for k in (21, 63, 126)},
        "n_ma125": n.rolling(125, min_periods=60).mean(),
    }
    return ind


def status(P, cfg: dict) -> pd.DataFrame:
    """Per date x symbol: ok / new_listing / suspended / illiquid (only 'ok' gets scored)."""
    bars = P.close.notna().cumsum()
    traded = P.close.notna() & (P.volume.fillna(0) > 0)
    zero5 = (P.volume.fillna(0) <= 0).astype(int).rolling(5, min_periods=1).sum()
    st = pd.DataFrame("ok", index=P.dates, columns=P.symbols)
    st = st.mask(zero5 >= cfg["stale_zero_volume"], "illiquid")
    st = st.mask(P.close.isna() & (bars > 0), "suspended")
    st = st.mask(bars < cfg["min_history"], "new_listing")
    st = st.mask(bars == 0, "not_listed")
    return st.where(traded | (st != "ok"), "illiquid")


def _sector_median(P, df: pd.DataFrame) -> pd.DataFrame:
    return df.T.groupby(P.sector).transform("median").T


def compute(P, cfg: dict | None = None) -> Result:
    cfg = cfg or load_cfg()
    I = indicators(P)
    c, ma, ret, nret = P.close, I["ma"], I["ret"], I["nret"]
    W = cfg["weights"]
    pct = lambda x: f"{x * 100:+.1f}%"  # noqa: E731
    cs: dict[str, list[Comp]] = {}

    cs["trend"] = [
        Comp("Close vs 20-day average", c / ma[20] - 1, sub(c / ma[20] - 1, -0.05, 0.05), 1, lambda x: f"{pct(x)} from its 20-day average"),
        Comp("Close vs 50-day average", c / ma[50] - 1, sub(c / ma[50] - 1, -0.10, 0.10), 1.5, lambda x: f"{pct(x)} from its 50-day average"),
        Comp("Close vs 200-day average", c / ma[200] - 1, sub(c / ma[200] - 1, -0.20, 0.20), 1.5, lambda x: f"{pct(x)} from its 200-day average"),
        Comp("Average alignment", (ma[20] > ma[50]).astype(float).where(ma[50].notna()),
             (((ma[20] > ma[50]).astype(float) * 50) + ((ma[50] > ma[200]).astype(float) * 50)).where(ma[200].notna(),
              (ma[20] > ma[50]).astype(float) * 100).where(ma[50].notna()),
             1, lambda x: "20-day above 50-day average" if x else "20-day below 50-day average"),
        Comp("50-day average slope", ma[50] / ma[50].shift(10) - 1, sub(ma[50] / ma[50].shift(10) - 1, -0.03, 0.03), 1,
             lambda x: f"50-day average {pct(x)} over 10 days"),
    ]
    r_ex = c.shift(21) / c.shift(252) - 1
    cs["momentum"] = [
        Comp("1-month return", ret[21], pr(ret[21]), 1.5, lambda x: f"{pct(x)} in 1 month"),
        Comp("3-month return", ret[63], pr(ret[63]), 3, lambda x: f"{pct(x)} in 3 months"),
        Comp("6-month return", ret[126], pr(ret[126]), 3, lambda x: f"{pct(x)} in 6 months"),
        Comp("12-month return (ex last month)", r_ex, pr(r_ex), 2.5, lambda x: f"{pct(x)} over the 11 months before last"),
        Comp("RSI (14)", I["rsi"], sub(I["rsi"], 40, 70), 1, lambda x: f"RSI {x:.0f}"),
        Comp("Distance from 52-week high", c / I["hi252"] - 1, sub(c / I["hi252"] - 1, -0.25, 0), 2,
             lambda x: "At its 52-week high" if x > -0.0005 else f"{abs(x) * 100:.1f}% below its 52-week high"),
    ]
    rs63, rs126 = ret[63].sub(nret[63], axis=0), ret[126].sub(nret[126], axis=0)
    ratio = c.div(P.nifty, axis=0)
    rl = ratio / ratio.shift(20) - 1
    vs_sec = ret[63] - _sector_median(P, ret[63])
    cs["relative_strength"] = [
        Comp("3-month vs Nifty 50", rs63, pr(rs63), 3, lambda x: f"{x * 100:+.1f} pts vs Nifty 50 over 3 months"),
        Comp("6-month vs Nifty 50", rs126, pr(rs126), 2.5, lambda x: f"{x * 100:+.1f} pts vs Nifty 50 over 6 months"),
        Comp("Relative-strength line", rl, pr(rl), 2, lambda x: f"Ratio to Nifty 50 {pct(x)} over 20 days"),
        Comp("3-month vs its sector", vs_sec, pr(vs_sec), 2, lambda x: f"{x * 100:+.1f} pts vs its sector median over 3 months"),
    ]
    cs["volume_delivery"] = [
        Comp("Volume vs usual", I["vr"], sub(I["vr"], 0.7, 2.0), 2, lambda x: f"5-day volume {x:.2f}x the prior 20-day average"),
        Comp("Delivery % vs usual", I["dr"], sub(I["dr"], 0.8, 1.5), 2.5, lambda x: f"5-day delivery % {x:.2f}x the prior 20-day average"),
        Comp("Up-day vs down-day volume", I["udvol"], sub(I["udvol"], 0.6, 1.8), 2, lambda x: f"Up-day volume {x:.2f}x down-day volume (20 days)"),
        Comp("Traded value trend", I["val_tr"], sub(I["val_tr"], 0.7, 1.5), 1, lambda x: f"20-day traded value {x:.2f}x its 60-day average"),
    ]
    cs["volatility"] = [
        Comp("Daily range (ATR %)", I["atr_pct"], 100 - pr(I["atr_pct"]), 2, lambda x: f"Average daily range {x * 100:.1f}% of price"),
        Comp("60-day volatility", I["vol60"], 100 - pr(I["vol60"]), 2, lambda x: f"60-day volatility {x * 100:.0f}% a year"),
        Comp("60-day drawdown", I["dd60"], sub(I["dd60"], -0.25, 0), 1.5, lambda x: f"{abs(x) * 100:.1f}% below its 60-day high"),
        Comp("Gap frequency", I["gap60"], sub(I["gap60"], 0.2, 0), 1, lambda x: f"Opened 2%+ away from prior close on {x * 100:.0f}% of days"),
    ]
    fund = P.fundamentals
    if fund is not None:
        broad = lambda s: pd.DataFrame([s.values] * len(P.dates), index=P.dates, columns=s.index)  # noqa: E731
        f = {k: broad(fund[k]) for k in fund.columns}
        pe_sec = fund["pe"].where(fund["pe"] > 0).groupby(P.sector).transform("median")
        pe_rel = broad(fund["pe"].where(fund["pe"] > 0) / pe_sec)
        cs["quality"] = [
            Comp("Return on equity", f["roe"], sub(f["roe"], 5, 25), 2, lambda x: f"ROE {x:.1f}%"),
            Comp("Debt to equity", f["debt_equity"], sub(f["debt_equity"], 2, 0), 1.5, lambda x: f"Debt/equity {x:.2f}"),
            Comp("Profit margin", f["profit_margin"], sub(f["profit_margin"], 0, 20), 1.5, lambda x: f"Profit margin {x:.1f}%"),
            Comp("Promoter holding", f["promoter_pct"], sub(f["promoter_pct"], 20, 65), 1, lambda x: f"Promoters hold {x:.1f}%"),
            Comp("Promoter pledge", f["promoter_pledge_pct"], sub(f["promoter_pledge_pct"], 30, 0), 1, lambda x: f"{x:.1f}% of promoter shares pledged"),
        ]
        cs["valuation"] = [
            Comp("P/E vs sector", pe_rel, sub(pe_rel, 1.5, 0.6), 2, lambda x: f"P/E {x:.2f}x its sector median"),
            Comp("P/E level", f["pe"].where(f["pe"] > 0), sub(f["pe"].where(f["pe"] > 0), 60, 10), 1.5, lambda x: f"P/E {x:.1f}"),
            Comp("Price to book", f["pb"].where(f["pb"] > 0), sub(f["pb"].where(f["pb"] > 0), 8, 1), 1, lambda x: f"P/B {x:.1f}"),
        ]
    res = Result(comps=cs, extra={"ind": I})
    res.status = status(P, cfg)
    ok = res.status == "ok"
    for k, lst in cs.items():
        res.scores[k] = wmean(lst).where(ok)
    avail = [k for k in W if k in res.scores]
    num = sum(res.scores[k].fillna(0) * W[k] for k in avail)
    den = sum(res.scores[k].notna().astype(float) * W[k] for k in avail)
    res.scores["overall"] = (num / den.where(den > 0)).round(1).where(ok)
    res.extra["coverage"] = sum(res.scores[k].notna().astype(int) for k in avail)
    return res


def band(x: float, cfg: dict) -> str:
    return "Strong" if x >= cfg["band_strong"] else "Mixed" if x >= cfg["band_mixed"] else "Weak"


SAYS = {
    "trend": ("Price is holding above its main averages.", "Price is near its averages with no clear direction.", "Price is below its main averages."),
    "momentum": ("Recent gains rank among the better ones.", "Recent gains are about average.", "Recent gains rank among the weaker ones."),
    "relative_strength": ("Has done better than the Nifty 50 and its sector.", "Has moved about in line with the market.", "Has lagged the Nifty 50 and its sector."),
    "volume_delivery": ("Trading and delivery interest is above usual.", "Trading and delivery interest is near usual.", "Trading and delivery interest is below usual."),
    "volatility": ("Price moves are calmer than most stocks.", "Price moves are typical.", "Price moves are wilder than most stocks."),
    "quality": ("Reported business readings look healthy.", "Reported business readings are middling.", "Reported business readings look weak."),
    "valuation": ("Valued below peers on the readings used.", "Valued about in line with peers.", "Valued above peers on the readings used."),
    "overall": ("Most readings are favourable.", "Readings are mixed.", "Most readings are unfavourable."),
}


def says(name: str, b: str) -> str:
    return SAYS[name][("Strong", "Mixed", "Weak").index(b)]
