import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import timing as T  # noqa: E402
import vetoes as V  # noqa: E402

CFG = T.exec_config()
BASE = 5000.0


def bars(rel, start="2026-10-05 09:15", vol=1000, mirror=False):
    rows = []
    for o, h, l, c in rel:
        if mirror:  # reflect around BASE: a long setup becomes the equivalent short setup
            o, h, l, c = -o, -l, -h, -c
        rows.append((BASE + o, BASE + h, BASE + l, BASE + c))
    ts = pd.Timestamp(start) + pd.to_timedelta(np.arange(len(rows)) * 15, unit="m")
    a = np.array(rows)
    return pd.DataFrame({"ts": ts, "open": a[:, 0], "high": a[:, 1], "low": a[:, 2], "close": a[:, 3],
                         "volume": float(vol)})


# b2 is a displacement bar (body 16 >= range proxy 11.5, closes above prior highs) -> OB = b1 [2, 10]
# b3 pulls back into the zone (low 8 <= 10); b4 closes above the pullback high (BOS) and engulfs b3.
LONG = [(0, 10, -5, 5), (5, 10, 2, 4), (4, 21, 3, 20), (20, 20, 8, 10), (10, 26, 9, 25)]


class WindowTests(unittest.TestCase):
    def test_boundaries(self):
        f = T.in_trade_window
        self.assertFalse(f("2026-10-05 09:15"))
        self.assertTrue(f("2026-10-05 09:30"))
        self.assertTrue(f("2026-10-05 10:45"))
        self.assertFalse(f("2026-10-05 11:00"))
        self.assertFalse(f("2026-10-05 12:00"))
        self.assertTrue(f("2026-10-05 13:30"))
        self.assertTrue(f("2026-10-05 14:45"))
        self.assertFalse(f("2026-10-05 15:00"))


class PrimitiveTests(unittest.TestCase):
    def test_fvg_bullish_and_bearish(self):
        b = bars([(0, 10, -5, 5), (5, 30, 4, 28), (28, 40, 15, 38)])
        z = T.find_fvgs(b, "long")
        self.assertEqual([(q["low"], q["high"], q["formed"]) for q in z], [(BASE + 10, BASE + 15, 2)])
        zs = T.find_fvgs(bars([(0, 10, -5, 5), (5, 30, 4, 28), (28, 40, 15, 38)], mirror=True), "short")
        self.assertEqual([(q["low"], q["high"]) for q in zs], [(BASE - 15, BASE - 10)])
        self.assertEqual(T.find_fvgs(b, "short"), [])

    def test_fvg_min_gap_filters_small_gaps(self):
        b = bars([(0, 10, -5, 5), (5, 30, 4, 28), (28, 40, 15, 38)])
        self.assertEqual(T.find_fvgs(b, "long", min_gap=6.0), [])  # gap is 5

    def test_order_block(self):
        z = T.find_order_blocks(bars(LONG[:4]), "long")
        self.assertEqual([(q["low"], q["high"], q["formed"]) for q in z], [(BASE + 2, BASE + 10, 2)])
        self.assertEqual(T.find_order_blocks(bars(LONG[:4]), "short"), [])

    def test_engulfing(self):
        b = bars(LONG)
        self.assertTrue(T.is_engulfing(b, 4, "long"))
        self.assertFalse(T.is_engulfing(b, 3, "long"))
        self.assertTrue(T.is_engulfing(bars(LONG, mirror=True), 4, "short"))

    def test_bos(self):
        b = bars(LONG)
        self.assertTrue(T.is_bos(b, 4, 3, "long"))     # 25 > max(21, 20)
        self.assertFalse(T.is_bos(b, 3, 3, "long"))

    def test_orb_and_vwap(self):
        b = bars(LONG)
        self.assertEqual(T.orb_side(b), "long")        # close 25 > opening-bar high 10
        self.assertEqual(T.orb_side(bars(LONG, mirror=True)), "short")
        self.assertEqual(T.orb_side(bars([(0, 10, -5, 5), (5, 8, 0, 3)])), "none")
        # equal volumes: vwap = mean of typical prices = (3.33+5.33+14.67+12.67+20)/5 = 11.2
        self.assertAlmostEqual(T.vwap(b) - BASE, 11.2, places=6)
        self.assertEqual(T.vwap_side(b), "long")
        self.assertEqual(T.vwap_side(bars(LONG, mirror=True)), "short")


