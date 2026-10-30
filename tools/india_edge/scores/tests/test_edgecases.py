"""Splits, bonuses, suspensions, new listings and delistings through the real loader path
(robust.sanitize_market -> data.from_market -> engine -> build)."""
import unittest

import numpy as np
import pandas as pd

from helpers import ROOT  # noqa: F401
from loader import Market
from robust import sanitize_market
from scores import build, data, engine

CFG = engine.load_cfg()
N = 320
DATES = pd.bdate_range(end="2026-10-28", periods=N)


def paths(seed=3, n_stocks=12):
    rng = np.random.default_rng(seed)
    return {f"S{i:02d}": 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.013, N))) for i in range(n_stocks)}


def market(p: dict, volume=None, splits=None, gaps=None, listed_from=None, delist_after=None) -> Market:
    """p: unadjusted-by-us economic price paths. splits: {sym: (day_index, factor)} -> raw prices drop by `factor` from that
    day (NSE gives the new prev_close already adjusted). gaps: {sym: (first_idx, last_idx)} no rows (suspension).
    listed_from: {sym: idx}; delist_after: {sym: idx}."""
    rows = []
    for s, path in p.items():
        vol = np.full(N, 1e6) if volume is None else volume[s]
        k, f = (splits or {}).get(s, (None, 1.0))
        raw = path.copy()
        rawvol = vol.copy()
        if k is not None:
            raw[k:] = raw[k:] * f
            rawvol[k:] = rawvol[k:] / f                            # same traded value after the split
        for i in range(N):
            if (gaps or {}).get(s) and gaps[s][0] <= i <= gaps[s][1]:
                continue
            if (listed_from or {}).get(s, 0) > i or ((delist_after or {}).get(s) is not None and i > delist_after[s]):
                continue
            prev = raw[i - 1] if i else raw[0]
            if k is not None and i == k:
                prev = path[i - 1] * f                              # NSE adjusts prev_close on the ex-date
            rows.append({"date": DATES[i], "symbol": s, "prev_close": prev, "open": prev, "high": raw[i] * 1.004, "low": raw[i] * 0.996,
                         "close": raw[i], "volume": rawvol[i], "deliv_qty": rawvol[i] * 0.5, "deliv_pct": 50.0})
    cash = pd.DataFrame(rows)
    fo = pd.DataFrame([{"date": d, "instr": "STF", "symbol": s, "oi": 1000.0, "volume": 10.0, "opt_type": "XX"}
                       for s in p for d in DATES])
    idx = pd.DataFrame({"date": DATES, "index_name": "Nifty 50", "close": 20000 * np.exp(np.cumsum(np.full(N, 0.0003)))})
    return sanitize_market(Market(cash, fo, idx, pd.DataFrame(), pd.DataFrame(), "test"), renames={})


def scores(m: Market):
    P = data.from_market(m, sectors={s: "X" for s in m.cash["symbol"].unique()})
    return P, engine.compute(P, CFG)


class SplitsAndBonuses(unittest.TestCase):
    def check_factor(self, f):
        base = paths()
        control = scores(market(base))
        split = scores(market(base, splits={"S00": (200, f)}))
        d = DATES[-1]
        for k in (*engine.NAMES, "overall"):
            if k in control[1].scores and k in split[1].scores:
                a, b = control[1].scores[k].loc[d, "S00"], split[1].scores[k].loc[d, "S00"]
                if not (np.isnan(a) and np.isnan(b)):
                    self.assertAlmostEqual(a, b, delta=0.6, msg=f"{k} factor {f}")      # an adjusted split must not change any score
        self.assertEqual(len(split[0].close["S00"].dropna()), N)

    def test_two_for_one_split(self):
        self.check_factor(0.5)

    def test_one_for_one_bonus(self):
        self.check_factor(0.5)                                      # a 1:1 bonus halves the price exactly like a 2:1 split

    def test_five_for_one_split(self):
        self.check_factor(0.2)

    def test_split_without_adjustment_would_look_like_a_crash_but_real_crash_is_not_adjusted(self):
        base = paths()
        crash = base["S00"].copy()
        crash[200:] *= 0.5                                          # a REAL 50 % one-day fall: prev_close is the true previous close
        m = market({**base, "S00": crash})
        n = m.health_notes
        self.assertEqual(n["corp_actions"], [])                      # not treated as a split
        self.assertTrue(any(j["symbol"] == "S00" for j in n["suspect_jumps"]))   # flagged for a human
        P, R = scores(m)
        self.assertLess(R.scores["trend"].loc[DATES[205], "S00"], 40)   # and the score reflects the fall


