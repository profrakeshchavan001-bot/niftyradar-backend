"""Study 3 (real settle prices, costs 2x): 2-TRADING-day Nifty strangle on the real expiry calendar, multiple-testing
correction (Holm, Benjamini-Hochberg on bootstrap p-values), random-entry timing null, stress days, bootstrap interval
for the BANKNIFTY condor. Nothing here selects or tunes a rule.
    python backtest/options_real_study3.py        # needs backtest/options_real_study2.json + results/ from earlier runs
"""
from __future__ import annotations

import json
import math
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import options_real as R  # noqa: E402
import options_real_study2 as S  # noqa: E402
from common import DATA_DIR  # noqa: E402

S.MODES["weekly2t"] = {"weekly": True, "entry_tdays": 2, "exit_dte": -1, "unstable_dte": -1}
N_SENSITIVITY_CELLS = 12 + 16 + 9 + 15      # Study 1 train-only grids (calendar, condor, condor_dte, strangle_d18)
NULL_DRAWS = 15
BOOT_B, BOOT_BLOCK = 5000, 5
EVENTS = ["2016-06-24", "2016-11-09", "2020-03-12", "2020-03-13", "2020-03-16", "2020-03-23", "2024-06-04"]
SURV = {"NIFTY 2-trading-day strangle d18": ("NIFTY", "weekly2t", "strangle_d18"),
        "BANKNIFTY monthly condor": ("BANKNIFTY", "monthly", "condor")}
NOSTOP = {"strangle_d18": {"sl": 10 ** 9}, "condor": {"sl_mult": 10 ** 6}}
TIGHT = {"strangle_d18": {"sl": 8000}, "condor": {"sl_mult": 0.5}}


# ------------------------------------------------------------------ statistics (unit tested)
def block_boot_means(x, B, L, rng):
    x = np.asarray(x, float)
    n = len(x)
    nb = math.ceil(n / L)
    starts = rng.integers(0, n, (B, nb))
    idx = (starts[:, :, None] + np.arange(L)) % n
    return x[idx].reshape(B, -1)[:, :n].mean(1)


def boot_pvalue(x, B=BOOT_B, L=BOOT_BLOCK, seed=0):
    """One-sided p for H0: mean per-trade net <= 0, centred block bootstrap over trades ordered by entry."""
    x = np.asarray(x, float)
    if len(x) < 2:
        return 1.0
    obs = x.mean()
    bm = block_boot_means(x - obs, B, min(L, len(x)), np.random.default_rng(seed))
    return float((1 + (bm >= obs).sum()) / (B + 1))


def holm(p):
    p = np.asarray(p, float)
    m = len(p)
    order = np.argsort(p)
    adj = np.minimum(1.0, np.maximum.accumulate((m - np.arange(m)) * p[order]))
    out = np.empty(m)
    out[order] = adj
    return out


def benjamini_hochberg(p):
    p = np.asarray(p, float)
    m = len(p)
    order = np.argsort(p)
    adj = np.minimum.accumulate((p[order] * m / (np.arange(m) + 1))[::-1])[::-1]
    out = np.empty(m)
    out[order] = np.minimum(1.0, adj)
    return out


def correct(pvals: dict, n_untested: int, alpha=0.05) -> dict:
    """pvals: {name: raw p}. Padding with n_untested hypotheses of p = 1 only raises the multiplicity (they were looked at
    on train data but their trades were not kept)."""
    names = list(pvals)
    p = np.array([pvals[k] for k in names] + [1.0] * n_untested)
    h, b = holm(p)[:len(names)], benjamini_hochberg(p)[:len(names)]
    return {k: {"p_raw": round(pvals[k], 4), "p_holm": round(float(h[i]), 4), "q_bh": round(float(b[i]), 4),
                "holm_pass": bool(h[i] < alpha), "bh_pass": bool(b[i] < alpha)} for i, k in enumerate(names)}


