"""Apples-to-apples comparison for docs/BACKTEST-YT-REAL-DATA-31OCT.md.

Runs (a) the earlier Black-Scholes/VIX model (options_yt) with costs doubled and the same 2023-01-01 split, and
(b) the real-settle engine with 1x costs, so the gap between modelled and real results can be split into
"price source" and "cost level". Output: backtest/results/compare_modelled_real.json
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import options_real as R  # noqa: E402
import options_yt as oy  # noqa: E402


def modelled(cost_mult: float):
    orig = oy.txn_cost
    oy.txn_cost = lambda px, sell: cost_mult * orig(px, sell)
    try:
        m, _ = oy.prepare(oy.load_series())
        mo, we = oy.expiry_calendar(m.index)
        cut = pd.Timestamp("2023-01-01")
        out = {}
        for name in ("condor", "strangle", "calendar"):
            trades, eq, _ = oy.run_strategy(name, m, mo, we)
            tr = pd.DataFrame(trades)
            tr["entry"] = pd.to_datetime(tr.entry)
            out[name] = {"train": oy.summarize(tr[tr.entry < cut], eq[eq.index < cut]),
                         "test": oy.summarize(tr[tr.entry >= cut], eq[eq.index >= cut])}
        return out
    finally:
        oy.txn_cost = orig


def real_1x():
    R.COST_MULT = 1.0
    days = R.trading_days()
    out = {}
    for name in ("condor", "strangle_d18", "strangle_p100", "calendar"):
        trades, eq, _ = R.run(name, days)
        ev = R.evaluate(trades, eq)
        out[name] = {"train": ev["train"], "test": ev["test"], "wf_total": ev["walk_forward"]["total_inr"],
                     "wf_pos": f'{ev["walk_forward"]["positive_windows"]}/{ev["walk_forward"]["n_windows"]}',
                     "verdict_at_1x_cost": ev["verdict"]}
    return out


if __name__ == "__main__":
    res = {"modelled_cost_x2": modelled(2.0), "real_cost_x1": real_1x()}
    (HERE / "results" / "compare_modelled_real.json").write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
    for k, v in res.items():
        for n, s in v.items():
            print(k, n, s["train"].get("total_inr"), s["test"].get("total_inr"))
