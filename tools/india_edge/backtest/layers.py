"""3-layer daily-data backtest with ablation. Train 2015-22 (all tuning), test 2023-now (untouched).

    python backtest/layers.py

Layer 1 = calibrated scanner score (config_tuned.yaml). Layer 2 (DAILY PROXY, no intraday data):
signal-day candle pattern agrees with direction, optional volatility-squeeze context.
Layer 3 vetoes: chop (efficiency ratio), event day, expiry day. All features use data up to the
signal day's close; calendar facts (expiry, budget) for the entry day are known in advance.
Execution is the engine's: next open, 1.5 ATR stop, 2R target, 5-day exit, 0.1R cost.
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
from backtest.engine import (COMPONENTS, EXEC, build_panel, normalise,  # noqa: E402
                             prepare_candidates, select_trades, stats)
from common import ROOT, dataset_dir, load_config, load_dataset  # noqa: E402
from features import load_sectors  # noqa: E402

TRAIN = ("2015-01-01", "2022-12-31")
TEST_START = "2023-01-01"
MIN_TRADES = 200

# market-wide event days known from the calendar (daily data has no earnings dates)
EVENT_DAYS = ["2015-02-28", "2016-02-29", "2017-02-01", "2018-02-01", "2019-02-01", "2019-07-05",
              "2020-02-01", "2021-02-01", "2022-02-01", "2023-02-01", "2024-02-01", "2024-07-23",
              "2025-02-01", "2026-02-01",
              "2019-05-23", "2024-06-04", "2014-05-16"]  # general election results


# ------------------------------------------------------------- daily features
def candle_features(cash: pd.DataFrame, syms) -> pd.DataFrame:
    c = cash[cash["symbol"].isin(syms)].sort_values(["symbol", "date"]).copy()
    g = c.groupby("symbol")
    po, ph, pl, pc = (g[x].shift(1) for x in ("open", "high", "low", "close"))
    rng = (c["high"] - c["low"]).replace(0, np.nan)
    body = (c["close"] - c["open"]).abs()
    upper = c["high"] - c[["open", "close"]].max(axis=1)
    lower = c[["open", "close"]].min(axis=1) - c["low"]
    bull, bear = c["close"] > c["open"], c["close"] < c["open"]
    c["bull_engulf"] = bull & (po > pc) & (c["open"] <= pc) & (c["close"] >= po)
    c["bear_engulf"] = bear & (po < pc) & (c["open"] >= pc) & (c["close"] <= po)
    c["hammer"] = (lower >= 2 * body) & (upper <= 0.35 * rng) & (body > 0)
    c["shooter"] = (upper >= 2 * body) & (lower <= 0.35 * rng) & (body > 0)
    c["close_loc"] = (c["close"] - c["low"]) / rng                       # 1 = closed at the high
    c["inside"] = (c["high"] < ph) & (c["low"] > pl)
    c["brk_up"] = c["close"] > g["high"].transform(lambda s: s.shift(1).rolling(10).max())
    c["brk_dn"] = c["close"] < g["low"].transform(lambda s: s.shift(1).rolling(10).min())
    ret = g["close"].pct_change()
    sd = ret.groupby(c["symbol"]).transform(lambda s: s.rolling(20, min_periods=20).std())
    c["sd20"] = sd
    c["bbw_pct"] = sd.groupby(c["symbol"]).transform(
        lambda s: s.rolling(120, min_periods=60).apply(lambda w: (w[:-1] < w[-1]).mean() * 100, raw=True))
    # 20d efficiency ratio of closes
    net = (c["close"] - g["close"].shift(20)).abs()
    path = c["close"].diff().abs().groupby(c["symbol"]).transform(lambda s: s.rolling(20).sum())
    c["er20"] = net / path.replace(0, np.nan)
    # squeeze = vol percentile low within the last 5 sessions
    c["squeeze5"] = c.groupby("symbol")["bbw_pct"].transform(lambda s: s.rolling(5, min_periods=1).min()) <= 20
    return c[["date", "symbol", "bull_engulf", "bear_engulf", "hammer", "shooter", "close_loc",
              "inside", "brk_up", "brk_dn", "bbw_pct", "er20", "squeeze5"]]


def expiry_days(trading: pd.DatetimeIndex) -> set:
    out = set()
    for f in sorted(dataset_dir("fo").glob("*.parquet")):
        out.update(pd.read_parquet(f, columns=["expiry"])["expiry"].unique())
    ex = pd.to_datetime(pd.Series(list(out)), errors="coerce").dropna()
    return set(ex[ex.isin(trading)])


def add_layer_flags(cand: pd.DataFrame, feats: pd.DataFrame, trading: pd.DatetimeIndex, expiries: set):
    df = cand.merge(feats, on=["date", "symbol"], how="left")
    long_ = df["direction"] == "long"
    df["l2_candle"] = np.where(long_, df["bull_engulf"] | df["hammer"], df["bear_engulf"] | df["shooter"])
    df["l2_close"] = np.where(long_, df["close_loc"] >= 0.6, df["close_loc"] <= 0.4)
    df["l2_break"] = np.where(long_, df["brk_up"], df["brk_dn"])
    nxt = pd.Series(trading[1:], index=trading[:-1])
    entry_day = df["date"].map(nxt)
    evs = pd.DatetimeIndex(pd.to_datetime(EVENT_DAYS))
    t = pd.Series(trading)
    near = set()
    for e in evs:  # entry day is the event day or the day before it (2-day window)
        pos = t.searchsorted(e)
        near.update(t.iloc[max(pos - 1, 0):pos + 1].tolist())
    df["v_event"] = entry_day.isin(near)
    df["v_expiry"] = entry_day.isin(expiries) | df["date"].isin(expiries)
    df["er20"] = df["er20"]
    return df


# ------------------------------------------------------------- configurations
def apply(df: pd.DataFrame, p: dict) -> pd.DataFrame:
    m = pd.Series(True, index=df.index)
    if p.get("l2") == "candle":
        m &= df["l2_candle"].fillna(False)
    elif p.get("l2") == "close":
        m &= df["l2_close"].fillna(False)
    elif p.get("l2") == "break":
        m &= df["l2_break"].fillna(False)
    elif p.get("l2") == "any":
        m &= (df["l2_candle"] | df["l2_close"] & df["l2_break"]).fillna(False)
    if p.get("squeeze"):
        m &= df["squeeze5"].fillna(False)
    if p.get("chop") is not None:
        m &= df["er20"].fillna(1.0) >= p["chop"]
    if p.get("event"):
        m &= ~df["v_event"]
    if p.get("expiry"):
        m &= ~df["v_expiry"]
    return df[m]


def run(df, cfg, w, p, a, b):
    return select_trades(apply(df, p), cfg, w, a, b)


def row(name, s, a, b):
    mo = max((pd.Timestamp(b) - pd.Timestamp(a)).days / 30.44, 1)
    if not s["trades"]:
        return dict(name=name, trades=0)
    return dict(name=name, trades=s["trades"], per_mo=round(s["trades"] / mo, 1), win=round(s["win_pct"], 1),
                gross=round(s["avg_R"], 3), exp=round(s["expectancy"], 3), pf=round(s["profit_factor"], 2),
                dd=round(s["max_dd_R"], 1))


def main() -> int:
    cfg = load_config(ROOT / "config_tuned.yaml")
    cash, fo, idx = load_dataset("cash"), load_dataset("fo"), load_dataset("idx")
    last = cash["date"].max()
    test = (TEST_START, f"{last:%Y-%m-%d}")
    panel = build_panel(cash, fo, idx, cfg, load_sectors())
    cand = prepare_candidates(panel, cfg)
    trading = pd.DatetimeIndex(sorted(cash["date"].unique()))
    feats = candle_features(cash, cand["symbol"].unique())
    df = add_layer_flags(cand, feats, trading, expiry_days(trading))
    w = cfg["weights"]

    # ---- scoring diagnosis (train only): net R by component fraction tercile
    tr_all = df[(df["date"] >= TRAIN[0]) & (df["date"] <= TRAIN[1])]
    diag = {}
    for k in COMPONENTS:
        f = tr_all["f_" + k]
        diag[k] = {"corr_with_grossR": round(float(np.corrcoef(f, tr_all["gross_R"])[0, 1]), 4),
                   "R_when_zero": round(float(tr_all.loc[f == 0, "gross_R"].mean()), 3),
                   "R_when_high(>=.8)": round(float(tr_all.loc[f >= .8, "gross_R"].mean()), 3),
                   "n_high": int((f >= .8).sum())}
    sc = sum(tr_all["f_" + k] * normalise(w)[k] for k in COMPONENTS)
    diag["score_decile_grossR"] = {int(k): round(float(v), 3) for k, v in
                                   tr_all.groupby(pd.qcut(sc, 5, duplicates="drop", labels=False))["gross_R"].mean().items()}

    # ---- tune thresholds on TRAIN only
    grid = [dict(l2=l2, squeeze=sq, chop=ch, event=ev, expiry=ex)
            for l2, sq, ch, ev, ex in itertools.product(
                [None, "candle", "close", "break", "any"], [False, True],
                [None, 0.15, 0.25, 0.35], [False, True], [False, True])]
    scored = []
    for p in grid:
        s = stats(run(df, cfg, w, p, *TRAIN))
        if s["trades"] >= MIN_TRADES and np.isfinite(s["expectancy"]):
            scored.append((s["expectancy"], p, s["trades"]))
    scored.sort(key=lambda x: -x[0])
    best = scored[0][1]

    # ---- ablation, both splits (best params; params fixed from train)
    variants = {"L1 only": {}, "L1+L2": {k: best[k] for k in ("l2", "squeeze")},
                "L1+L3": {k: best[k] for k in ("chop", "event", "expiry")}, "L1+L2+L3 (tuned)": best}
    for k in ("l2", "squeeze", "chop", "event", "expiry"):
        variants[f"tuned minus {k}"] = {**best, k: None if k in ("l2", "chop") else False}
    out = {"best_params": best, "n_grid": len(grid), "diagnosis": diag, "train": [], "test": []}
    for name, p in variants.items():
        for split, (a, b) in (("train", TRAIN), ("test", test)):
            out[split].append(row(name, stats(run(df, cfg, w, p, a, b)), a, b))
    for yr, (a, b) in {"2024": ("2024-01-01", "2024-12-31"), "2026": ("2026-01-01", test[1])}.items():
        out["test"].append(row(f"tuned {yr} only", stats(run(df, cfg, w, best, a, b)), a, b))
    top = run(df, cfg, w, best, *test)
    out["test_by_dir"] = {k: row(k, stats(g), *test) for k, g in top.groupby("direction")}
    out["test_by_grade"] = {k: row(k, stats(g), *test) for k, g in top.groupby("grade")}
    out["top10_train_grid"] = [(round(e, 3), p, n) for e, p, n in scored[:5]]
    stamp = pd.Timestamp.now().strftime("%Y%m%d-%H%M%S")
    d = ROOT / "backtest" / "results" / f"layers-{stamp}"
    d.mkdir(parents=True, exist_ok=True)
    (d / "summary.json").write_text(json.dumps(out, indent=1, default=str))
    top.to_csv(d / "trades_test_tuned.csv", index=False)
    (ROOT / "config_layers.yaml").write_text("# tuned on train 2015-22 only\n" + yaml.safe_dump(best))
    print(json.dumps(out, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