def total_ci(net, years, B=10000, seed=1):
    """Bootstrap interval for total P&L: i.i.d. over trades, and resampling whole entry years."""
    net, years = np.asarray(net, float), np.asarray(years)
    rng = np.random.default_rng(seed)
    n = len(net)
    iid = net[rng.integers(0, n, (B, n))].sum(1)
    ys = np.unique(years)
    by = {y: net[years == y] for y in ys}
    blk = np.array([np.concatenate([by[y] for y in rng.choice(ys, len(ys))]).sum() for _ in range(B)])
    f = lambda a: {"lo": round(float(np.percentile(a, 2.5))), "hi": round(float(np.percentile(a, 97.5))),  # noqa: E731
                   "p_total_le_0": round(float((a <= 0).mean()), 4)}
    return {"n": int(n), "total": round(float(net.sum())), "iid": f(iid), "year_block": f(blk)}


def _vals(c: pd.DataFrame):
    return c.net.values, c.entry.dt.year.values


def worst_days(eq: pd.Series, spot: pd.Series, k=10) -> list:
    d = eq.diff().dropna()
    ret = spot.pct_change()
    return [{"date": str(i.date()), "pnl_per_lot": round(float(v)), "index_move_pct": round(float(ret.get(i, np.nan)) * 100, 2)}
            for i, v in d.nsmallest(k).items()]


def random_picks(expiries, sessions, lo, hi, rng, first=None):
    """One uniformly drawn fill session per expiry with lo <= calendar days to expiry <= hi."""
    sessions = pd.DatetimeIndex(sessions)
    out = {}
    for e in expiries:
        el = sessions[(sessions < e) & ((e - sessions).days >= lo) & ((e - sessions).days <= hi)]
        if first is not None:
            el = el[el >= first]
        if len(el):
            out[e] = pd.Timestamp(el[rng.integers(len(el))])
    return out


# ------------------------------------------------------------------ engine jobs
def _job(a):
    tag, symbol, name, params = a
    R.configure(symbol, 2.0)
    days = R.trading_days()
    if params.get("_null_seed") is not None:
        seed, lo, hi, kind = params["_null_seed"], params["_lo"], params["_hi"], params["_kind"]
        exps = _expiries(symbol)
        exps = R.monthly_expiries(exps) if kind == "monthly" else exps
        params = {**{k: v for k, v in params.items() if not k.startswith("_")},
                  "entry_pick": random_picks(exps, days, lo, hi, np.random.default_rng(seed))}
    trades, eq, _ = R.run(name, days, params)
    tr = pd.DataFrame(trades)
    for c in ("entry", "exit", "expiry"):
        if c in tr:
            tr[c] = pd.to_datetime(tr[c])
    return tag, tr, R.evaluate(trades, eq), eq


def _expiries(symbol):
    f = DATA_DIR / ("idxopt_banknifty.parquet" if symbol == "BANKNIFTY" else "idxopt_nifty.parquet")
    return sorted(pd.to_datetime(pd.read_parquet(f, columns=["expiry"]).expiry.unique()))


def change_date():
    """First Tuesday expiry of the Nifty weekly series (after 2025-01-01): the expiry-day change."""
    e = [x for x in _expiries("NIFTY") if x >= pd.Timestamp("2025-01-01") and x.weekday() == 1]
    return e[0]


def seg(tr: pd.DataFrame) -> dict:
    if tr.empty:
        return {"trades": 0}
    c = tr.sort_values("exit").net.cumsum()
    return {"trades": int(len(tr)), "total_inr": round(float(tr.net.sum())), "avg_inr": round(float(tr.net.mean())),
            "win_pct": round(float((tr.net > 0).mean() * 100), 1), "worst_trade": round(float(tr.net.min())),
            "max_dd_inr": round(float((c.cummax() - c).max())), "positive_years": int((tr.groupby(tr.entry.dt.year).net.sum() > 0).sum()),
            "years": int(tr.entry.dt.year.nunique())}