class Suspensions(unittest.TestCase):
    def setUp(self):
        self.base = paths()
        self.P, self.R = scores(market(self.base, gaps={"S01": (250, 261)}))

    def test_status_during_and_after_suspension(self):
        st = self.R.status["S01"]
        self.assertEqual(st.loc[DATES[255]], "suspended")
        self.assertTrue(np.isnan(self.R.scores["overall"].loc[DATES[255], "S01"]))
        self.assertEqual(st.loc[DATES[-1]], "ok")
        self.assertFalse(np.isnan(self.R.scores["overall"].loc[DATES[-1], "S01"]))

    def test_other_stocks_unaffected_by_the_gap(self):
        control = scores(market(self.base))[1]
        d = DATES[-1]
        # S01's own percentile ranks differ slightly, but stocks far from it keep their raw readings
        a = self.R.extra["ind"]["ret"][63].loc[d, "S05"]
        b = control.extra["ind"]["ret"][63].loc[d, "S05"]
        self.assertAlmostEqual(a, b, places=12)

    def test_build_still_works_on_a_suspended_day(self):
        out, _ = build.build(self.P, day=DATES[255])
        card = next(c for c in out["scores"]["stocks"] if c["symbol"] == "S01")
        self.assertEqual(card["status"], "suspended")
        self.assertIn("No trade print", card["note"])
        json_ok = __import__("json").dumps(out, allow_nan=False)
        self.assertTrue(json_ok)


class Listings(unittest.TestCase):
    def test_new_listing_becomes_scored_after_min_history(self):
        base = paths()
        P, R = scores(market(base, listed_from={"S02": 200}))
        st = R.status["S02"]
        self.assertEqual(st.loc[DATES[199]], "not_listed")
        self.assertEqual(st.loc[DATES[210]], "new_listing")
        # bars so far: day 258 -> 59 bars (< min_history 60) = new listing; day 259 -> 60 bars = scored
        self.assertEqual(st.loc[DATES[258]], "new_listing")
        self.assertEqual(st.loc[DATES[259]], "ok")
        self.assertEqual(st.loc[DATES[270]], "ok")
        self.assertTrue(np.isnan(R.scores["overall"].loc[DATES[210], "S02"]))
        self.assertFalse(np.isnan(R.scores["overall"].loc[DATES[-1], "S02"]))

    def test_new_listing_has_no_200_day_component_but_scores(self):
        base = paths()
        P, R = scores(market(base, listed_from={"S02": 200}))
        c200 = R.comps["trend"][2].score.loc[DATES[-1], "S02"]       # needs 200 bars; only ~120 exist
        self.assertTrue(np.isnan(c200))
        self.assertFalse(np.isnan(R.scores["trend"].loc[DATES[-1], "S02"]))     # renormalised over the other four trend readings

    def test_delisted_stock_stops_being_scored_and_stays_in_history(self):
        base = paths()
        P, R = scores(market(base, delist_after={"S03": 250}))
        self.assertEqual(R.status.loc[DATES[250], "S03"], "ok")
        self.assertEqual(R.status.loc[DATES[260], "S03"], "suspended")
        out, _ = build.build(P)
        self.assertNotIn("not_listed", [c["status"] for c in out["scores"]["stocks"] if c["symbol"] == "S03"])


class OtherOddities(unittest.TestCase):
    def test_all_stocks_one_sector_still_builds(self):
        P, R = scores(market(paths()))
        out, _ = build.build(P)
        self.assertEqual(len(out["rotation"]["sectors"]), 1)

    def test_zero_volume_day_streak_marks_illiquid_not_crash(self):
        vol = {s: np.full(N, 1e6) for s in paths()}
        vol["S04"] = np.r_[np.full(N - 4, 1e6), np.zeros(4)]
        P, R = scores(market(paths(), volume=vol))
        self.assertEqual(R.status.loc[DATES[-1], "S04"], "illiquid")
        out, _ = build.build(P)
        self.assertEqual(next(c for c in out["scores"]["stocks"] if c["symbol"] == "S04")["status"], "illiquid")


if __name__ == "__main__":
    unittest.main()
