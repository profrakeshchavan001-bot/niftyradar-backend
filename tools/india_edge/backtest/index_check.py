"""Deep check of the "index" setup: per year, rolling 5-year walk-forward, cost sensitivity, drawdown.

    python backtest/index_check.py     (uses config_adjusted.yaml weights/grades; nothing is re-tuned)
Two variants: top5 = daily top-5 grade A/B trades that are "index"; all = every qualifying "index" candidate.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backtest import layers as L  # noqa: E402
from backtest.engine import COMPONENTS, EXEC, build_panel, normalise, prepare_candidates  # noqa: E402
from common import ROOT, load_config, load_dataset  # noqa: E402
from features import load_sectors  # noqa: E402
from robust import adjust_corporate_actions, new_notes  # noqa: E402
import yaml  # noqa: E402

COSTS = (0.1, 0.2, 0.3)


def mdd(r):
    c = np.cumsum(r)
    return float(np.max(np.maximum.accumulate(np.concatenate([[0.0], c]))[1:] - c)) if len(r) else 0.0


def summ(g, cost):
    r = (g["gross_R"] - cost).to_numpy()
    return dict(trades=len(r), avg_r=round(float(r.mean()), 3) if len(r) else None,
                win_pct=round(float((r > 0).mean() * 100), 1) if len(r) else None, max_dd_r=round(mdd(r), 1))


def analyse(t):
    t = t.sort_values(["exit_date", "date"]).copy()
    t["year"] = t["date"].dt.year
    out = {"per_year": {}, "cost": {}, "walk_forward": {}}
    for y, g in t.groupby("year"):
        out["per_year"][int(y)] = summ(g, 0.1)
    for c in COSTS:
        out["cost"][str(c)] = {"train": summ(t[t["date"] <= "2022-12-31"], c), "test": summ(t[t["date"] > "2022-12-31"], c),
                               "all": summ(t, c)}
    for c in COSTS:
        rows, traded = {}, []
        for y in range(2020, int(t["year"].max()) + 1):
            tr, te = t[(t["year"] >= y - 5) & (t["year"] < y)], t[t["year"] == y]
            if len(tr) < 30 or len(te) == 0:
                continue
            tr_exp = float((tr["gross_R"] - c).mean())
            rows[y] = dict(train_n=len(tr), train_exp=round(tr_exp, 3), test_n=len(te),
                           test_exp=round(float((te["gross_R"] - c).mean()), 3), selected=bool(tr_exp > 0))
            if tr_exp > 0:
                traded.append(te["gross_R"] - c)
        oos = pd.concat(traded) if traded else pd.Series(dtype=float)
        out["walk_forward"][str(c)] = dict(years=rows, traded_trades=len(oos),
                                           traded_avg_r=round(float(oos.mean()), 3) if len(oos) else None)
    return out


def main():
    cfg0 = load_config()
    ca = yaml.safe_load(open(ROOT / "config_adjusted.yaml"))
    cash, fo, idx = load_dataset("cash"), load_dataset("fo"), load_dataset("idx")
    cash = adjust_corporate_actions(cash, new_notes(), 0.10, 0.40)
    cand = prepare_candidates(build_panel(cash, fo, idx, cfg0, load_sectors()), cfg0)
    cfg = {**cfg0, "grades": ca["grades"], "weights": ca["weights"]}
    c = cash.sort_values(["symbol", "date"]).copy()
    vavg = c.groupby("symbol")["volume"].transform(lambda s: s.shift(1).rolling(20, min_periods=20).mean())
    c["ev"] = (c["volume"] >= 2 * vavg) & ((c["open"] / c["prev_close"] - 1).abs() >= 0.015)
    cand = cand.merge(c[["date", "symbol", "ev"]], on=["date", "symbol"], how="left")
    cand["setup"] = np.where(cand["ev"].fillna(False), "event", cand["setup"])
    wn = normalise(cfg["weights"])
    cand["score"] = np.round(sum(cand["f_" + k] * wn[k] for k in COMPONENTS), 1)
    allidx = cand[(cand["setup"] == "index") & (cand["score"] >= 0)]
    from backtest.engine import select_trades
    top = select_trades(cand, cfg, cfg["weights"], "2015-01-01", str(cand["date"].max().date()))
    top5 = top[top["setup"] == "index"]
    res = {"top5_index": analyse(top5), "all_index": analyse(allidx)}
    Path(__file__).with_name("index_check.json").write_text(json.dumps(res, indent=1))
    for k, v in res.items():
        print(k)
        print(" per-year", {y: (s["trades"], s["avg_r"]) for y, s in v["per_year"].items()})
        print(" cost", {c: (s["train"]["trades"], s["train"]["avg_r"], s["test"]["trades"], s["test"]["avg_r"], s["all"]["max_dd_r"]) for c, s in v["cost"].items()})
        print(" wf", {c: (s["traded_trades"], s["traded_avg_r"]) for c, s in v["walk_forward"].items()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
