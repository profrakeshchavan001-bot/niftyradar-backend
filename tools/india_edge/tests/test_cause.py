import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cause as C  # noqa: E402

CFG = C.cause_config()


def row(**kw):
    base = dict(quadrant="neutral", price_chg_pct=0.5, oi_chg_pct=0.0, deliv_ratio=1.0, rs=0.0, sector_rs=0.0)
    base.update(kw)
    return base


class CauseRuleTests(unittest.TestCase):
    def test_short_covering(self):
        # 0.5 + 0.2*min(6/5,1) + 0.15*min(2/3,1) = 0.5 + 0.2 + 0.1 = 0.80
        r = C.classify_cause(row(quadrant="short_covering", price_chg_pct=2.0, oi_chg_pct=-6.0))
        self.assertEqual((r["label"], r["confidence"], r["level"]), ("short_covering", 0.8, "high"))
        self.assertIn("Short covering", r["reason"])
        self.assertNotIn("\n", r["reason"])

    def test_long_buildup_with_delivery_bonus(self):
        # 0.5 + 0.2*(4/5) + 0.15*(1.5/3) + 0.1 = 0.5 + 0.16 + 0.075 + 0.1 = 0.835; delivery 2.0x: 0.4+0.3*(0.5/1.5)=0.5
        r = C.classify_cause(row(quadrant="long_buildup", price_chg_pct=1.5, oi_chg_pct=4.0, deliv_ratio=2.0))
        self.assertEqual(r["label"], "long_buildup")
        self.assertAlmostEqual(r["confidence"], 0.835, delta=0.006)
        self.assertIn("delivery_spike", r["tags"])

    def test_fresh_shorts_and_long_unwinding(self):
        a = C.classify_cause(row(quadrant="short_buildup", price_chg_pct=-2.0, oi_chg_pct=5.0))
        b = C.classify_cause(row(quadrant="long_unwinding", price_chg_pct=-2.0, oi_chg_pct=-5.0))
        self.assertEqual((a["label"], b["label"]), ("fresh_shorts", "long_unwinding"))
        self.assertIn("fresh shorts", a["reason"])

    def test_delivery_spike_quiet_price(self):
        # neutral quadrant; 0.4 + 0.3*min((2.25-1.5)/1.5,1) = 0.55; +0.2 because |price| < 1% -> 0.75
        r = C.classify_cause(row(deliv_ratio=2.25, price_chg_pct=0.4))
        self.assertEqual((r["label"], r["confidence"]), ("delivery_spike", 0.75))
        self.assertIn("little price change", r["reason"])

    def test_volume_spike_without_news(self):
        bar = dict(open=100, close=101, prev_close=100, volume=3000, vol_avg20=1000)
        # ratio 3 -> 0.4 + 0.3*min((3-2)/2,1) = 0.55
        r = C.classify_cause(row(), bar, {"event_near": False})
        self.assertEqual((r["label"], r["confidence"]), ("volume_spike_no_news", 0.55))
        self.assertIn("news not checked", r["reason"])
        # a scheduled event explains the volume -> rule does not fire
        self.assertEqual(C.classify_cause(row(), bar, {"event_near": True})["label"], "unclear")
        # unknown calendar -> still reported but 0.1 weaker
        self.assertEqual(C.classify_cause(row(), bar, {"event_near": None})["confidence"], 0.45)
        # volume below the spike multiple -> no rule
        self.assertEqual(C.classify_cause(row(), dict(bar, volume=1500), {"event_near": False})["label"], "unclear")

    def test_gap_and_fade(self):
        # gap +3%; close gives back (103-101)/(103-100) = 0.6667 -> strength 0.5 + 0.4*0.6667 = 0.7667
        bar = dict(open=103, close=101, prev_close=100, volume=1000, vol_avg20=1000)
        r = C.classify_cause(row(), bar, {"event_near": False})
        self.assertEqual((r["label"], r["confidence"]), ("gap_and_fade", 0.77))
        self.assertIn("67%", r["reason"])
        # gap held (close stays above) -> no fade
        self.assertEqual(C.classify_cause(row(), dict(bar, close=103), {"event_near": False})["label"], "unclear")
        # gap below the minimum size
        self.assertEqual(C.classify_cause(row(), dict(bar, open=100.9, close=100.1))["label"], "unclear")
        # gap down that recovers
        down = dict(open=97, close=99, prev_close=100, volume=1000, vol_avg20=1000)
        self.assertEqual(C.classify_cause(row(), down)["label"], "gap_and_fade")

    def test_driver_sector_vs_stock(self):
        self.assertEqual(C.driver_of(row(rs=5, sector_rs=4), CFG)[0], "sector")    # 4 >= 2 and 4 >= 0.6*5
        self.assertEqual(C.driver_of(row(rs=8, sector_rs=1), CFG)[0], "stock")      # 8 - 1 = 7 >= 3
        self.assertEqual(C.driver_of(row(rs=4, sector_rs=-3), CFG)[0], "stock")     # opposite sign: 4 + 3 >= 3
        self.assertEqual(C.driver_of(row(rs=5, sector_rs=2.5), CFG)[0], "mixed")    # 2.5 < 0.6*5, 5-2.5 < 3
        self.assertEqual(C.driver_of(row(rs=float("nan")), CFG)[0], "unknown")
        r = C.classify_cause(row(quadrant="long_buildup", price_chg_pct=2, oi_chg_pct=5, rs=5, sector_rs=4))
        self.assertEqual(r["driver"], "sector")
        self.assertIn("sector-driven", r["reason"])

    def test_tie_lowers_confidence_and_keeps_tag(self):
        # long_unwinding: 0.5 + 0.2 + 0.15*min(3/3,1) = 0.85 ; delivery 3.0x: 0.4+0.3 = 0.7 (+0 not quiet) -> gap 0.15
        r = C.classify_cause(row(quadrant="long_unwinding", price_chg_pct=-3.0, oi_chg_pct=-5.0, deliv_ratio=3.0))
        self.assertEqual((r["label"], r["confidence"]), ("long_unwinding", 0.85))
        # force a tie: neutral quadrant not eligible; delivery 0.75 vs gap 0.75?  use quadrant 0.8 vs delivery 0.75
        tie = C.classify_cause(row(quadrant="short_covering", price_chg_pct=2.0, oi_chg_pct=-6.0,
                                   deliv_ratio=2.25), None)
        # quadrant 0.80, delivery 0.4+0.15 = 0.55 (price not <1%): difference 0.25 -> no penalty
        self.assertEqual(tie["confidence"], 0.8)
        close = C.classify_cause(row(quadrant="short_covering", price_chg_pct=2.0, oi_chg_pct=-6.0),
                                 dict(open=103, close=101, prev_close=100, volume=1000, vol_avg20=1000),
                                 {"event_near": False})
        # quadrant 0.80 vs gap_and_fade 0.7667: within 0.05 -> confidence 0.80 - 0.10 = 0.70
        self.assertEqual((close["label"], close["confidence"]), ("short_covering", 0.7))
        self.assertIn("gap_and_fade", close["tags"])

    def test_missing_inputs_do_not_crash(self):
        r = C.classify_cause({}, None, None)
        self.assertEqual((r["label"], r["confidence"]), ("unclear", 0.0))
        r = C.classify_cause(row(quadrant="long_buildup", price_chg_pct=float("nan"), oi_chg_pct=3.0))
        self.assertEqual(r["label"], "unclear")


