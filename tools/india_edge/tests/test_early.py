import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import early as E  # noqa: E402
from loader import load_fixtures  # noqa: E402

CFG = E.early_config()


def frame(n=160, noise=True, seed=0):
    """Flat stock: close ~100, range 2, volume 1000, delivery 40, futures OI 1000, Nifty 1000."""
    rng = np.random.default_rng(seed)
    close = 100.0 + (rng.normal(0, 0.4, n) if noise else np.zeros(n))
    return pd.DataFrame({"date": pd.bdate_range("2026-01-05", periods=n), "open": close, "high": close + 1.0,
                         "low": close - 1.0, "close": close, "volume": 1000.0, "deliv_pct": 40.0,
                         "fut_oi": 1000.0, "nifty": 1000.0})


class DetectorTests(unittest.TestCase):
    def test_quiet_accumulation(self):
        h = frame(noise=False)
        h.loc[h.index[-5:], "deliv_pct"] = 48.0                    # 48 / 40 = 1.2 >= 1.15, price flat
        f = E.detect_flags(h)["quiet_accumulation"]
        self.assertTrue(f["active"])
        self.assertAlmostEqual(f["strength"], 0.5 + 0.5 * (1.2 - 1.15) / 0.35, places=3)   # 0.5714
        h2 = frame(noise=False)
        h2.loc[h2.index[-5:], "deliv_pct"] = 45.0                  # 1.125x: below the 1.15 threshold
        self.assertFalse(E.detect_flags(h2)["quiet_accumulation"]["active"])
        h3 = h.copy()
        h3.loc[h3.index[-3:], "close"] = [101, 102, 103.0]          # price moved 3% in 5 sessions: not quiet
        self.assertFalse(E.detect_flags(h3)["quiet_accumulation"]["active"])

    def test_oi_buildup_without_price_move(self):
        h = frame(noise=False)
        h.loc[h.index[-3:], "fut_oi"] = [1030.0, 1070.0, 1100.0]    # +10% over 3 sessions (>= 8)
        f = E.detect_flags(h)["oi_buildup_no_move"]
        self.assertTrue(f["active"])
        self.assertAlmostEqual(f["strength"], 0.5 + 0.5 * (10 - 8) / 12, places=3)         # 0.5833
        h.loc[h.index[-1], "close"] = 102.0                         # price +2% (> 1.5% flat limit)
        self.assertFalse(E.detect_flags(h)["oi_buildup_no_move"]["active"])
        h2 = frame(noise=False)
        h2["fut_oi"] = np.nan                                       # no futures data: flag stays off, no crash
        self.assertFalse(E.detect_flags(h2)["oi_buildup_no_move"]["active"])

    def test_nr7_squeeze(self):
        h = frame()
        h.loc[h.index[-1], ["high", "low"]] = [h["close"].iloc[-1] + 0.4, h["close"].iloc[-1] - 0.4]   # range 0.8 < 2.0
        f = E.detect_flags(h)["squeeze"]
        self.assertTrue(f["active"])
        self.assertIn("NR7", f["detail"])
        h2 = frame()
        h2.loc[h2.index[-1], ["high", "low"]] = [h2["close"].iloc[-1] + 1.5, h2["close"].iloc[-1] - 1.5]
        self.assertNotIn("NR7", E.detect_flags(h2)["squeeze"]["detail"])

    def test_bollinger_squeeze(self):
        h = frame(noise=False)
        alt = np.where(np.arange(len(h)) % 2 == 0, 3.0, -3.0)
        alt[-25:] = np.where(np.arange(25) % 2 == 0, 0.1, -0.1)     # volatility collapses for 25 sessions
        h["close"] = 100 + alt
        h["high"], h["low"] = h["close"] + 1.0, h["close"] - 1.0
        f = E.detect_flags(h)["squeeze"]
        self.assertTrue(f["active"])
        self.assertIn("Bollinger", f["detail"])
        h2 = frame(noise=False)
        h2["close"] = 100 + np.where(np.arange(len(h2)) % 2 == 0, 3.0, -3.0)   # constant volatility
        h2["high"], h2["low"] = h2["close"] + 1.0, h2["close"] - 1.0
        self.assertFalse(E.detect_flags(h2)["squeeze"]["active"])

    def test_rs_divergence_both_ways(self):
        h = frame(noise=False)
        h.loc[h.index[-1], "nifty"] = 980.0                          # Nifty -2% over 10 sessions
        h.loc[h.index[-1], "close"] = 101.0                          # stock +1%
        f = E.detect_flags(h)["rs_divergence"]
        self.assertEqual((f["active"], f["side"]), (True, "long"))
        self.assertAlmostEqual(f["strength"], 0.5 + 0.5 * 3 / 6, places=3)                 # |1 - (-2)| = 3 -> 0.75
        h2 = frame(noise=False)
        h2.loc[h2.index[-1], "nifty"] = 1020.0
        h2.loc[h2.index[-1], "close"] = 99.0
        self.assertEqual(E.detect_flags(h2)["rs_divergence"]["side"], "short")
        h3 = frame(noise=False)
        h3.loc[h3.index[-1], ["nifty", "close"]] = [980.0, 98.0]     # both fall: no divergence
        self.assertFalse(E.detect_flags(h3)["rs_divergence"]["active"])

    def test_volume_dry_up_near_range_extreme(self):
        h = frame(noise=False)
        h.loc[h.index[-3:], "volume"] = 500.0                        # 0.5x <= 0.6x ; close at the 20d high zone
        f = E.detect_flags(h)["volume_dry_up"]
        self.assertTrue(f["active"])
        self.assertAlmostEqual(f["strength"], 0.5 + 0.5 * (0.6 - 0.5) / 0.3, places=3)     # 0.6667
        h2 = frame(noise=False)
        h2.loc[h2.index[-3:], "volume"] = 800.0                      # 0.8x: not dry enough
        self.assertFalse(E.detect_flags(h2)["volume_dry_up"]["active"])
        h3 = frame(noise=False)
        h3.loc[h3.index[-3:], "volume"] = 500.0
        h3.loc[h3.index[-15], ["high", "low"]] = [112.0, 88.0]       # wide range: close is mid-range, not near an edge
        self.assertFalse(E.detect_flags(h3)["volume_dry_up"]["active"])

    def test_short_history_is_safe(self):
        self.assertFalse(any(v["active"] for v in E.detect_flags(frame(20)).values()))
        self.assertEqual(E.early_stage(frame(20))["stage"], "none")


