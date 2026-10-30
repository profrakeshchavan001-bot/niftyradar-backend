"""Lookahead-bias audit on the real stored data.

    python backtest/audit.py [--cuts 8]

For several cut dates T, recompute features and universe membership using ONLY
rows dated <= T and compare them with the full-history values at T. Any
difference means a feature peeks at a later row. Also checks that trades enter
at the open AFTER the signal day and that the signal day's own values are the
latest ones used. Exits non-zero (and says which column) on any violation.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backtest.engine import EXEC, monthly_membership, simulate_side  # noqa: E402
from common import load_config, load_dataset  # noqa: E402
from features import build_features, load_sectors  # noqa: E402

NUM_COLS = ["close", "price_chg_pct", "fut_oi", "oi_chg_pct", "deliv_pct", "deliv_ratio",
            "rs", "sector_rs", "unusual_oi", "adv_cr"]


def _cut(df, t):
    return df[df["date"] <= t]


def audit(cash, fo, idx, cfg, sectors, n_cuts: int = 8, log=print) -> list[str]:
    errors = []
    dates = pd.DatetimeIndex(sorted(cash["date"].unique()))
    member = monthly_membership(fo, dates, cfg["universe"]["size"], cfg["universe"]["lookback_days"])
    syms = list(member.columns[member.any()])
    cuts = dates[np.linspace(60, len(dates) - 10, n_cuts).astype(int)]
    full = build_features(cash, fo, idx, syms, sectors, cfg["lookback"]).set_index(["date", "symbol"])
    for t in cuts:
        part = build_features(_cut(cash, t), _cut(fo, t), _cut(idx, t), syms, sectors,
                              cfg["lookback"]).set_index(["date", "symbol"])
        a, b = full.xs(t, level="date"), part.xs(t, level="date")
        a, b = a.reindex(b.index), b
        for c in NUM_COLS:
            x, y = a[c].to_numpy(float), b[c].to_numpy(float)
            bad = ~(np.isclose(x, y, rtol=1e-9, equal_nan=True))
            if bad.any():
                errors.append(f"feature {c} at {t:%Y-%m-%d} changes when later rows are added "
                              f"({int(bad.sum())} symbols, e.g. {b.index[bad][0]})")
        if not (a["quadrant"].to_numpy() == b["quadrant"].to_numpy()).all():
            errors.append(f"quadrant at {t:%Y-%m-%d} uses later rows")
        m_part = monthly_membership(_cut(fo, t), dates[dates <= t], cfg["universe"]["size"],
                                    cfg["universe"]["lookback_days"])
        row_full = member.loc[t]
        row_part = m_part.loc[t].reindex(row_full.index, fill_value=False)
        if not (row_full == row_part).all():
            errors.append(f"universe membership on {t:%Y-%m-%d} uses later rows")
        log(f"cut {t:%Y-%m-%d}: {len(b)} symbols checked")

    # execution: entry is the next session's open; a signal on the last day cannot trade
    O = cash.pivot(index="date", columns="symbol", values="open").reindex(dates)[syms[:20]]
    H, L, C = (cash.pivot(index="date", columns="symbol", values=c).reindex(dates)[syms[:20]]
               for c in ("high", "low", "close"))
    atr = (H - L).rolling(14).mean()
    R, K = simulate_side(O, H, L, C, atr, "long", EXEC["stop_atr"], EXEC["target_r"], EXEC["hold"])
    if R.iloc[-1].notna().any():
        errors.append("a trade was simulated from the last day's signal (no next open exists)")
    if (K.stack() < 1).any():
        errors.append("a trade exits on its own signal day")
    return errors


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cuts", type=int, default=8)
    a = ap.parse_args(argv)
    errs = audit(load_dataset("cash"), load_dataset("fo"), load_dataset("idx"),
                 load_config(), load_sectors(), a.cuts)
    if errs:
        print("LOOKAHEAD AUDIT FAILED:")
        for e in errs:
            print("  " + e)
        return 1
    print("lookahead audit passed: features, universe and entries use only data up to the signal close")
    return 0


if __name__ == "__main__":
    sys.exit(main())
