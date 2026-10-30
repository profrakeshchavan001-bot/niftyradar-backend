"""Backtest on split/bonus-adjusted prices (robust.adjust_corporate_actions, same as the live loader).

    python backtest/adjusted_run.py

1. adjust cash prices; 2. recalibrate Layer 1 weights/grades on train only; 3. tune Layer 2/3 filters on
train only (layers.py grid); 4. report per setup / per grade, train and test, untouched.
Setups: trend / pullback / index come from the engine; "event" (volume >= 2x its prior 20d mean AND
|gap| >= 1.5% on the signal day) is a fixed definition chosen before looking at results, and takes priority.
Grade buckets use ALL qualifying candidates (not only the daily top 5) so grade C exists.
"""
from __future__ import annotations

import itertools
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backtest import layers as L  # noqa: E402
from backtest.calibrate import calibrate, with_grades  # noqa: E402
from backtest.engine import (COMPONENTS, EXEC, build_panel, normalise,  # noqa: E402
                             prepare_candidates, stats)
from common import ROOT, load_config, load_dataset  # noqa: E402
from features import load_sectors  # noqa: E402
from robust import adjust_corporate_actions, new_notes  # noqa: E402

MIN = 100


def bucket(g, a, b):
    s = stats(g)
    r = L.row("", s, a, b)
    r["trust"] = "ok" if s["trades"] >= MIN else "too few to trust"
    return r


def main() -> int:
    cfg0 = load_config()
    cash, fo, idx = load_dataset("cash"), load_dataset("fo"), load_dataset("idx")
    raw_n = len(cash)
    notes = new_notes()
    cash = adjust_corporate_actions(cash, notes, 0.10, 0.40)
    last = cash["date"].max()
    test = (L.TEST_START, f"{last:%Y-%m-%d}")
    sectors = load_sectors()
    cand = prepare_candidates(build_panel(cash, fo, idx, cfg0, sectors), cfg0)
    w, (ga, gb), note = calibrate(cand, cfg0)
    cfg = {**with_grades(cfg0, ga, gb), "weights": {k: round(v, 2) for k, v in w.items()}}
    trading = pd.DatetimeIndex(sorted(cash["date"].unique()))
    feats = L.candle_features(cash, cand["symbol"].unique())
    df = L.add_layer_flags(cand, feats, trading, L.expiry_days(trading))
    # event setup
    c = cash.sort_values(["symbol", "date"]).copy()
    vavg = c.groupby("symbol")["volume"].transform(lambda s: s.shift(1).rolling(20, min_periods=20).mean())
    c["ev"] = (c["volume"] >= 2 * vavg) & ((c["open"] / c["prev_close"] - 1).abs() >= 0.015)
    df = df.merge(c[["date", "symbol", "ev"]], on=["date", "symbol"], how="left")
    df["setup"] = np.where(df["ev"].fillna(False), "event", df["setup"])
    wn = normalise(cfg["weights"])
    df["score"] = np.round(sum(df["f_" + k] * wn[k] for k in COMPONENTS), 1)
    df["grade"] = np.where(df["score"] >= cfg["grades"]["A"], "A", np.where(df["score"] >= cfg["grades"]["B"], "B", "C"))
    df["R"] = df["gross_R"] - EXEC["cost_r"]

    # tune L2/L3 filters on train only (top-5 A/B trades, as before)
    grid = [dict(l2=l2, squeeze=sq, chop=ch, event=ev, expiry=ex) for l2, sq, ch, ev, ex in itertools.product(
        [None, "candle", "close", "break", "any"], [False, True], [None, 0.15, 0.25, 0.35], [False, True], [False, True])]
    scored = []
    for p in grid:
        s = stats(L.run(df, cfg, cfg["weights"], p, *L.TRAIN))
        if s["trades"] >= L.MIN_TRADES and np.isfinite(s["expectancy"]):
            scored.append((s["expectancy"], p))
    best = max(scored, key=lambda x: x[0])[1]

    out = {"adjustment": dict(rows=raw_n, events=len(notes["corp_actions"])), "note": note,
           "weights": cfg["weights"], "grades": cfg["grades"], "best_filters": best, "stack": {}, "buckets": {}}
    for name, p in {"L1 only": {}, "L1+L2+L3 tuned": best}.items():
        out["stack"][name] = {sp: L.row(name, stats(L.run(df, cfg, cfg["weights"], p, a, b)), a, b)
                              for sp, (a, b) in (("train", L.TRAIN), ("test", test))}
    for sp, (a, b) in (("train", L.TRAIN), ("test", test)):
        d = df[(df["date"] >= a) & (df["date"] <= b) & (df["score"] >= 0)]
        for col in ("setup", "grade"):
            for k, g in d.groupby(col):
                out["buckets"].setdefault(f"{col}:{k}", {})[sp] = bucket(g, a, b)
        # same buckets restricted to the daily top-5 grade A/B trades
        t5 = L.select_trades(df, cfg, cfg["weights"], a, b)
        for col in ("setup", "grade"):
            for k, g in t5.groupby(col):
                out["buckets"].setdefault(f"top5 {col}:{k}", {})[sp] = bucket(g, a, b)
    both = [k for k, v in out["buckets"].items() if k.startswith(("setup", "grade")) and "train" in v and "test" in v
            and v["train"].get("exp", -9) > 0 and v["test"].get("exp", -9) > 0
            and v["train"]["trades"] >= MIN and v["test"]["trades"] >= MIN]
    out["positive_both"] = both
    d = ROOT / "backtest" / "results" / f"adjusted-{pd.Timestamp.now():%Y%m%d-%H%M%S}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "summary.json").write_text(json.dumps(out, indent=1, default=str))
    (ROOT / "config_adjusted.yaml").write_text("# tuned on adjusted prices, train only\n" + yaml.safe_dump(
        {**cfg, "layers": best}, sort_keys=False))
    print(json.dumps(out, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