def flags(active_by_session):
    """Programmable flags_fn: active_by_session maps 'sessions ago' -> number of active flags."""
    def fn(h):
        j = len(FULL) - len(h)
        k = active_by_session.get(j, 0)
        side = "long"
        return {name: dict(active=i < k, strength=0.6 if i < k else 0.0, side=side if i < k else None,
                           detail=f"{name} on") for i, name in enumerate(E.FLAGS)}
    return fn


FULL = frame(noise=False)


def breakout_frame(at: int, side="long", follow=True, back_inside=False, hold=False):
    """Flat range 99-101; breakout `at` sessions ago on volume 1500; optional follow-through."""
    h = frame(noise=False)
    i = len(h) - 1 - at
    sgn = 1 if side == "long" else -1
    h.loc[i, "close"] = 100 + sgn * 1.5
    h.loc[i, "high" if side == "long" else "low"] = 100 + sgn * 1.6
    h.loc[i, "volume"] = 1500.0
    if at > 0 and follow:
        h.loc[h.index[-1], "close"] = 100 + sgn * 2.5
        h.loc[h.index[-1], "high" if side == "long" else "low"] = 100 + sgn * 2.6
    elif at > 0 and hold:   # stays outside the old range but does not extend the move
        h.loc[h.index[-1], "close"] = 100 + sgn * 1.2
    elif at > 0 and back_inside:
        h.loc[h.index[-1], "close"] = 100.0
    return h