class HelperTests(unittest.TestCase):
    def test_event_near_three_states(self):
        ev = pd.DataFrame({"date": pd.to_datetime(["2026-10-07"]), "symbol": ["TCS"], "kind": ["earnings"]})
        self.assertTrue(C.event_near(ev, "TCS", "2026-10-06"))
        self.assertFalse(C.event_near(ev, "TCS", "2026-10-09"))
        self.assertFalse(C.event_near(ev, "INFY", "2026-10-07"))
        self.assertIsNone(C.event_near(pd.DataFrame(), "TCS", "2026-10-07"))
        self.assertIsNone(C.event_near(None, "TCS", "2026-10-07"))

    def test_bar_context_uses_prior_20_only(self):
        d = pd.bdate_range("2026-09-01", periods=25)
        cash = pd.DataFrame({"date": d, "symbol": "X", "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.0,
                             "prev_close": 100.0, "volume": [1000.0] * 24 + [5000.0]})
        b = C.bar_context(cash, "X", d[-1])
        self.assertEqual(b["vol_avg20"], 1000.0)          # today's 5000 is excluded from its own baseline
        self.assertIsNone(C.bar_context(cash, "X", d[-1] + pd.Timedelta(days=3)))
        self.assertIsNone(C.bar_context(cash, "NOPE", d[-1]))


def flat_frame(n=100, **over):
    d = pd.bdate_range("2026-01-05", periods=n)
    f = pd.DataFrame({"date": d, "symbol": "X", "open": 100.0, "high": 100.2, "low": 99.8, "close": 100.0,
                      "prev_close": 100.0, "volume": 1000.0})
    return f


