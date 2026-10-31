"""Extra queue for the real-data options study: parameter sensitivity (TRAIN data only), regime split, capital needed.

Sensitivity grids use only sessions up to 2022-12-31 so nothing here peeks at the 2023+ test period, and nothing is
selected from them: the rules in options_real.DEFAULTS stay frozen. The grids only show how fragile those rules are.
    python backtest/options_real_extra.py
"""
from __future__ import annotations

import itertools
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
from common import DATA_DIR  # noqa: E402

TRAIN_LAST = pd.Timestamp("2022-12-31")

GRIDS = {
    "condor": {"x": ("short_delta", [0.20, 0.25, 0.30, 0.35]),
               "y": ("wing_delta", [(0.08,), (0.12,), (0.16,), (0.20,)])},
    "condor_dte": {"name": "condor", "x": ("dte", [(30, 40), (40, 50), (50, 60)]),
                   "y": ("exit_dte", [10, 15, 21])},
    "strangle_d18": {"x": ("delta", [0.10, 0.14, 0.18, 0.22, 0.26]),
                     "y": ("dte", [(30, 35), (45, 50), (55, 60)])},
    "calendar": {"x": ("delta", [0.15, 0.20, 0.25, 0.30]),
                 "y": ("dte", [(7, 9), (10, 12), (13, 15)])},
}


def _params(gname, xv, yv):
    g = GRIDS[gname]
    p = {}
    for (key, _), v in ((g["x"], xv), (g["y"], yv)):
        if key == "dte":
            p["dte_lo"], p["dte_hi"] = v
        else:
            p[key] = v
    return p


def _cell(args):
    gname, xv, yv = args
    name = GRIDS[gname].get("name", gname)
    days = [d for d in R.trading_days() if d <= TRAIN_LAST]
    trades, eq, _ = R.run(name, days, _params(gname, xv, yv))
    tr = pd.DataFrame(trades)
    if tr.empty:
        return gname, str(xv), str(yv), 0, 0.0, 0.0, 0.0
    return (gname, str(xv), str(yv), len(tr), float(tr.net.sum()), float(tr.r.mean()), R.oy.max_dd(eq))


def sensitivity(workers=4):
    cells = [(g, xv, yv) for g, spec in GRIDS.items() for xv, yv in itertools.product(spec["x"][1], spec["y"][1])]
    with ProcessPoolExecutor(workers) as ex:
        rows = list(ex.map(_cell, cells))
    return pd.DataFrame(rows, columns=["grid", "x", "y", "trades", "train_net_inr", "avg_r", "max_dd_inr"])


def regimes(trades_csv: Path):
    tr = pd.read_csv(trades_csv, parse_dates=["entry", "exit"])
    vix = []
    for p in sorted((DATA_DIR / "idx").glob("*.parquet")):
        x = pd.read_parquet(p)
        x = x[x.index_name == "India VIX"]
        if len(x):
            vix.append((pd.Timestamp(p.stem), float(x.close.iloc[0])))
    vix = pd.Series(dict(vix)).sort_index()
    spot = R.spot_table().close
    trend = (spot / spot.shift(60) - 1).abs()
    out = {}
    cut = TRAIN_LAST + pd.Timedelta(days=1)
    vix_med = float(vix[vix.index <= TRAIN_LAST].median())
    trend_med = float(trend[trend.index <= TRAIN_LAST].median())
    tr["prev"] = tr.entry.map(lambda d: spot.index[spot.index.get_loc(d) - 1])
    tr["vix"] = tr.prev.map(lambda d: vix.asof(d))
    tr["trend"] = tr.prev.map(lambda d: trend.asof(d))
    tr["vix_regime"] = np.where(tr.vix >= vix_med, "high_vix", "low_vix")
    tr["trend_regime"] = np.where(tr.trend >= trend_med, "trending", "range")
    tr["period"] = np.where(tr.entry < cut, "train", "test")
    for name, g in tr.groupby("strategy"):
        out[name] = {}
        for col in ("vix_regime", "trend_regime"):
            for (reg, per), h in g.groupby([col, "period"]):
                out[name][f"{reg}/{per}"] = {"trades": int(len(h)), "total_inr": round(float(h.net.sum())),
                                             "win_pct": round(float((h.net > 0).mean() * 100), 1)}
    return {"thresholds_from_train": {"vix_median": round(vix_med, 2), "abs_60d_return_median": round(trend_med, 4)},
            "by_strategy": out}


def capital(res: dict):
    out = {}
    for name, ev in res["strategies"].items():
        m = ev.get("margin_est_inr", {})
        dd = max(ev["train"].get("max_dd_inr", 0), ev["test"].get("max_dd_inr", 0))
        worst = min(ev["train"].get("worst_inr", 0), ev["test"].get("worst_inr", 0))
        out[name] = {"margin_median_inr": m.get("median"), "margin_max_inr": m.get("max"),
                     "max_dd_inr_worst_period": dd, "worst_trade_inr": worst,
                     "capital_to_cover_margin_plus_dd": round((m.get("max") or 0) + dd)}
    return out


def heatmaps(df: pd.DataFrame, outdir: Path):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        return []
    outdir.mkdir(parents=True, exist_ok=True)
    paths = []
    for g, d in df.groupby("grid"):
        piv = d.pivot(index="y", columns="x", values="train_net_inr")
        fig, ax = plt.subplots(figsize=(5.2, 3.4))
        lim = max(abs(piv.values).max(), 1)
        im = ax.imshow(piv.values, cmap="RdYlGn", aspect="auto", vmin=-lim, vmax=lim)
        ax.set_xticks(range(piv.shape[1]), piv.columns, rotation=25)
        ax.set_yticks(range(piv.shape[0]), piv.index)
        for i in range(piv.shape[0]):
            for j in range(piv.shape[1]):
                ax.text(j, i, f"{piv.values[i, j] / 1000:.0f}k", ha="center", va="center", fontsize=8)
        ax.set_title(f"{g}: TRAIN net Rs per lot (2015-22)", fontsize=9)
        fig.colorbar(im, ax=ax, shrink=0.8)
        fig.tight_layout()
        p = outdir / f"heatmap_{g}.png"
        fig.savefig(p, dpi=110)
        plt.close(fig)
        paths.append(str(p))
    return paths


def main():
    res = json.loads((HERE / "results" / "options_real.json").read_text(encoding="utf-8"))
    extra = {"capital": capital(res), "regimes": regimes(HERE / "results" / "options_real_trades.csv")}
    sens = sensitivity()
    sens.to_csv(HERE / "results" / "options_real_sensitivity.csv", index=False)
    extra["sensitivity_rows"] = sens.to_dict("records")
    extra["heatmaps"] = heatmaps(sens, HERE.parents[2] / "docs" / "img")
    (HERE / "options_real_extra.json").write_text(json.dumps(extra, indent=1, default=str), encoding="utf-8")
    print(json.dumps({"capital": extra["capital"], "regimes": extra["regimes"]["thresholds_from_train"]}, indent=1))


if __name__ == "__main__":
    main()