class StageTests(unittest.TestCase):
    def setUp(self):
        global FULL
        FULL = frame(noise=False)

    def test_accumulation_needs_two_flags(self):
        r = E.early_stage(FULL, flags_fn=flags({0: 2}))
        self.assertEqual((r["stage"], r["side"]), ("accumulation", "long"))
        self.assertEqual(len(r["flags"]), 2)
        self.assertEqual(E.early_stage(FULL, flags_fn=flags({0: 1}))["stage"], "none")
        self.assertEqual(E.early_stage(FULL, flags_fn=flags({}))["stage"], "none")

    def test_trigger_after_accumulation(self):
        h = breakout_frame(0)
        r = E.early_stage(h, flags_fn=flags({1: 2, 2: 3}))
        self.assertEqual((r["stage"], r["side"]), ("trigger", "long"))
        self.assertAlmostEqual(r["level"], 101.0)                    # prior 20-session high
        self.assertEqual(r["trigger_date"], f"{h['date'].iloc[-1]:%Y-%m-%d}")

    def test_breakout_without_prior_accumulation_is_not_early(self):
        self.assertEqual(E.early_stage(breakout_frame(0), flags_fn=flags({}))["stage"], "none")
        self.assertEqual(E.early_stage(breakout_frame(0), flags_fn=flags({1: 1}))["stage"], "none")

    def test_breakout_needs_volume(self):
        h = breakout_frame(0)
        h.loc[h.index[-1], "volume"] = 1100.0                        # 1.1x < 1.2x
        self.assertEqual(E.early_stage(h, flags_fn=flags({1: 2}))["stage"], "none")

    def test_confirmation_needs_follow_through_and_holding_the_level(self):
        r = E.early_stage(breakout_frame(1, follow=True), flags_fn=flags({2: 2}))
        self.assertEqual((r["stage"], r["side"]), ("confirmation", "long"))
        self.assertGreater(r["levels"]["target"], r["levels"]["entry_ref"])
        self.assertLess(r["levels"]["stop"], r["levels"]["entry_ref"])
        # no follow-through yet, but still outside the range: stays a trigger
        r = E.early_stage(breakout_frame(1, follow=False, hold=True), flags_fn=flags({2: 2}))
        self.assertEqual(r["stage"], "trigger")
        # price fell back inside the old range: breakout failed
        r = E.early_stage(breakout_frame(1, follow=False, back_inside=True), flags_fn=flags({2: 2}))
        self.assertEqual(r["stage"], "none")

    def test_short_side_mirror(self):
        r = E.early_stage(breakout_frame(1, side="short"), flags_fn=flags({2: 2}))
        self.assertEqual((r["stage"], r["side"]), ("confirmation", "short"))
        self.assertGreater(r["levels"]["stop"], r["levels"]["entry_ref"])
        self.assertLess(r["levels"]["target"], r["levels"]["entry_ref"])

    def test_old_breakout_outside_confirm_window_is_ignored(self):
        self.assertEqual(E.early_stage(breakout_frame(5), flags_fn=flags({6: 2}))["stage"], "none")


class AlertIntegrationTests(unittest.TestCase):
    def res(self, stage):
        return dict(stage=stage, side="long", detail="quiet accumulation", flags=["quiet_accumulation"],
                    levels=dict(entry_ref=100.0, stop=96.5, target=107.0))

    def test_messages_follow_watch_ready_go(self):
        m1, prev = E.early_alerts({}, {"TCS": self.res("accumulation")})
        self.assertTrue(m1[0].startswith("[WATCH] TCS long"))
        self.assertIn("Early accumulation: quiet accumulation", m1[0])
        self.assertEqual(prev, {"TCS": "Watch"})
        self.assertEqual(E.early_alerts(prev, {"TCS": self.res("accumulation")})[0], [])        # unchanged
        m2, prev = E.early_alerts(prev, {"TCS": self.res("trigger")})
        self.assertTrue(m2[0].startswith("[READY]"))
        m3, prev = E.early_alerts(prev, {"TCS": self.res("confirmation")})
        self.assertTrue(m3[0].startswith("[GO]"))
        self.assertIn("paper entry 100.00, SL 96.50, target 107.00", m3[0])
        self.assertEqual(prev, {"TCS": "Go"})

    def test_no_message_when_stage_drops_or_is_none(self):
        _, prev = E.early_alerts({}, {"TCS": self.res("confirmation")})
        self.assertEqual(E.early_alerts(prev, {"TCS": self.res("accumulation")})[0], [])
        self.assertEqual(E.early_alerts(prev, {"TCS": dict(stage="none", side=None, detail="")})[0], [])

    def test_all_messages_carry_the_disclaimer(self):
        for st in ("accumulation", "trigger", "confirmation"):
            self.assertIn("not investment advice", E.early_alerts({}, {"X": self.res(st)})[0][0])


class FixtureSmokeTests(unittest.TestCase):
    def test_runs_on_every_fixture_symbol(self):
        m = load_fixtures()
        asof = m.dates[-30]
        seen = set()
        for s in sorted(m.cash["symbol"].unique())[:25]:
            r = E.early_stage(E.history(m, s, asof))
            self.assertIn(r["stage"], ("none", "accumulation", "trigger", "confirmation"))
            seen.add(r["stage"])
        self.assertIn("none", seen)


if __name__ == "__main__":
    unittest.main()