class ProfileTests(unittest.TestCase):
    def test_gap_fill_rate(self):
        f = flat_frame(100)
        p = 100.0
        gaps = {10: True, 20: True, 30: True, 40: False, 50: False, 60: False}   # True = filled same day
        for i in range(len(f)):
            f.loc[i, "prev_close"] = p
            if i in gaps:
                o = p * 1.02
                f.loc[i, ["open", "close", "high"]] = [o, o, o * 1.002]
                f.loc[i, "low"] = p * 0.999 if gaps[i] else o * 0.998
                p = o
            else:
                f.loc[i, ["open", "close", "high", "low"]] = [p, p, p * 1.002, p * 0.998]
        r = C.stock_profile(f, "X", f["date"].iloc[-1])
        self.assertEqual(r["gap_fill"]["n"], 6)
        self.assertAlmostEqual(r["gap_fill"]["rate"], 0.5)          # 3 of 6
        self.assertAlmostEqual(r["gap_fill"]["up_rate"], 0.5)
        self.assertIsNone(r["gap_fill"]["down_rate"])
        self.assertIn("50% of gaps fill", r["summary"])

    def test_post_spike_drift(self):
        f = flat_frame(100)
        spikes = [20, 35, 50, 65, 80]
        c = 100.0
        for i in range(len(f)):
            prev = c
            if i in spikes:
                c = prev * 1.01
                f.loc[i, "volume"] = 3000.0
            elif any(s < i <= s + 5 for s in spikes):
                c = prev * 1.005
            f.loc[i, ["prev_close", "open", "close", "high", "low"]] = [prev, prev, c, max(prev, c), min(prev, c)]
        r = C.stock_profile(f, "X", f["date"].iloc[-1])["post_spike"]
        self.assertEqual(r["n"], 5)
        self.assertAlmostEqual(r["avg_drift_pct"], (1.005 ** 5 - 1) * 100, places=6)   # 2.5251
        self.assertAlmostEqual(r["continuation_rate"], 1.0)

    def test_spike_without_full_window_is_ignored(self):
        f = flat_frame(100)
        f.loc[97, "volume"] = 9000.0            # only 2 sessions after it: no complete 5-day window
        self.assertIsNone(C.stock_profile(f, "X", f["date"].iloc[-1])["post_spike"])

    def test_expiry_week_ratio(self):
        f = flat_frame(120)
        exp = pd.to_datetime(["2026-02-26", "2026-03-26", "2026-04-30", "2026-05-28"])
        fo = pd.DataFrame({"symbol": "X", "expiry": [e.strftime("%Y-%m-%d") for e in exp]})
        dd = f["date"].to_numpy()
        e = exp.to_numpy()
        pos = np.searchsorted(e, dd)
        nxt = e[np.minimum(pos, len(e) - 1)]
        days_to = np.where(pos < len(e), (nxt - dd) / np.timedelta64(1, "D"), np.nan)
        in_week = (days_to >= 0) & (days_to <= 4)
        c, signed = 100.0, []
        for i in range(len(f)):
            prev = c
            if i > 0:
                mag = 0.02 if in_week[i] else 0.01
                r = mag if i % 2 == 0 else -mag
                c = prev * (1 + r)
                if in_week[i]:
                    signed.append(r)
            f.loc[i, ["prev_close", "open", "close", "high", "low"]] = [prev, prev, c, max(prev, c), min(prev, c)]
        out = C.stock_profile(f, "X", f["date"].iloc[-1], fo)["expiry_week"]
        self.assertEqual(out["n"], len(signed))
        self.assertGreaterEqual(out["n"], 10)
        self.assertAlmostEqual(out["avg_abs_move_pct"], 2.0, places=6)
        self.assertAlmostEqual(out["other_abs_move_pct"], 1.0, places=6)
        self.assertAlmostEqual(out["ratio"], 2.0, places=6)
        self.assertAlmostEqual(out["avg_move_pct"], np.mean(signed) * 100, places=6)

    def test_short_history_and_no_lookahead(self):
        f = flat_frame(30)
        self.assertEqual(C.stock_profile(f, "X", f["date"].iloc[-1])["summary"], "insufficient history")
        g = flat_frame(100)
        a = C.stock_profile(g, "X", g["date"].iloc[59])
        g2 = g.copy()
        g2.loc[60:, "close"] = 1.0
        b = C.stock_profile(g2, "X", g2["date"].iloc[59])
        self.assertEqual(a, b)                      # rows after asof never matter


if __name__ == "__main__":
    unittest.main()