class AnalyseTests(unittest.TestCase):
    def test_go_long_levels(self):
        r = T.analyse(bars(LONG), "long", CFG, next_open=BASE + 25)
        self.assertEqual(r["state"], "go")
        self.assertEqual(r["trigger"], "bos")
        # range proxy = mean(15, 8, 18, 12, 17) = 14 -> buffer 1.4; stop = zone low 5002 - 1.4
        self.assertAlmostEqual(r["stop"], BASE + 2 - 1.4)
        risk = (BASE + 25) - (BASE + 0.6)
        self.assertAlmostEqual(r["target"], BASE + 25 + 2 * risk)
        self.assertEqual(pd.Timestamp(r["entry_ts"]).strftime("%H:%M"), "10:30")

    def test_go_short_mirror(self):
        r = T.analyse(bars(LONG, mirror=True), "short", CFG, next_open=BASE - 25)
        self.assertEqual(r["state"], "go")
        self.assertAlmostEqual(r["stop"], BASE - 2 + 1.4)
        self.assertLess(r["target"], r["entry"])

    def test_ready_before_trigger_and_zone_before_pullback(self):
        self.assertEqual(T.analyse(bars(LONG[:4]), "long", CFG)["state"], "ready")
        no_touch = LONG[:3] + [(20, 24, 18, 22)]
        self.assertEqual(T.analyse(bars(no_touch), "long", CFG)["state"], "zone")
        self.assertEqual(T.analyse(bars(LONG[:2] + [(4, 8, 2, 6)] * 2), "long", CFG)["state"], "none")

    def test_outside_window_blocks_go(self):
        r = T.analyse(bars(LONG, start="2026-10-05 11:15"), "long", CFG, next_open=BASE + 25)
        self.assertNotEqual(r["state"], "go")
        self.assertTrue(any("outside trade windows" in x for x in r["reasons"]))
        afternoon = T.analyse(bars(LONG, start="2026-10-05 13:30"), "long", CFG, next_open=BASE + 25)
        self.assertEqual(afternoon["state"], "go")      # entry 14:45 is inside the second window

    def test_wide_stop_rejected(self):
        cfg = {**CFG, "timing": {**CFG["timing"], "max_risk_pct": 0.1}}
        r = T.analyse(bars(LONG), "long", cfg, next_open=BASE + 25)
        self.assertNotEqual(r["state"], "go")
        self.assertTrue(any("max_risk_pct" in x for x in r["reasons"]))

    def test_engulfing_only_trigger(self):
        cfg = {**CFG, "timing": {**CFG["timing"], "triggers": ["engulfing"]}}
        self.assertEqual(T.analyse(bars(LONG), "long", cfg, next_open=BASE + 25)["trigger"], "engulfing")

    def test_no_future_peeking(self):
        full = bars(LONG)
        garbage = pd.concat([full, bars([(25, 400, -400, -300)], start="2026-10-05 10:30")], ignore_index=True)
        a = T.analyse(full, "long", CFG, next_open=BASE + 25)
        b = T.analyse(garbage.iloc[:5], "long", CFG, next_open=BASE + 25)
        self.assertEqual((a["state"], a["stop"], a["target"]), (b["state"], b["stop"], b["target"]))

    def test_wrong_side_does_nothing(self):
        self.assertEqual(T.analyse(bars(LONG), "short", CFG)["state"], "none")
        self.assertEqual(T.analyse(bars(LONG), "none", CFG)["state"], "none")


V_CFG = V.veto_config()


