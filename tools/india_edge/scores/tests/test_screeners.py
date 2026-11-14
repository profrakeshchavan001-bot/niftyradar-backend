import json
import unittest

import numpy as np
import pandas as pd

from helpers import mk, fixture_panels
from scores import build, engine, screeners, sensitivity

CFG = engine.load_cfg()


def world(n_stocks=40, n=400, seed=4, drift=0.0006):
    rng = np.random.default_rng(seed)
    P = mk({f"S{i}": 100 * np.exp(np.cumsum(rng.normal(drift, 0.013, n))) for i in range(n_stocks)},
           nifty=20000 * np.exp(np.cumsum(rng.normal(0.0003, 0.007, n))), sectors={f"S{i}": f"X{i % 5}" for i in range(n_stocks)})
    return P, engine.compute(P, CFG)


class Hysteresis(unittest.TestCase):
    def test_hand_example(self):
        pct = pd.DataFrame({"A": [0.90, 0.84, 0.80, 0.70, 0.90]})
        got = screeners.hysteresis(pct >= 0.85, pct >= 0.75)["A"].tolist()
        # day0 .90 enters; day1 .84 < enter but >= stay and was on -> stays; day2 .80 stays; day3 .70 < stay -> off; day4 .90 re-enters
        self.assertEqual(got, [True, True, True, False, True])
        self.assertEqual((pct >= 0.85)["A"].tolist(), [True, False, False, False, True])   # single threshold flickers off on day 1

    def test_stay_alone_never_enters(self):
        pct = pd.DataFrame({"A": [0.80, 0.80, 0.90]})
        self.assertEqual(screeners.hysteresis(pct >= 0.85, pct >= 0.75)["A"].tolist(), [False, False, True])

    def test_cut_the_future(self):
        rng = np.random.default_rng(0)
        pct = pd.DataFrame(rng.random((200, 6)))
        full = screeners.hysteresis(pct >= 0.8, pct >= 0.6)
        part = screeners.hysteresis((pct >= 0.8).iloc[:120], (pct >= 0.6).iloc[:120])
        pd.testing.assert_frame_equal(full.iloc[:120], part)

    def test_hysteresis_cuts_churn_on_real_shaped_data(self):
        P, R = world()
        base = screeners.masks(P, R)[0]["strong_trend"]
        T = {k: dict(v) for k, v in CFG["screeners"].items()}
        T["strong_trend"]["exit"] = T["strong_trend"]["enter"]
        T["strong_trend"]["overall"] = CFG["screeners"]["strong_trend"]["overall"]
        flat = screeners.masks(P, R, T)[0]["strong_trend"]
        churn = lambda m: int((m != m.shift(1)).iloc[1:].to_numpy().sum())   # noqa: E731
        self.assertLess(churn(base), churn(flat) * 0.9)


class Stability(unittest.TestCase):
    def test_small_threshold_changes_do_not_flip_results_wildly(self):
        P, R = world(60, 500, seed=9)
        out = sensitivity.screener_sensitivity(P, R, CFG, days=300)["screeners"]
        for k, v in out.items():
            for f, x in v.items():
                self.assertLess(x["flip_share"], 0.12, (k, f))                 # < 12% of stock-days change membership
                if x["avg_count_base"] >= 3:
                    self.assertLess(abs(x["count_ratio"] - 1), 0.6, (k, f))    # +-20% knob -> list size moves < 60% (old absolute rules moved 9 -> 22 or 1)

    def test_scaling_is_monotone_for_rank_rules(self):
        P, R = world()
        c = lambda f: screeners.masks(P, R, screeners._scaled(CFG["screeners"], f))[0]["rs_leaders"].iloc[-200:].sum(axis=1).mean()  # noqa: E731
        self.assertLessEqual(c(0.6), c(1.0))
        self.assertLessEqual(c(1.0), c(1.4))

    def test_list_size_follows_the_percentile_not_the_market_regime(self):
        # strongly rising vs strongly falling market: absolute-score rules would give very different list sizes;
        # percentile rules keep the "top 15%" list about the same size
        _, Ru = world(drift=0.003, seed=1)
        Pu = world(drift=0.003, seed=1)[0]
        Pd, Rd = world(drift=-0.003, seed=1)
        nu = screeners.masks(Pu, Ru)[0]["rs_leaders"].iloc[-150:].sum(axis=1).mean()
        nd = screeners.masks(Pd, Rd)[0]["rs_leaders"].iloc[-150:].sum(axis=1).mean()
        self.assertLess(abs(nu - nd), 0.5 * max(nu, nd) + 2)


