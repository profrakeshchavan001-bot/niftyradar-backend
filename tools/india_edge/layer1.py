"""Layer 1 as a function: scan a Market as-of one day (same maths as run_scanner.py)."""
from __future__ import annotations

import pandas as pd

from common import load_config
from features import build_features, load_sectors
from score import score_frame, top_n
from universe import compute_universe


def build_feature_frame(market, cfg: dict, asof=None, symbols=None) -> pd.DataFrame:
    """Features for every day up to `asof` (all days if None). All features are causal, so a
    frame built once on the full history equals one rebuilt on truncated history (audited by
    audit_lookahead.py)."""
    m = market.truncate(asof) if asof is not None else market
    if symbols is None:
        last = m.cash["date"].max()
        try:
            symbols = compute_universe(m.fo, last, cfg["universe"]["size"], cfg["universe"]["lookback_days"])["symbols"]
        except (ValueError, KeyError):   # no stock-option data: fall back to the most liquid cash stocks
            recent = m.cash[m.cash["date"] > last - pd.Timedelta(days=40)]
            val = (recent["close"] * recent["volume"]).groupby(recent["symbol"]).mean()
            symbols = list(val.nlargest(cfg["universe"]["size"]).index)
    return build_features(m.cash, m.fo, m.idx, symbols, load_sectors(), cfg["lookback"])


def scan(market, asof, cfg: dict | None = None, feats: pd.DataFrame | None = None,
         allowed: set | None = None) -> pd.DataFrame:
    """Top-N scored rows (grades A/B/C) for `asof`, direction long/short only."""
    cfg = cfg or load_config()
    asof = pd.Timestamp(asof)
    if feats is None:
        feats = build_feature_frame(market, cfg, asof)
    day = feats[feats["date"] == asof]
    if allowed is not None:
        day = day[day["symbol"].isin(allowed)]
    if day.empty:
        return day
    return top_n(score_frame(day, cfg), cfg, asof)