class VetoTests(unittest.TestCase):
    def test_efficiency_ratio_and_chop(self):
        self.assertAlmostEqual(V.efficiency_ratio([100, 101, 102, 103, 104], 4), 1.0)
        self.assertAlmostEqual(V.efficiency_ratio([100, 102, 100, 102, 100], 4), 0.0)
        # net 2, path 2+2+1+1 = 6 -> 0.3333
        self.assertAlmostEqual(V.efficiency_ratio([100, 102, 100, 101, 102], 4), 2 / 6)
        v = {**V_CFG, "chop_lookback": 4}
        self.assertTrue(V.chop_veto([100, 102, 100, 102, 100], v)[0])
        self.assertFalse(V.chop_veto([100, 101, 102, 103, 104], v)[0])
        self.assertFalse(V.chop_veto([100, 101], v)[0])  # not enough history never vetoes

    def test_iv_percentile(self):
        s = list(range(1, 40)) + [20]
        self.assertAlmostEqual(V.iv_percentile(s), 100 * 19 / 39)  # values 1..19 are below 20
        self.assertEqual(V.iv_percentile(list(range(1, 41))), 100.0)
        self.assertTrue(np.isnan(V.iv_percentile([1, 2, 3])))

    def test_iv_veto_threshold_70(self):
        self.assertTrue(V.iv_veto(list(range(1, 41)), V_CFG)[0])          # percentile 100
        self.assertFalse(V.iv_veto(list(range(1, 40)) + [20], V_CFG)[0])   # 48.7
        s = list(range(1, 101))[:99] + [71]  # latest 71, 70 prior values below -> 70/99 = 70.7 > 70
        self.assertTrue(V.iv_veto(s, V_CFG)[0])
        self.assertFalse(V.iv_veto(None, V_CFG)[0])
        self.assertTrue(V.iv_veto(None, {**V_CFG, "veto_on_missing_iv": True})[0])

    def test_event_window(self):
        days = pd.bdate_range("2026-10-05", "2026-10-16")
        f = lambda ev: V.event_veto("2026-10-07", [ev], days, V_CFG)[0]  # noqa: E731
        self.assertTrue(f("2026-10-07"))   # same day
        self.assertTrue(f("2026-10-09"))   # 2nd trading day ahead (10-08, 10-09)
        self.assertFalse(f("2026-10-12"))  # 3rd trading day ahead
        self.assertFalse(f("2026-10-06"))  # already past

    def test_event_window_past_end_of_calendar(self):
        days = pd.bdate_range("2026-10-05", "2026-10-07")
        self.assertTrue(V.event_veto("2026-10-07", ["2026-10-09"], days, V_CFG)[0])

    def test_expiry(self):
        self.assertTrue(V.expiry_veto("2026-10-27", ["2026-10-27"])[0])
        self.assertFalse(V.expiry_veto("2026-10-26", ["2026-10-27"])[0])

    def test_expected_move_and_target(self):
        # 1000 * 0.25 * sqrt(1/252) = 250 * 0.0629941 = 15.7485
        mv = V.expected_move(1000, 0.25, 1)
        self.assertAlmostEqual(mv, 15.7485, places=3)
        self.assertTrue(V.target_veto(1000, 1020, mv)[0])
        self.assertFalse(V.target_veto(1000, 1010, mv)[0])
        self.assertTrue(V.target_veto(1000, 980, mv)[0])  # short targets too
        self.assertAlmostEqual(V.expected_move(1000, None, 4, daily_vol=0.02), 40.0)  # 1000*.02*sqrt(4)
        self.assertFalse(V.target_veto(1000, 1500, float("nan"))[0])

    def test_spread_strictly_above_two_percent(self):
        self.assertTrue(V.spread_veto(2.5, V_CFG)[0])
        self.assertFalse(V.spread_veto(2.0, V_CFG)[0])
        self.assertFalse(V.spread_veto(1.5, V_CFG)[0])
        self.assertFalse(V.spread_veto(None, V_CFG)[0])
        self.assertTrue(V.spread_veto(None, {**V_CFG, "veto_on_missing_quote": True})[0])

    def test_apply_vetoes_reports_every_check(self):
        ctx = dict(closes=list(range(100, 130)), iv_series=list(range(1, 41)), trade_date="2026-10-07",
                   event_dates=[], trading_days=pd.bdate_range("2026-10-05", "2026-10-16"),
                   expiries=["2026-10-27"], entry=1000, target=1010, spread_pct=1.0)
        r = V.apply_vetoes(ctx, V_CFG)
        names = [c[0] for c in r["checks"]]
        self.assertEqual(names, ["chop regime", "IV percentile", "event within 2 days", "expiry day",
                                 "target vs expected move", "option spread"])
        self.assertTrue(r["vetoed"])                      # IV percentile 100
        self.assertEqual([c[0] for c in r["checks"] if c[1]], ["IV percentile"])


if __name__ == "__main__":
    unittest.main()
