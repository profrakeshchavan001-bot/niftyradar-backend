"""More robustness cuts on the real-data options study (doubled costs, frozen rules, nothing selected for the verdict):
VIX buckets, monthly-expiry-week entries, a walk-forward with parameter RE-SELECTION (best of a small grid on the trailing
3 years of entries, traded the next calendar year), and a SPAN-like scenario check of the margin estimate.
    python backtest/options_real_more.py            # writes backtest/options_real_more.json
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
from common import DATA_DIR  # noqa: E402

SYMBOLS = ("NIFTY", "BANKNIFTY")
WF_GRIDS = {"strangle_d18": [{"delta": d} for d in (0.10, 0.14, 0.18, 0.22, 0.26)],
            "condor": [{"short_delta": d} for d in (0.20, 0.25, 0.30, 0.35)]}


def _trades(symbol, name, params=None):
    R.configure(symbol, 2.0)
    t, _, _ = R.run(name, R.trading_days(), params)
    df = pd.DataFrame(t)
    df["entry"] = pd.to_datetime(df.entry)
    return df


def _cell(a):
    symbol, name, i = a
    return symbol, name, i, _trades(symbol, name, WF_GRIDS[name][i])


def vix_series():
    out = {}
    for p in sorted((DATA_DIR / "idx").glob("*.parquet")):
        x = pd.read_parquet(p)
        x = x[x.index_name == "India VIX"]
        if len(x):
            out[pd.Timestamp(p.stem)] = float(x.close.iloc[0])
    return pd.Series(out).sort_index()


def summ(h):
    return {"trades": int(len(h)), "total_inr": round(float(h.net.sum())), "win_pct": round(float((h.net > 0).mean() * 100), 1)} if len(h) else {"trades": 0}


def splits(symbol, tr, vix):
    R.configure(symbol, 2.0)
    days = list(R.spot_table().index)
    prev = {d: days[i - 1] for i, d in enumerate(days) if i}
    tr = tr.copy()
    tr["vix"] = tr.entry.map(lambda d: vix.asof(prev.get(d, d)))
    edges = [vix[vix.index <= R.TRAIN_END].quantile(q) for q in (1 / 3, 2 / 3)]
    tr["vix_bucket"] = np.where(tr.vix < edges[0], "vix_low", np.where(tr.vix < edges[1], "vix_mid", "vix_high"))
    allx = pd.read_parquet(DATA_DIR / ("idxopt_banknifty.parquet" if symbol == "BANKNIFTY" else "idxopt_nifty.parquet"), columns=["expiry"])
    mon = set(R.monthly_expiries(pd.to_datetime(allx.expiry.unique())))
    me = np.array(sorted(mon), dtype="datetime64[ns]")

    def in_exp_week(d):
        i = np.searchsorted(me, np.datetime64(d))
        return i < len(me) and (pd.Timestamp(me[i]) - d).days <= 5
    tr["expiry_week"] = np.where(tr.entry.map(in_exp_week), "monthly_expiry_week", "other_weeks")
    out = {"vix_edges_train_terciles": [round(e, 2) for e in edges]}
    for name, g in tr.groupby("strategy"):
        out[name] = {k: summ(h) for col in ("vix_bucket", "expiry_week") for k, h in g.groupby(col)}
    return out


def walk_forward(symbol, cells):
    res = {}
    for name, grid in WF_GRIDS.items():
        dfs = [cells[(symbol, name, i)] for i in range(len(grid))]
        yrs, picked, total, pos = {}, {}, 0.0, 0
        for y in range(2018, 2027):
            lo, hi = pd.Timestamp(y - 3, 1, 1), pd.Timestamp(y, 1, 1)
            score = [float(d[(d.entry >= lo) & (d.entry < hi)].net.sum()) for d in dfs]
            b = int(np.argmax(score))
            net = float(dfs[b][dfs[b].entry.dt.year == y].net.sum())
            yrs[str(y)] = round(net)
            picked[str(y)] = grid[b]
            total += net
            pos += net > 0
        res[name] = {"years_net_inr": yrs, "picked": picked, "total_inr": round(total), "positive_years": int(pos),
                     "n_years": len(yrs)}
    return res


def span_check(symbol):
    """SPAN-like: worst loss of the two short strangle legs under spot -/+ 6% (vol +4 pts / -4 pts) and spot -/+3% (vol +-4 pts)."""
    R.configure(symbol, 2.0)
    tr = pd.read_csv(HERE / "results" / ("options_real_trades.csv" if symbol == "NIFTY" else "options_real_banknifty_x2_trades.csv"),
                     parse_dates=["entry"])
    tr = tr[tr.strategy == "strangle_d18"]
    days = list(R.spot_table().index)
    rows = []
    for _, t in tr.iterrows():
        i = days.index(t.entry)
        prev = R.Day(days[i - 1])
        E = next((e for e in R.monthly_expiries(prev.expiries) if 45 <= (e - prev.date).days <= 50), None)
        if E is None:
            continue
        tb = prev.table(E, prev.date)
        T = max((E - prev.date).days, 0.5) / 365.0
        S, worst = prev.S_close, 0.0
        legs = [R.pick_delta(tb, cp, 0.18, 0.09) for cp in "CP"]
        if any(l is None for l in legs):
            continue
        for mv, dv in ((-0.06, 0.04), (0.06, 0.04), (-0.03, 0.04), (0.03, 0.04), (-0.06, -0.04), (0.06, -0.04)):
            loss = 0.0
            for l in legs:
                v, _ = R._bs_vec(S * (1 + mv), float(l.strike), T, np.array(max(l.iv + dv, 0.05)), l.cp == "C")
                loss += (float(v) - float(l.settle)) * R.LOT
            worst = max(worst, loss)
        rows.append((worst + 0.02 * S * R.LOT, t.margin_est))
    a = np.array(rows)
    return {"n": len(a), "span_like_median_inr": round(float(np.median(a[:, 0]))), "model_est_median_inr": round(float(np.median(a[:, 1]))),
            "ratio_model_over_spanlike_median": round(float(np.median(a[:, 1] / a[:, 0])), 2),
            "pct_trades_model_below_spanlike": round(float((a[:, 1] < a[:, 0]).mean() * 100), 1)}


def main():
    vix = vix_series()
    tasks = [(s, n, i) for s in SYMBOLS for n, g in WF_GRIDS.items() for i in range(len(g))]
    with ProcessPoolExecutor(4) as ex:
        cells = {(s, n, i): df for s, n, i, df in ex.map(_cell, tasks)}
    out = {}
    for s in SYMBOLS:
        csv = HERE / "results" / ("options_real_trades.csv" if s == "NIFTY" else "options_real_banknifty_x2_trades.csv")
        tr = pd.read_csv(csv, parse_dates=["entry", "exit"])
        out[s] = {"splits": splits(s, tr, vix), "walk_forward_reselect": walk_forward(s, cells), "margin_check_strangle_d18": span_check(s)}
        print(s, json.dumps(out[s])[:600], flush=True)
    (HERE / "options_real_more.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")


if __name__ == "__main__":
    main()