class Rules(unittest.TestCase):
    def test_volume_breakout_event_hand(self):
        n = 120
        a = np.r_[np.full(n - 1, 100.0), 105.0]
        vol = {s: np.full(n, 1e6) for s in "ABCDEFGHIJ"}
        vol["A"] = np.r_[np.full(n - 1, 1e6), 3e6]                        # A: 3.0x usual, highest volume ratio
        P = mk({s: (a if s == "A" else np.full(n, 100.0)) for s in "ABCDEFGHIJ"}, volume=vol)
        R = engine.compute(P, CFG)
        rows = {s["id"]: s for s in screeners.run(P, R, P.dates[-1])}
        self.assertEqual([r["symbol"] for r in rows["volume_breakout"]["rows"]], ["A"])
        self.assertIn("3.0x usual volume", rows["volume_breakout"]["rows"][0]["why"])

    def test_pullback_needs_uptrend_and_weak_5d_return(self):
        P, R = world(40, 400, seed=2)
        m = screeners.masks(P, R)[0]["pullback_uptrend"]
        I = R.extra["ind"]
        hit = m.stack()[lambda s: s]
        for d, s in list(hit.index)[:50]:
            self.assertGreater(P.close.at[d, s], I["ma"][50].at[d, s])        # never listed below its 50-day average
            self.assertLessEqual(I["ret"][5].at[d, s], I["ret"][5].loc[d].quantile(0.30))

    def test_only_scored_stocks_can_be_listed(self):
        P, R = world()
        ok = R.status == "ok"
        for k, m in screeners.masks(P, R)[0].items():
            self.assertFalse((m & ~ok).to_numpy().any(), k)

    def test_eight_screeners_one_line_reason_no_advice(self):
        out, _ = build.build(fixture_panels())
        scs = out["screeners"]["screeners"]
        self.assertEqual(len(scs), 8)
        for sc in scs:
            self.assertIn("%", sc["rule"]) if sc["id"] != "near_52w_high" else self.assertIn("52-week", sc["rule"])
            for r in sc["rows"]:
                self.assertTrue(10 < len(r["why"]) < 140 and "\n" not in r["why"])
        blob = json.dumps(out).lower()
        for bad in ("buy", "sell", "avoid", "target", "stop loss", "guarantee", "profit", "recommend"):
            self.assertNotIn(bad, blob.replace("not investment advice", ""), bad)

    def test_weakest_wording_kept(self):
        out, _ = build.build(fixture_panels())
        self.assertIn("Weakest scores", [s["title"] for s in out["screeners"]["screeners"]])


class CutTheFuture(unittest.TestCase):
    def test_screener_lists_unchanged_when_future_deleted(self):
        P, R = world(30, 360, seed=5)
        day = P.dates[-60]
        full = screeners.run(P, R, day)
        import copy
        keep = P.dates <= day
        Q = copy.copy(P)
        for a in ("close", "open", "high", "low", "volume", "deliv"):
            setattr(Q, a, getattr(P, a)[keep])
        Q.nifty, Q.dates = P.nifty[keep], P.dates[keep]
        part = screeners.run(Q, engine.compute(Q, CFG), day)
        self.assertEqual(full, part)


class Heatmap(unittest.TestCase):
    def test_shape_and_monotone_count(self):
        P, R = world(40, 400)
        h = sensitivity.heatmap(P, R, CFG, days=250, enters=(0.10, 0.20), exits_extra=(0.0, 0.10))
        self.assertEqual((len(h["cells"]), len(h["cells"][0])), (2, 2))
        # wider enter band -> larger list; wider exit band -> list at least as large
        self.assertLess(h["cells"][0][0]["avg_count"], h["cells"][1][0]["avg_count"])
        self.assertLessEqual(h["cells"][0][0]["avg_count"], h["cells"][0][1]["avg_count"])
        self.assertLessEqual(h["cells"][0][1]["turnover"], h["cells"][0][0]["turnover"] + 1e-9)   # hysteresis cannot raise turnover


if __name__ == "__main__":
    unittest.main()
