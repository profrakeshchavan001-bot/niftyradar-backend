"""Lookahead-bias audit. Exits 1 if any feature, universe, signal or timing rule uses future data.

    python audit_lookahead.py [--cutoffs 3] [--days 400]

Method: recompute everything on data truncated at a cutoff and require that every value dated on or
before the cutoff is identical to the value computed with the full history. A feature that peeks
forward (shift(-1), centred windows, full-sample statistics) changes when the future is removed.
Layer 2 is checked by replacing all bars after bar i with garbage and requiring the same decision.
"""
from __future__ import annotations

import argparse
import sys

import numpy as np
import pandas as pd

from common import load_config
from intraday import get_bars
from layer1 import build_feature_frame
from loader import Market, load_market
from timing import analyse, exec_config

KEYS = ["date", "symbol"]


def compare_prefix(full: pd.DataFrame, trunc: pd.DataFrame, cutoff, cols=None, tol: float = 1e-9,
                   intersect_only: bool = False) -> dict:
    """{column: (n_mismatches, example_key)} for rows dated <= cutoff."""
    cutoff = pd.Timestamp(cutoff)
    a = full[full["date"] <= cutoff].set_index(KEYS).sort_index()
    b = trunc[trunc["date"] <= cutoff].set_index(KEYS).sort_index()
    idx = a.index.intersection(b.index) if intersect_only else a.index.union(b.index)
    bad = {}
    for c in (cols or [c for c in a.columns if c in b.columns]):
        x, y = a[c].reindex(idx), b[c].reindex(idx)
        both_nan = x.isna() & y.isna()
        if pd.api.types.is_numeric_dtype(x) and pd.api.types.is_numeric_dtype(y):
            mism = ~((x.astype(float) - y.astype(float)).abs() <= tol * (1 + x.abs().astype(float))) & ~both_nan
        else:
            mism = (x != y) & ~both_nan
        if mism.any():
            bad[c] = (int(mism.sum()), idx[np.argmax(mism.to_numpy())])
    return bad


def audit_feature_fn(fn, market: Market, cutoffs, cols=None) -> list[str]:
    """fn(market) -> DataFrame keyed by date/symbol. Returns violation messages (empty = clean)."""
    full = fn(market)
    msgs = []
    for d in cutoffs:
        bad = compare_prefix(full, fn(market.truncate(d)), d, cols)
        for c, (n, ex) in bad.items():
            msgs.append(f"feature '{c}' changes when data after {pd.Timestamp(d):%Y-%m-%d} is removed "
                        f"({n} rows, e.g. {ex})")
    return msgs


def audit_signals(market: Market, cutoffs) -> list[str]:
    """Backtest signal inputs (membership, component fractions, direction, setup) must not change
    when later data is removed. Outcome columns are excluded: they legitimately need future bars."""
    from backtest.engine import build_panel, prepare_candidates
    from features import load_sectors
    cfg = load_config()
    sec = load_sectors()
    cols = ["f_quadrant", "f_delivery", "f_rs", "f_sector_rs", "f_unusual_oi", "direction", "setup", "adv_cr"]
    full = prepare_candidates(build_panel(market.cash, market.fo, market.idx, cfg, sec), cfg)
    msgs = []
    for d in cutoffs:
        m = market.truncate(d)
        part = prepare_candidates(build_panel(m.cash, m.fo, m.idx, cfg, sec), cfg)
        for c, (n, ex) in compare_prefix(full, part, d, cols, intersect_only=True).items():
            msgs.append(f"signal input '{c}' changes when data after {pd.Timestamp(d):%Y-%m-%d} is removed "
                        f"({n} rows, e.g. {ex})")
    return msgs


