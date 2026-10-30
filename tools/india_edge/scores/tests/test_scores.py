import json
import sys
import time
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scores import edge_stats, engine, feargreed, rotation, screeners  # noqa: E402
from scores.build_public import build  # noqa: E402
from scores.make_fixtures import BASERATES, make  # noqa: E402

CASH, IDX = make()
FIXT = ROOT / "scores" / "fixtures" / "baserates.json"


def prep(cash=CASH, idx=IDX):
    p = engine.panel(cash, idx)
    return p, engine.features(p)


class ScoreTests(unittest.TestCase):
    def test_range_and_keys(self):
        p, f = prep()
        s = engine.score_day(p, f, p["close"].index[-1])
        self.assertEqual(len(s), 24)
        for k in (*engine.KEYS, "overall"):
            self.assertTrue(s[k].between(0, 100).all(), k)

    def test_trend_hand_computed(self):
        # 70 days rising by 1/day from 100: close 169 > ma20 (159.5) > ma50 (144.5),
        # ma50 now > ma50 10 days ago, no 200d yet -> fallback c>ma50. All 5 conditions -> 100.
        d = pd.bdate_range(end="2026-10-28", periods=70)
        cash = pd.DataFrame({"date": d, "symbol": "AAA", "sector": "X", "close": np.arange(100.0, 170.0),
                             "volume": 1e6, "deliv_pct": 50.0})
        idx = pd.DataFrame({"date": d, "nifty": 20000.0, "vix": 15.0})
        p, f = prep(cash, idx)
        raw = f["ma"][20]["AAA"].iloc[-1], f["ma"][50]["AAA"].iloc[-1]
        self.assertEqual(raw, (159.5, 144.5))
        conds = [169 > 159.5, 169 > 144.5, 159.5 > 144.5, 169 > 144.5,
                 144.5 > f["ma50_prev"]["AAA"].iloc[-1]]
        self.assertTrue(all(conds))
        s = engine.score_day(p, f, d[-1])
        self.assertEqual(s.loc["AAA", "trend"], 100)

    def test_overall_is_weighted_mean(self):
        p, f = prep()
        cfg = engine.load_cfg()
        s = engine.score_day(p, f, p["close"].index[-1], cfg)
        self.assertAlmostEqual(sum(cfg["weights"].values()), 1.0)
        self.assertLessEqual(abs(s["overall"] - sum(s[k] * cfg["weights"][k] for k in engine.KEYS)).max(), 1.5)

    def test_bands(self):
        self.assertEqual([engine.band(x) for x in (85, 70, 69, 40, 39, 0)],
                         ["Strong", "Strong", "Mixed", "Mixed", "Weak", "Weak"])


class LeakTests(unittest.TestCase):
    """Score for day t must not change when every later day is deleted or altered."""

    def test_no_lookahead_truncate(self):
        p, f = prep()
        day = p["close"].index[-40]
        full = engine.score_day(p, f, day)
        cut = CASH[pd.to_datetime(CASH["date"]) <= day]
        p2, f2 = prep(cut, IDX[pd.to_datetime(IDX["date"]) <= day])
        pd.testing.assert_frame_equal(full.sort_index(), engine.score_day(p2, f2, day).sort_index())

    def test_no_lookahead_future_shock(self):
        p, f = prep()
        day = p["close"].index[-40]
        base = engine.score_day(p, f, day)
        shock = CASH.copy()
        m = pd.to_datetime(shock["date"]) > day
        shock.loc[m, ["close", "volume", "deliv_pct"]] *= 7
        idx2 = IDX.copy()
        idx2.loc[pd.to_datetime(idx2["date"]) > day, ["nifty", "vix"]] *= 3
        p2, f2 = prep(shock, idx2)
        pd.testing.assert_frame_equal(base.sort_index(), engine.score_day(p2, f2, day).sort_index())
        fg1, fg2 = feargreed.meter(p, f, day), feargreed.meter(p2, f2, day)
        self.assertEqual(fg1, fg2)
        self.assertEqual(rotation.board(p, f, day), rotation.board(p2, f2, day))

    def test_deterministic(self):
        a, b = build(CASH, IDX, FIXT), build(CASH, IDX, FIXT)
        self.assertEqual(a, b)


