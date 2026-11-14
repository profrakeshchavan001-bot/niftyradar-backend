"""Backtest CLI.

    python backtest/run.py --train --test

--train tunes weights on 2015-01-01..2022-12-31 only (coarse grid, best expectancy
with >= 200 trades) and saves config_tuned.yaml; --test reports 2023-01-01..today
with those weights untouched. Original config.yaml is never modified.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backtest.engine import (EXEC, build_panel, breakdown, equity_curve,  # noqa: E402
                             prepare_candidates, select_trades, stats, tune)
from common import ROOT, load_config, load_dataset  # noqa: E402
from features import load_sectors  # noqa: E402

TRAIN = ("2015-01-01", "2022-12-31")
TEST_START = "2023-01-01"
OUT = ROOT / "backtest" / "out"
TUNED = ROOT / "config_tuned.yaml"


def fmt(s: dict) -> str:
    if s["trades"] == 0:
        return "0 trades"
    return (f"{s['trades']} | {s['win_pct']:.1f}% | {s['avg_R']:+.3f} | {s['profit_factor']:.2f} | "
            f"{s['max_dd_R']:.1f} | {s['expectancy']:+.3f}")


def table(rows: dict) -> list[str]:
    head = ["| Slice | Trades | Win % | Avg R (gross) | PF | Max DD (R) | Expectancy (net R) |",
            "|---|---|---|---|---|---|---|"]
    return head + [f"| {k} | {fmt(s)} |" for k, s in rows.items()]


def run_pipeline(cash, fo, idx, cfg, sectors, do_train=True, do_test=True,
                 out_dir: Path = OUT, tuned_path: Path = TUNED, train=TRAIN,
                 test_start=TEST_START, min_trades: int = 200, grid=None) -> dict:
    out_dir.mkdir(parents=True, exist_ok=True)
    last = cash["date"].max()
    panel = build_panel(cash, fo, idx, cfg, sectors)
    cand = prepare_candidates(panel, cfg)
    base_w = cfg["weights"]
    note = ""
    if do_train:
        best, _ = tune(cand, cfg, train[0], train[1], grid=grid, min_trades=min_trades)
        if best is None:
            weights, note = base_w, f"No grid point reached {min_trades} train trades; original weights kept."
        else:
            weights = best[0]
            tuned = {**cfg, "weights": {k: round(v, 2) for k, v in weights.items()}}
            tuned_path.write_text("# Tuned on train split only; see backtest/out/report_*.md\n"
                                  + yaml.safe_dump(tuned, sort_keys=False))
    elif tuned_path.exists():
        weights = yaml.safe_load(tuned_path.read_text())["weights"]
    else:
        weights, note = base_w, "config_tuned.yaml not found; original weights used."

    splits = {}
    if do_train:
        splits["train"] = (train[0], train[1])
    if do_test:
        splits["test"] = (test_start, last)
    res, curves, lines = {}, [], [f"# Layer 1 backtest report, {last:%Y-%m-%d}", "",
        f"Execution: enter next open, stop {EXEC['stop_atr']}x ATR({EXEC['atr_n']}), target "
        f"{EXEC['target_r']}R, exit at close of day {EXEC['hold']}, cost {EXEC['cost_r']}R, "
        f"{EXEC['risk_pct']}% risk. Top {cfg['top_n']} per day, grades A/B only. "
        "Statistics on historical data, not advice.", ""]
    if note:
        lines += [f"**Note:** {note}", ""]
    lines += ["Weights used: " + ", ".join(f"{k} {v:.1f}" for k, v in
                                           {k: weights[k] for k in base_w}.items()), ""]
    for name, (a, b) in splits.items():
        tr = select_trades(cand, cfg, weights, a, b)
        base_tr = select_trades(cand, cfg, base_w, a, b)
        res[name] = stats(tr)
        curves.append(equity_curve(tr, name))
        lines += [f"## {name.title()} {a} to {pd.Timestamp(b):%Y-%m-%d}", ""]
        lines += table({"tuned weights": res[name], "original weights": stats(base_tr)}) + [""]
        for col, title in (("grade", "By grade"), ("setup", "By setup type"), ("direction", "By direction")):
            bd = breakdown(tr, col)
            lines += [f"**{title}**", ""] + table({k: bd.loc[k].to_dict() for k in bd.index}) + [""]
    stamp = f"{last:%Y-%m-%d}"
    (out_dir / f"report_{stamp}.md").write_text("\n".join(lines) + "\n")
    if curves:
        pd.concat(curves).to_csv(out_dir / "equity.csv", index=False)
    return {"stats": res, "weights": weights, "report": out_dir / f"report_{stamp}.md"}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--train", action="store_true", help="tune weights on the train split and report it")
    ap.add_argument("--test", action="store_true", help="report the test split")
    a = ap.parse_args(argv)
    if not (a.train or a.test):
        a.train = a.test = True
    cash, fo, idx = load_dataset("cash"), load_dataset("fo"), load_dataset("idx")
    if cash.empty or fo.empty or idx.empty:
        raise SystemExit("no data: run `python data/fetch.py --from 2015-01-01 --to <today>` first")
    r = run_pipeline(cash, fo, idx, load_config(), load_sectors(), a.train, a.test)
    for k, s in r["stats"].items():
        print(k, fmt(s))
    print("report:", r["report"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
