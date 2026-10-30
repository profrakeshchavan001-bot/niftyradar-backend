"""Validation report: one markdown table per screener (+ the plain top-scores portfolio).

Rules (fixed before any result was seen): nothing is tuned (thresholds/weights are untuned defaults),
train 2015-2022 / test 2023-now reported side by side and test never used to choose anything, costs
doubled, one-day execution delay, point-in-time F&O universe, delistings exit at last price,
walk-forward by year (every year is out of sample), block bootstrap CIs, Holm/BH multiple-testing across
all screeners, random-selection null, Monte Carlo drawdown. Never claims an edge.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from scores import engine, portfolio, screeners, stats

CAVEATS = [
    "Fixed rules, no tuning: thresholds and weights are untuned defaults, so there is no train-fit step; test years were never used to choose anything.",
    "Costs are doubled on purpose (config `costs`). Rates are the analyst's recollection of current NSE/SEBI/exchange charges: check before relying on any number.",
    "Universe is point-in-time F&O membership from the bhavcopy; a stock that stops trading exits at its last traded price (merger terms are not modelled).",
    "Fundamentals are a snapshot (not point-in-time) and are excluded here.",
    "Lot sizes are not in the parsed bhavcopy: capacity is measured by traded value only.",
]


def _seg(sim: dict, mask: np.ndarray, cfg: dict, tag: str) -> dict:
    h, st = sim["h"], cfg["stats"]
    r = sim["ret"][mask]
    b = sim["bench"][mask]
    ok = ~np.isnan(b)
    ex = (r - b)[ok]
    u = sim["universe"][mask]
    bs = stats.bootstrap(ex, st["bootstrap_reps"], st["block"], st["seed"], h)
    eq = sim["equity"][:-1][mask]
    drag = None
    if mask.any():
        cp = sim["cost_period"][mask]
        drag = float(np.nanmean(cp / eq) * stats.ann_factor(h) * 100)
    return {"segment": tag, "periods": int(mask.sum()), "cagr_pct": _p(stats.cagr(r, h)), "sharpe": _r(stats.sharpe(r, h)),
            "max_dd_pct": _p(stats.max_drawdown(r)), "nifty_cagr_pct": _p(stats.cagr(b[ok], h)),
            "excess_per_period_pct": None if bs["mean"] is None else round(bs["mean"] * 100, 3),
            "excess_ci_pct": None if bs["ci"] is None else [round(x * 100, 3) for x in bs["ci"]],
            "p_excess_gt0": None if bs["p_mean_gt0"] is None else round(bs["p_mean_gt0"], 4),
            "vs_universe_per_period_pct": _mean_pct((r - u)[~np.isnan(r - u)]),
            "turnover_pct": None if not mask.any() else round(float(np.nanmean(sim["turnover"][mask])) * 100, 1),
            "cost_drag_pct_per_year": None if drag is None else round(drag, 2),
            "avg_positions": None if not mask.any() else round(float(np.mean(sim["positions"][mask])), 1), "_excess": ex}


def _mean_pct(a):
    return None if len(a) == 0 else round(float(np.mean(a)) * 100, 3)


def _p(x):
    return None if x is None else round(x * 100, 2)


def _r(x):
    return None if x is None else round(x, 2)


def evaluate(P, R, name: str, cand, rank, cfg: dict) -> dict:
    sim = portfolio.simulate(P, R, cand, rank, cfg)
    dates = sim["dates"]
    v = cfg["validate"]
    tr = (dates <= pd.Timestamp(v["train_end"]))
    te = (dates >= pd.Timestamp(v["test_start"]))
    out = {"name": name, "train": _seg(sim, tr, cfg, "Train 2015-2022"), "test": _seg(sim, te, cfg, "Test 2023-now"),
           "all": _seg(sim, np.ones(len(dates), bool), cfg, "All"),
           "by_year": [_seg(sim, dates.year == y, cfg, str(y)) for y in sorted(set(dates.year))],
           "mc_drawdown_test": stats.mc_drawdown(sim["ret"][te], cfg["stats"]["mc_paths"], cfg["stats"]["block"], cfg["stats"]["seed"]),
           "capacity_inr_median": None if not sim["capacity_inr"] else int(np.median(sim["capacity_inr"])),
           "avg_hold_days": None if not len(sim["hold_days"]) else round(float(np.mean(sim["hold_days"])), 1)}
    out["_sim"] = sim
    return out


def random_null(P, R, cfg: dict, runs: int) -> dict:
    """Mean excess vs Nifty per period (test window) of random-selection portfolios: what luck looks like."""
    rng = np.random.default_rng(cfg["stats"]["seed"] + 1)
    cand = R.status == "ok"
    te = None
    means = []
    for _ in range(runs):
        rank = pd.DataFrame(rng.random(cand.shape), index=cand.index, columns=cand.columns)
        sim = portfolio.simulate(P, R, cand, rank, cfg)
        if te is None:
            te = sim["dates"] >= pd.Timestamp(cfg["validate"]["test_start"])
        ex = (sim["ret"] - sim["bench"])[te]
        ex = ex[~np.isnan(ex)]
        if len(ex):
            means.append(float(ex.mean()))
    m = np.array(means)
    return {"runs": len(m), "mean_excess_per_period_pct": None if not len(m) else round(float(m.mean()) * 100, 3),
            "p95_pct": None if not len(m) else round(float(np.percentile(m, 95)) * 100, 3), "_means": m}


def run(P, R, cfg: dict | None = None) -> dict:
    cfg = cfg or engine.load_cfg()
    members, order, meta = screeners.masks(P, R, cfg["screeners"])
    ok = R.status == "ok"
    strategies = {k: (members[k], order[k], meta[k][0]) for k in members}
    strategies["overall_top"] = (ok, R.scores["overall"], "Top overall scores (10 highest)")
    res = {k: evaluate(P, R, t, c, o, cfg) for k, (c, o, t) in strategies.items()}
    null = random_null(P, R, cfg, cfg["stats"]["random_null_runs"])
    for k, r in res.items():
        ex = r["test"]["_excess"]
        r["test"]["pct_of_random_below"] = None if not len(null["_means"]) or not len(ex) else round(float((null["_means"] < ex.mean()).mean()) * 100, 1)
    pv_test = {k: r["test"]["p_excess_gt0"] for k, r in res.items()}
    mt = stats.multiple_testing(pv_test, cfg["stats"]["alpha"])
    out = {"source": getattr(P, "source", "unknown"), "horizon_days": cfg["portfolio"]["hold_days"], "positions": cfg["portfolio"]["n_positions"],
           "capital_inr": cfg["portfolio"]["capital"], "cost_multiplier": cfg["costs"]["multiplier"], "caveats": CAVEATS,
           "multiple_testing_test_period": mt, "random_null": {k: v for k, v in null.items() if k != "_means"},
           "strategies": {k: _clean(r) for k, r in res.items()}}
    out["verdict"] = verdict(out)
    return out


def _clean(r: dict) -> dict:
    r = dict(r)
    r.pop("_sim", None)
    for k in ("train", "test", "all"):
        r[k] = {a: b for a, b in r[k].items() if a != "_excess"}
    r["by_year"] = [{a: b for a, b in y.items() if a != "_excess"} for y in r["by_year"]]
    return r


def verdict(out: dict) -> str:
    if out["source"] == "fixtures":
        return "Fixture data only: planted trends make every number here meaningless as evidence. Re-run on real data."
    mt = out["multiple_testing_test_period"]
    if mt["pass_holm"]:
        return ("Some rules beat the Nifty in the test period even after correcting for the number of rules tested: "
                + ", ".join(mt["pass_holm"]) + ". Treat as leads to re-check, not proof.")
    return "No edge found: after correcting for the number of rules tested, none beat the Nifty in the test period with doubled costs."


# ------------------------------------------------------------------ markdown
def _f(x, suf="", d=2):
    return "-" if x is None else (f"{x:.{d}f}{suf}" if isinstance(x, float) else f"{x}{suf}")


def to_markdown(out: dict) -> str:
    L = ["# Validation report", "", f"Source: **{out['source']}**. {out['positions']} positions, rebalance every {out['horizon_days']} sessions, "
         f"capital Rs {out['capital_inr']:,} (paper), costs x{out['cost_multiplier']:g}.", "", f"**Verdict:** {out['verdict']}", ""]
    if out["source"] == "fixtures":
        L += ["> FIXTURE DATA: synthetic prices with planted trends. Nothing below is evidence.", ""]
    mt = out["multiple_testing_test_period"]
    L += ["## Multiple testing (test period)", "",
          f"{mt['tests']} rules tested. About {mt['expected_false_positives']} would pass at {mt['alpha']:.0%} by chance. "
          f"Raw passes: {', '.join(mt['pass_raw']) or 'none'}. After Holm: {', '.join(mt['pass_holm']) or 'none'}. After Benjamini-Hochberg: {', '.join(mt['pass_bh']) or 'none'}.", "",
          f"Random-selection portfolios ({out['random_null']['runs']} runs): mean excess {_f(out['random_null']['mean_excess_per_period_pct'], '%', 3)} per period, "
          f"95th percentile {_f(out['random_null']['p95_pct'], '%', 3)}.", "",
          "## Summary (test period 2023-now)", "",
          "| Rule | CAGR % | Nifty CAGR % | Sharpe | Max DD % | Excess/period % | p | Beats random % | Holm |", "|---|---|---|---|---|---|---|---|---|"]
    for k, r in out["strategies"].items():
        t = r["test"]
        L.append(f"| {r['name']} | {_f(t['cagr_pct'])} | {_f(t['nifty_cagr_pct'])} | {_f(t['sharpe'])} | {_f(t['max_dd_pct'])} | {_f(t['excess_per_period_pct'], d=3)} | "
                 f"{_f(t['p_excess_gt0'], d=3)} | {_f(t.get('pct_of_random_below'), d=0)} | {'pass' if k in mt['pass_holm'] else 'no'} |")
    for k, r in out["strategies"].items():
        L += ["", f"## {r['name']}", "",
              "| Period | Periods | CAGR % | Nifty % | Sharpe | Max DD % | Excess/period % | 95% CI | p | vs universe % | Turnover % | Cost drag %/yr | Avg positions |",
              "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for s in [r["train"], r["test"], r["all"]] + r["by_year"]:
            ci = "-" if s["excess_ci_pct"] is None else f"{s['excess_ci_pct'][0]:.2f} to {s['excess_ci_pct'][1]:.2f}"
            L.append(f"| {s['segment']} | {s['periods']} | {_f(s['cagr_pct'])} | {_f(s['nifty_cagr_pct'])} | {_f(s['sharpe'])} | {_f(s['max_dd_pct'])} | "
                     f"{_f(s['excess_per_period_pct'], d=3)} | {ci} | {_f(s['p_excess_gt0'], d=3)} | {_f(s['vs_universe_per_period_pct'], d=3)} | "
                     f"{_f(s['turnover_pct'], d=0)} | {_f(s['cost_drag_pct_per_year'])} | {_f(s['avg_positions'], d=1)} |")
        mc = r["mc_drawdown_test"]
        L += ["", (f"Monte Carlo drawdown (test, {mc['paths']} resampled paths): median {mc['median_pct']}%, worst 5% of paths {mc['p95_worst_pct']}%, "
                   f"chance of more than 20% {mc['prob_dd_over_20pct']:.0%}, more than 30% {mc['prob_dd_over_30pct']:.0%}." if mc.get("paths") else "Monte Carlo drawdown: too few periods."),
              f"Capacity at the {5}% of daily value limit: about Rs {r['capacity_inr_median']:,}." if r["capacity_inr_median"] else "Capacity: not measured (no fills).",
              f"Average holding: {_f(r['avg_hold_days'], ' days', 0)}."]
    L += ["", "## Caveats", ""] + [f"- {c}" for c in out["caveats"]]
    return "\n".join(L) + "\n"