def main():
    cd = change_date()
    jobs = [(f"w2t|{k}", "NIFTY", "strangle_d18", p) for k, p in S.param_sets("strangle_d18", "weekly2t").items()]
    for label, (sym, mode, name) in SURV.items():
        base = S.param_sets(name, mode)["base"]
        for kind, extra in (("base", {}), ("nostop", NOSTOP[name]), ("tight", TIGHT[name])):
            if mode == "weekly2t" and kind == "base":
                continue  # identical to the w2t|base job
            jobs.append((f"stress|{label}|{kind}", sym, name, {**base, **extra}))
        lo, hi, k = (1, 7, "weekly") if mode == "weekly2t" else (25, 60, "monthly")
        nb = {kk: v for kk, v in base.items() if kk not in ("entry_tdays",)}
        for sd in range(NULL_DRAWS):
            jobs.append((f"null|{label}|{sd}", sym, name, {**nb, "weekly": mode == "weekly2t", "_null_seed": 100 + sd,
                                                           "_lo": lo, "_hi": hi, "_kind": k}))
    with ProcessPoolExecutor(4) as ex:
        res = {t: (tr, ev, eq) for t, tr, ev, eq in ex.map(_job, jobs, chunksize=1)}
    out = {"generated": str(pd.Timestamp.now().date()), "cost_multiplier": 2.0, "expiry_change_first_tuesday": str(cd.date())}

    # 1) 2-trading-day Nifty strangle, before / after the expiry-day change
    w2t = {}
    for k in S.param_sets("strangle_d18", "weekly2t"):
        tr, ev, _ = res[f"w2t|{k}"]
        pre = tr[(tr.expiry < cd)]
        w2t[k] = {"all": seg(tr), "monthly_only_2015_18": seg(tr[tr.entry < "2019-01-01"]),
                  "weekly_thursday_2019_to_change": seg(pre[pre.entry >= "2019-01-01"]),
                  "after_tuesday_change": seg(tr[tr.expiry >= cd]), "verdict": ev["verdict"], **S.passes(ev, tr),
                  "years": S.year_table(tr)}
    out["weekly_2_trading_days"] = w2t

    # 2) multiple testing over every full-period configuration whose trades were kept
    trades = {}
    sp = pd.read_parquet(HERE / "results" / "options_real_study2_trades.parquet")
    for (sym, mode, name, st), g in sp.groupby(["symbol", "mode", "strategy", "set"]):
        trades[f"{sym}/{mode}/{name}/{st}"] = g
    n1 = pd.read_csv(HERE / "results" / "options_real_trades.csv", parse_dates=["entry", "exit"])
    for name, g in n1.groupby("strategy"):
        trades[f"NIFTY/monthly/{name}/base"] = g
    b1 = pd.read_csv(HERE / "results" / "options_real_banknifty_x2_trades.csv", parse_dates=["entry", "exit"])
    trades["BANKNIFTY/monthly/calendar/base"] = b1[b1.strategy == "calendar"]
    for k in S.param_sets("strangle_d18", "weekly2t"):
        trades[f"NIFTY/weekly2t/strangle_d18/{k}"] = res[f"w2t|{k}"][0]
    s2 = json.loads((HERE / "options_real_study2.json").read_text(encoding="utf-8"))
    passing = {f"{f.replace('/', '/', 1)}/{k}" for f, x in s2["families"].items() for k, v in x["sets"].items() if v["passes"]}
    passing |= {f"NIFTY/weekly2t/strangle_d18/{k}" for k in w2t if w2t[k]["passes"]}
    pv, pv_oos = {}, {}
    for k, g in trades.items():
        g = g.sort_values("entry")
        pv[k] = boot_pvalue(g.net.values)
        late = g[g.entry >= S.OOS_SPLIT]
        pv_oos[k] = boot_pvalue(late.net.values) if len(late) >= 10 else None
    corr = correct(pv, N_SENSITIVITY_CELLS)
    corr_small = correct(pv, 0)
    surv = sorted(passing & set(pv))
    out["multiple_testing"] = {
        "n_tests_with_trades": len(pv), "n_untested_sensitivity_cells_p1": N_SENSITIVITY_CELLS,
        "m_total": len(pv) + N_SENSITIVITY_CELLS, "bootstrap": f"centred block bootstrap, block {BOOT_BLOCK} trades, B={BOOT_B}",
        "survivors": {k: {**corr[k], "p_holm_m61": corr_small[k]["p_holm"], "q_bh_m61": corr_small[k]["q_bh"],
                          "p_raw_2022_plus": pv_oos[k]} for k in surv},
        "n_survivors": len(surv), "survivors_pass_holm": sum(corr[k]["holm_pass"] for k in surv),
        "survivors_pass_bh": sum(corr[k]["bh_pass"] for k in surv),
        "survivors_p_raw_lt_005": sum(corr[k]["p_raw"] < 0.05 for k in surv),
        "all_pass_holm": [k for k in pv if corr[k]["holm_pass"]], "all_pass_bh": [k for k in pv if corr[k]["bh_pass"]]}

    # 3) random-entry timing null
    nulls = {}
    for label, (sym, mode, name) in SURV.items():
        tot = [float(res[f"null|{label}|{sd}"][1]["train"].get("total_inr", 0) + res[f"null|{label}|{sd}"][1]["test"].get("total_inr", 0))
               for sd in range(NULL_DRAWS)]
        actual = float(res[f"w2t|base"][0].net.sum()) if mode == "weekly2t" else float(res[f"stress|{label}|base"][0].net.sum())
        nt = [len(res[f"null|{label}|{sd}"][0]) for sd in range(NULL_DRAWS)]
        nulls[label] = {"draws": NULL_DRAWS, "actual_total_inr": round(actual), "null_mean": round(float(np.mean(tot))),
                        "null_min": round(min(tot)), "null_max": round(max(tot)), "null_trades_mean": round(float(np.mean(nt)), 1),
                        "draws_ge_actual": int(sum(t >= actual for t in tot)),
                        "what_it_tests": "same structure and exits, fill day drawn at random per expiry within "
                                         + ("1-7 calendar days to expiry" if mode == "weekly2t" else "25-60 days to expiry")}
    out["random_entry_null"] = nulls

    # 4) stress days
    stress = {}
    for label, (sym, mode, name) in SURV.items():
        R.configure(sym, 2.0)
        spot = R.spot_table().close
        per = {}
        for kind in ("base", "nostop", "tight"):
            key = "w2t|base" if (mode == "weekly2t" and kind == "base") else f"stress|{label}|{kind}"
            tr, ev, eq = res[key]
            d = eq.diff()
            per[kind] = {"total_inr": round(float(tr.net.sum())), "max_dd_inr": round(float(R.oy.max_dd(eq))),
                         "worst_trade_inr": round(float(tr.net.min())), "worst_day_inr": round(float(d.min())),
                         "trades_over_1_1x_sl": ev.get("trades_over_1_1x_sl"), "worst_10_days": worst_days(eq, spot),
                         "events": {e: (round(float(d.get(pd.Timestamp(e))))
                                        if pd.Timestamp(e) in d.index and d.get(pd.Timestamp(e)) == d.get(pd.Timestamp(e)) else None)
                                    for e in EVENTS}}
        stress[label] = per
    out["stress"] = stress

    # 5) condor interval
    c = res[f"stress|BANKNIFTY monthly condor|base"][0]
    c = c.sort_values("entry")
    out["condor_ci"] = {"all_2015_26": total_ci(c.net.values, c.entry.dt.year.values),
                        "2022_26": total_ci(c[c.entry >= S.OOS_SPLIT].net.values, c[c.entry >= S.OOS_SPLIT].entry.dt.year.values),
                        "without_best_5_trades": total_ci(*_vals(c.drop(c.net.nlargest(5).index)))}
    allt = [t.assign(tag=k) for k, (t, _, _) in res.items() if k.startswith(("w2t", "stress")) and len(t)]
    pd.concat(allt).to_parquet(HERE / "results" / "options_real_study3_trades.parquet", index=False)
    (HERE / "options_real_study3.json").write_text(json.dumps(out, indent=1, default=str), encoding="utf-8")
    print(json.dumps({k: out[k] for k in ("multiple_testing",)}, default=str)[:1500])


if __name__ == "__main__":
    main()
