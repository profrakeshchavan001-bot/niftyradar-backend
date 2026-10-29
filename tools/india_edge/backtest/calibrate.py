"""Train/test backtest with weight + grade-threshold calibration on the train split only.

    python backtest/calibrate.py

Train 2015-01-01..2022-12-31, test 2023-01-01..last day, 0.1R cost per trade,
universe = monthly top 60 F&O stocks by option contracts (engine defaults).
Calibration (coordinate search, train only, best net expectancy with >= 200
trades): Layer 1 weights on a 10/20/30 grid -> A/B cut-offs -> weights again.
Also reports 2024-only and 2026-only windows. Writes backtest/results/<stamp>/.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backtest.engine import (EXEC, build_panel, equity_curve, prepare_candidates,  # noqa: E402
                             select_trades, stats, weight_grid)
from common import ROOT, load_config, load_dataset  # noqa: E402
from features import load_sectors  # noqa: E402

TRAIN = ("2015-01-01", "2022-12-31")
TEST_START = "2023-01-01"
MIN_TRADES = 200
GRADE_GRID = [(a, b) for b in (40, 45, 50, 55, 60) for a in (60, 65, 70, 75, 80) if a >= b + 10]
OVERFIT_GAP_R = 0.05  # train minus test expectancy beyond this is flagged


def months(a, b) -> float:
    return max((pd.Timestamp(b) - pd.Timestamp(a)).days / 30.44, 1.0)


def summarise(tr: pd.DataFrame, a, b) -> dict:
    s = stats(tr)
    s["trades_per_month"] = s["trades"] / months(a, b)
    return {k: (None if isinstance(v, float) and not np.isfinite(v) else v) for k, v in s.items()}


def by(tr: pd.DataFrame, col: str, a, b) -> dict:
    return {str(k): summarise(g, a, b) for k, g in tr.groupby(col)}


def with_grades(cfg: dict, a: int, b: int) -> dict:
    return {**cfg, "grades": {"A": a, "B": b}}


def search(cand, cfg, weights_grid, grades_grid, start, end):
    best = None
    for w in weights_grid:
        for a, b in grades_grid:
            s = stats(select_trades(cand, with_grades(cfg, a, b), w, start, end))
            if s["trades"] >= MIN_TRADES and np.isfinite(s["expectancy"]) and (
                    best is None or s["expectancy"] > best[2]["expectancy"]):
                best = (w, (a, b), s)
    return best


def calibrate(cand, cfg):
    g0 = (cfg["grades"]["A"], cfg["grades"]["B"])
    grid = weight_grid()
    step1 = search(cand, cfg, grid, [g0], *TRAIN)
    if step1 is None:
        return cfg["weights"], g0, "no weight set reached the minimum train trades"
    step2 = search(cand, cfg, [step1[0]], GRADE_GRID, *TRAIN)
    step3 = search(cand, cfg, grid, [step2[1]], *TRAIN)
    return step3[0], step3[1], ""


def fmt_row(name, s):
    if not s or not s["trades"]:
        return f"| {name} | 0 | | | | | | |"
    pf = "inf" if s["profit_factor"] is None else f"{s['profit_factor']:.2f}"
    return (f"| {name} | {s['trades']} | {s['trades_per_month']:.1f} | {s['win_pct']:.1f}% | "
            f"{s['avg_R']:+.3f} | {s['expectancy']:+.3f} | {pf} | {s['max_dd_R']:.1f} |")


HEAD = ["| Slice | Trades | Trades/mo | Win % | Avg R gross | Expectancy net R | PF | Max DD R |",
        "|---|---|---|---|---|---|---|---|"]


def main() -> int:
    cfg = load_config()
    cash, fo, idx = load_dataset("cash"), load_dataset("fo"), load_dataset("idx")
    last = cash["date"].max()
    stamp = pd.Timestamp.now().strftime("%Y%m%d-%H%M%S")
    out = ROOT / "backtest" / "results" / stamp
    out.mkdir(parents=True, exist_ok=True)

    cand = prepare_candidates(build_panel(cash, fo, idx, cfg, load_sectors()), cfg)
    w, (ga, gb), note = calibrate(cand, cfg)
    tuned = {**with_grades(cfg, ga, gb), "weights": {k: round(v, 2) for k, v in w.items()}}

    windows = {"train": TRAIN, "test": (TEST_START, f"{last:%Y-%m-%d}"),
               "2024": ("2024-01-01", "2024-12-31"), "2026": ("2026-01-01", f"{last:%Y-%m-%d}")}
    res = {"generated_at": stamp, "last_day": f"{last:%Y-%m-%d}", "exec": EXEC,
           "universe": "monthly top 60 F&O stocks by 20d avg option contracts",
           "original": {"weights": cfg["weights"], "grades": cfg["grades"]},
           "tuned": {"weights": tuned["weights"], "grades": tuned["grades"]}, "note": note,
           "windows": {}}
    curves = []
    for name, (a, b) in windows.items():
        tr = select_trades(cand, tuned, w, a, b)
        base = select_trades(cand, cfg, cfg["weights"], a, b)
        res["windows"][name] = {"range": [a, b], "tuned": summarise(tr, a, b),
                                "original": summarise(base, a, b),
                                "by_grade": by(tr, "grade", a, b), "by_setup": by(tr, "setup", a, b),
                                "by_direction": by(tr, "direction", a, b)}
        if name in ("train", "test"):
            curves.append(equity_curve(tr, name))
            tr.to_csv(out / f"trades_{name}.csv", index=False)
    tr_s, te_s = res["windows"]["train"]["tuned"], res["windows"]["test"]["tuned"]
    gap = (tr_s["expectancy"] or 0) - (te_s["expectancy"] or 0)
    res["overfit"] = {"train_minus_test_expectancy_R": gap, "flag": bool(gap > OVERFIT_GAP_R)}

    lines = [f"# Backtest {stamp} (data to {last:%Y-%m-%d})", "",
             f"Tuned weights: {tuned['weights']}; grades A>={ga}, B>={gb} "
             f"(original A>={cfg['grades']['A']}, B>={cfg['grades']['B']}). {note}",
             f"Overfit check: train-test expectancy gap {gap:+.3f}R -> "
             f"{'FLAGGED' if res['overfit']['flag'] else 'ok'}", ""]
    for name, r in res["windows"].items():
        lines += [f"## {name} {r['range'][0]} to {r['range'][1]}", ""] + HEAD
        lines += [fmt_row("tuned", r["tuned"]), fmt_row("original", r["original"])]
        for key in ("by_grade", "by_setup", "by_direction"):
            lines += [fmt_row(f"{key[3:]} {k}", s) for k, s in r[key].items()]
        lines.append("")
    (out / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(res, indent=1, default=float))
    (out / "config_tuned.yaml").write_text(yaml.safe_dump(tuned, sort_keys=False))
    pd.concat(curves).to_csv(out / "equity.csv", index=False)
    print(f"tuned {tuned['weights']} A>={ga} B>={gb}")
    for name, r in res["windows"].items():
        print(fmt_row(name, r["tuned"]))
    print("overfit flag:", res["overfit"]["flag"], f"gap {gap:+.3f}R ->", out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
