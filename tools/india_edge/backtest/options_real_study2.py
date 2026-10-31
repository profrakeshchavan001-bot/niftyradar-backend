"""Study 2 (pre-registered grid, real settle prices only, costs 2x, nothing re-chosen per year):

  A) BANKNIFTY monthly structures: strangle d18, strangle p100 and condor, base rule plus 3 other deltas (or premiums) and
     3 other stop levels, one parameter changed at a time.
  B) NIFTY weekly structures (strangle d18, condor): expiry-day-only entries (0 DTE) and 2-DTE entries, same grid.
  C) Out-of-sample: for every family, choose the set with the best net on entries <= 2021 (min 15 trades), then read its
     2022+ result; also the frozen base rule on both halves.

A set 'passes' when the preset rule holds (train and test >= 20 trades, test > 0, walk-forward total > 0, at least half the
calendar years positive) AND at least 5 of the 8 years 2019-2026 are positive. Nothing here selects a rule for trading.
    python backtest/options_real_study2.py            # writes backtest/options_real_study2.json (+ results/ trades)
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import options_real as R  # noqa: E402
import options_real_more as M  # noqa: E402

OOS_SPLIT = pd.Timestamp("2022-01-01")
YEARS = list(range(2019, 2027))
MIN_FIT_TRADES = 15

DELTAS = {"strangle_d18": ("delta", [0.12, 0.24, 0.30]),
          "strangle_p100": ("premium", [70.0, 140.0, 200.0]),
          "condor": ("short_delta", [0.20, 0.25, 0.35])}
STOPS = {"strangle_d18": ("sl", [8000, 18000, 26000]), "strangle_p100": ("sl", [8000, 18000, 26000]),
         "condor": ("sl_mult", [0.5, 1.5, 2.0])}
MODES = {"monthly": {}, "weekly0": {"weekly": True, "entry_lo": 0, "entry_hi": 0, "exit_dte": -1, "unstable_dte": -1},
         "weekly2": {"weekly": True, "entry_lo": 2, "entry_hi": 2, "exit_dte": -1, "unstable_dte": -1}}
FAMILIES = [("BANKNIFTY", "monthly", "strangle_d18"), ("BANKNIFTY", "monthly", "strangle_p100"),
            ("BANKNIFTY", "monthly", "condor"), ("NIFTY", "weekly0", "strangle_d18"), ("NIFTY", "weekly0", "condor"),
            ("NIFTY", "weekly2", "strangle_d18"), ("NIFTY", "weekly2", "condor")]


def param_sets(name, mode):
    """{set_name: params}: the base rule plus one-at-a-time deltas and stops (the pre-registered grid)."""
    base = dict(MODES[mode])
    out = {"base": base}
    dk, dv = DELTAS[name]
    for v in dv:
        out[f"{dk}={v:g}"] = {**base, dk: v}
    sk, sv = STOPS[name]
    for v in sv:
        out[f"{sk}={v:g}"] = {**base, sk: v}
    return out


def _job(a):
    symbol, mode, name, sname, params = a
    R.configure(symbol, 2.0)
    days = R.trading_days()
    trades, eq, extra = R.run(name, days, params)
    ev = R.evaluate(trades, eq)
    tr = pd.DataFrame(trades)
    if not tr.empty:
        tr["entry"] = pd.to_datetime(tr.entry)
        tr["exit"] = pd.to_datetime(tr.exit)
    return (symbol, mode, name, sname), tr, ev


# ---------------------------------------------------------------- pure analysis helpers (unit tested)
def year_table(tr: pd.DataFrame) -> dict:
    if tr.empty:
        return {}
    g = tr.groupby(tr.entry.dt.year).net.sum()
    return {str(y): round(float(g.get(y, 0.0))) for y in YEARS}


def passes(ev: dict, tr: pd.DataFrame) -> dict:
    yrs = year_table(tr)
    pos = sum(v > 0 for v in yrs.values())
    return {"preset_rule": bool(ev.get("survivor")), "positive_years_2019_26": pos, "n_years": len(YEARS),
            "passes": bool(ev.get("survivor") and pos >= 5)}


def half_net(tr: pd.DataFrame, lo=None, hi=None) -> dict:
    h = tr
    if lo is not None:
        h = h[h.entry >= lo]
    if hi is not None:
        h = h[h.entry < hi]
    return {"trades": int(len(h)), "net_inr": round(float(h.net.sum())),
            "win_pct": round(float((h.net > 0).mean() * 100), 1) if len(h) else None}


def oos_fit(sets: dict) -> dict:
    """sets: {set_name: trades df}. Fit = best net on entries before 2022 with >= MIN_FIT_TRADES; then read 2022+."""
    rows = {k: (half_net(t, hi=OOS_SPLIT), half_net(t, lo=OOS_SPLIT)) for k, t in sets.items() if not t.empty}
    cand = {k: v for k, v in rows.items() if v[0]["trades"] >= MIN_FIT_TRADES}
    out = {"table": {k: {"fit": v[0], "oos": v[1]} for k, v in rows.items()}}
    if not cand:
        out["chosen"] = None
        out["note"] = f"no set has >= {MIN_FIT_TRADES} trades before 2022"
        return out
    best = max(cand, key=lambda k: cand[k][0]["net_inr"])
    out["chosen"] = {"set": best, "fit": cand[best][0], "oos": cand[best][1]}
    out["base"] = out["table"].get("base")
    out["sets_positive_in_both"] = f'{sum(v[0]["net_inr"] > 0 and v[1]["net_inr"] > 0 for v in cand.values())}/{len(cand)}'
    out["sets_positive_oos"] = f'{sum(v[1]["net_inr"] > 0 for v in cand.values())}/{len(cand)}'
    return out


def main():
    jobs = [(s, m, n, k, p) for s, m, n in FAMILIES for k, p in param_sets(n, m).items()]
    with ProcessPoolExecutor(4) as ex:
        res = list(ex.map(_job, jobs, chunksize=1))
    vix = M.vix_series()
    out = {"generated": str(pd.Timestamp.now().date()), "cost_multiplier": 2.0, "oos_split": str(OOS_SPLIT.date()),
           "families": {}}
    outdir = HERE / "results"
    outdir.mkdir(exist_ok=True)
    allt = []
    for s, m, n in FAMILIES:
        fam, sets = {}, {}
        for (s2, m2, n2, k), tr, ev in res:
            if (s2, m2, n2) != (s, m, n):
                continue
            sets[k] = tr
            if not tr.empty:
                allt.append(tr.assign(symbol=s, mode=m, set=k))
            reg = M.splits(s, tr, vix).get(n, {}) if not tr.empty else {}
            fam[k] = {"params": param_sets(n, m)[k], "trades": int(len(tr)),
                      "train": ev["train"], "test": ev["test"], "walk_forward_total": ev["walk_forward"]["total_inr"],
                      "years": year_table(tr), "verdict": ev["verdict"], **passes(ev, tr), "regimes": reg,
                      "exit_reasons": ev.get("exit_reasons"), "trades_over_1_1x_sl": ev.get("trades_over_1_1x_sl")}
        out["families"][f"{s}/{m}/{n}"] = {"sets": fam, "oos": oos_fit(sets)}
        print(s, m, n, {k: (v["trades"], v["passes"]) for k, v in fam.items()}, flush=True)
    if allt:
        pd.concat(allt).to_parquet(outdir / "options_real_study2_trades.parquet", index=False)
    (HERE / "options_real_study2.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