class PublicSafetyTests(unittest.TestCase):
    def test_no_formula_or_weight_in_public_json(self):
        res = build(CASH, IDX, FIXT)
        text = json.dumps(res).lower()
        for bad in ("weight", "formula", "ma20", "ma50", "rolling", "percentile", "0.25", "components"):
            self.assertNotIn(bad, text.replace("50-day average", "").replace("50-day", ""), bad)
        self.assertEqual(set(res["scores"]["stocks"][0]["trend"]), {"score", "band", "says"})

    def test_no_advice_words(self):
        text = json.dumps(build(CASH, IDX, FIXT)).lower()
        for bad in ("buy", "sell", "guarantee", "profit", "target price", "recommend"):
            # 'not a recommendation' is a disclaimer, allowed
            self.assertNotIn(bad, text.replace("not a recommendation", "").replace("not investment advice", ""), bad)


class ScreenerTests(unittest.TestCase):
    def test_eight_screeners_each_row_has_reason(self):
        res = build(CASH, IDX, FIXT)["screeners"]["screeners"]
        self.assertEqual(len(res), 8)
        for sc in res:
            self.assertTrue(sc["rule"])
            for r in sc["rows"]:
                self.assertGreater(len(r["why"]), 10)

    def test_volume_surge_rule_hand(self):
        d = pd.bdate_range(end="2026-10-28", periods=80)
        vol = np.full(80, 1e6)
        vol[-5:] = 2e6          # 5d mean 2e6 / prior-20d mean 1e6 = 2.0 >= 1.8
        cash = pd.DataFrame({"date": d, "symbol": "AAA", "sector": "X", "close": 100.0,
                             "volume": vol, "deliv_pct": 50.0})
        cash2 = cash.assign(symbol="BBB", volume=1e6)
        c = pd.concat([cash, cash2])
        p, f = prep(c, pd.DataFrame({"date": d, "nifty": 20000.0, "vix": 15.0}))
        sc = engine.score_day(p, f, d[-1])
        rows = {s["id"]: s for s in screeners.run(p, f, sc, d[-1])}
        self.assertEqual([r["symbol"] for r in rows["volume_surge"]["rows"]], ["AAA"])


class RotationFearGreedTests(unittest.TestCase):
    def test_stage_mapping(self):
        self.assertEqual(rotation.STAGES[(True, True)], "Leading")
        self.assertEqual(rotation.STAGES[(False, True)], "Improving")

    def test_board_covers_all_sectors(self):
        p, f = prep()
        b = rotation.board(p, f, p["close"].index[-1])
        self.assertEqual(len(b), 6)

    def test_fear_greed_range_labels(self):
        p, f = prep()
        m = feargreed.meter(p, f, p["close"].index[-1])
        self.assertTrue(0 <= m["value"] <= 100)
        self.assertEqual(len(m["parts"]), 5)
        self.assertEqual([feargreed.label(x) for x in (0, 25, 45, 55, 75, 100)],
                         ["Extreme fear", "Fear", "Neutral", "Greed", "Extreme greed", "Extreme greed"])


class EdgeStatsTests(unittest.TestCase):
    def test_no_edge_honest(self):
        d = json.loads(json.dumps(BASERATES))
        for s in d["setups"]:
            s["survived"] = False
        tmp = ROOT / "out" / "_t.json"
        tmp.parent.mkdir(exist_ok=True)
        tmp.write_text(json.dumps(d))
        r = edge_stats.load(tmp)
        tmp.unlink()
        self.assertEqual(r["status"], "no_edge")
        self.assertIn("No edge found", r["message"])

    def test_edge_and_missing_file(self):
        self.assertEqual(edge_stats.load(FIXT)["status"], "edge")
        self.assertEqual(edge_stats.load(ROOT / "nope.json")["status"], "no_data")


class SpeedTests(unittest.TestCase):
    def test_full_build_fast(self):
        t = time.time()
        build(CASH, IDX, FIXT)
        self.assertLess(time.time() - t, 5.0)


if __name__ == "__main__":
    unittest.main()