def audit_timing(market: Market, n_cases: int = 12, seed: int = 0) -> list[str]:
    """Decision on bars[:i+1] must not depend on later bars."""
    rng = np.random.default_rng(seed)
    cfg = exec_config()
    syms = sorted(market.cash["symbol"].unique())
    days = market.dates[-200:]
    msgs = []
    for _ in range(n_cases):
        s, d = syms[int(rng.integers(len(syms)))], days[int(rng.integers(len(days)))]
        b = get_bars(market.cash, s, d)
        if b is None:
            continue
        for side in ("long", "short"):
            for i in range(3, len(b) - 1, 3):
                nxt = float(b["open"].iloc[i + 1])   # the fill price is the one legitimate input from bar i+1
                clean = analyse(b.iloc[: i + 1], side, cfg, next_open=nxt)
                junk = b.copy()
                junk.loc[i + 1:, ["open", "high", "low", "close"]] *= rng.uniform(0.5, 2.0)
                dirty = analyse(junk.iloc[: i + 1], side, cfg, next_open=nxt)
                if (clean["state"], clean["stop"], clean["target"]) != (dirty["state"], dirty["stop"], dirty["target"]):
                    msgs.append(f"timing decision for {s} {d:%Y-%m-%d} {side} bar {i} depends on later bars")
    return msgs


def audit_session(market: Market, n_days: int = 6, seed: int = 1) -> list[str]:
    """The paper session's decisions up to bar K+1 must not change if every bar after K+1 is corrupted
    (bar K+1's open is the only future value a decision may use: it is the fill price)."""
    import session as S
    from layer1 import scan
    from paper_ledger import PaperLedger
    from session import run_session
    from vetoes import veto_config
    cfg, ecfg = load_config(), exec_config()
    vcfg = veto_config(ecfg)
    rng = np.random.default_rng(seed)
    syms = sorted(market.cash["symbol"].unique())
    feats = build_feature_frame(market, cfg, symbols=syms)
    dates = market.dates
    orig, msgs = S.get_bars, []
    try:
        for k in rng.choice(np.arange(len(dates) - 120, len(dates) - 1), size=n_days, replace=False):
            d, nxt = dates[k], dates[k + 1]
            picks = scan(market, d, cfg, feats=feats)
            if picks.empty:
                continue
            pk = [dict(symbol=r["symbol"], side=r["direction"], grade=r["grade"], score=float(r["score"]),
                       setup=r["setup"]) for _, r in picks.iterrows()]
            S.get_bars = orig
            base = run_session(market, pk, d, nxt, PaperLedger(":memory:", ecfg), ecfg, vcfg)["events"]
            K = int(rng.integers(4, 20))

            def corrupt(cash, sym, day, root=None, K=K):
                b = orig(cash, sym, day, root)
                if b is not None:
                    b = b.copy()
                    b.loc[K + 2:, ["open", "high", "low", "close"]] *= rng.uniform(0.6, 1.8)
                return b

            S.get_bars = corrupt
            alt = run_session(market, pk, d, nxt, PaperLedger(":memory:", ecfg), ecfg, vcfg)["events"]
            cutoff = f"{nxt:%Y-%m-%d} 09:15"
            t_k1 = pd.Timestamp(cutoff) + pd.Timedelta(minutes=15 * (K + 1))
            keep = lambda ev: [e for e in ev if e["ts"] is None or pd.Timestamp(e["ts"]) <= t_k1]  # noqa: E731
            if keep(base) != keep(alt):
                msgs.append(f"session on {nxt:%Y-%m-%d} changes before bar {K + 1} when later bars are altered")
    finally:
        S.get_bars = orig
    return msgs


def run_audit(market: Market, cutoffs: int = 3) -> list[str]:
    cfg = load_config()
    syms = sorted(market.cash["symbol"].unique())
    dates = market.dates
    cut = [dates[-1 - k] for k in np.linspace(5, min(300, len(dates) - 60), cutoffs).astype(int)]
    msgs = audit_feature_fn(lambda m: build_feature_frame(m, cfg, symbols=syms), market, cut)
    msgs += audit_signals(market, cut[:2])
    msgs += audit_timing(market)
    msgs += audit_session(market)
    return msgs


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cutoffs", type=int, default=3)
    ap.add_argument("--days", type=int, default=450, help="trailing days of data to audit (speed)")
    a = ap.parse_args(argv)
    m = load_market()
    first = m.dates[-a.days]
    keep = lambda df: df[df["date"] >= first] if len(df) else df  # noqa: E731
    m = Market(keep(m.cash), keep(m.fo), keep(m.idx), keep(m.iv), m.events, m.source)
    msgs = run_audit(m, a.cutoffs)
    for x in msgs:
        print("LOOKAHEAD:", x)
    print("FAIL" if msgs else "OK: no feature, signal or timing rule uses future data", f"({m.source} data)")
    return 1 if msgs else 0


if __name__ == "__main__":
    sys.exit(main())
