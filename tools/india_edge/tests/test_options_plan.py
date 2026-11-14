import math
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import options_plan as O  # noqa: E402

CFG = O.options_config()


def linear(spot, premium, delta=0.5):
    return lambda s: premium + delta * (s - spot)


class PricingTests(unittest.TestCase):
    def test_atm_call_known_value(self):
        # r = 0, S = K = 100, sigma 20%, T 1y: C = S * (2N(0.1) - 1) = 100 * (2*0.5398278 - 1) = 7.96557
        self.assertAlmostEqual(O.bs_price(100, 100, 1, 0.2, 0.0, "CE"), 7.96557, places=3)
        self.assertAlmostEqual(O.bs_price(100, 100, 1, 0.2, 0.0, "PE"), 7.96557, places=3)

    def test_put_call_parity(self):
        for s, k, t, iv, r in [(100, 95, 0.1, 0.3, 0.07), (250, 260, 0.04, 0.45, 0.07), (50, 50, 0.5, 0.2, 0.05)]:
            c, p = O.bs_price(s, k, t, iv, r, "CE"), O.bs_price(s, k, t, iv, r, "PE")
            self.assertAlmostEqual(c - p, s - k * math.exp(-r * t), places=9)

    def test_delta_and_intrinsic_edges(self):
        self.assertAlmostEqual(O.bs_delta(100, 100, 1, 0.2, 0.0, "CE"), 0.539828, places=5)   # N(0.1)
        self.assertAlmostEqual(O.bs_delta(100, 100, 1, 0.2, 0.0, "PE"), -0.460172, places=5)
        self.assertEqual(O.bs_price(110, 100, 0, 0.2, 0.07, "CE"), 10.0)       # expired: intrinsic
        self.assertEqual(O.bs_price(110, 100, 0.1, 0.0, 0.07, "PE"), 0.0)

    def test_realised_vol(self):
        c = 100 * np.cumprod(1 + np.array([0.01, -0.01] * 15))
        self.assertAlmostEqual(O.realized_vol(c), np.std(np.diff(np.log(c))[-20:], ddof=1) * math.sqrt(252), places=9)
        self.assertIsNone(O.realized_vol([100, 101]))


class SelectionTests(unittest.TestCase):
    def test_expiry_window(self):
        ex = ["2026-11-03", "2026-11-10", "2026-11-24"]
        r = O.choose_expiry(ex, "2026-10-28")                       # 6, 13, 27 days
        self.assertEqual((f"{r['expiry']:%Y-%m-%d}", r["days"], r["in_window"]), ("2026-11-10", 13, True))
        r = O.choose_expiry(["2026-11-03", "2026-11-24"], "2026-10-28")   # nothing 10-15: nearest >= 10
        self.assertEqual((r["days"], r["in_window"]), (27, False))
        r = O.choose_expiry(["2026-11-03"], "2026-10-28")                 # only a 6-day expiry exists
        self.assertEqual((r["days"], r["in_window"]), (6, False))
        self.assertIsNone(O.choose_expiry(["2026-10-01"], "2026-10-28"))  # all in the past
        self.assertEqual(O.choose_expiry(["2026-11-12"], "2026-10-28")["days"], 15)   # boundary inclusive
        self.assertEqual(O.choose_expiry(["2026-11-07"], "2026-10-28")["days"], 10)

    def test_moneyness_from_iv_percentile(self):
        self.assertEqual(O.choose_moneyness(60), "itm1")
        self.assertEqual(O.choose_moneyness(50), "itm1")
        self.assertEqual(O.choose_moneyness(40), "atm")
        self.assertEqual(O.choose_moneyness(None), "atm")           # unknown never changes the plan to ITM

    def test_strikes_from_step_and_from_chain(self):
        self.assertEqual(O.choose_strike(1731, "long", "atm")["strike"], 1750.0)      # step 50
        self.assertEqual(O.choose_strike(1731, "long", "itm1")["strike"], 1700.0)     # call ITM = lower
        self.assertEqual(O.choose_strike(1731, "short", "itm1")["strike"], 1800.0)    # put ITM = higher
        chain = [1650, 1700, 1750, 1800, 1850]
        self.assertEqual(O.choose_strike(1731, "long", "atm", strikes=chain)["strike"], 1750.0)
        self.assertEqual(O.choose_strike(1731, "long", "itm1", strikes=chain)["strike"], 1700.0)
        self.assertEqual(O.choose_strike(1731, "short", "itm1", strikes=chain)["strike"], 1800.0)
        self.assertEqual(O.choose_strike(1649, "long", "itm1", strikes=chain)["strike"], 1650.0)  # no lower strike

    def test_iv_percentile_from_frame(self):
        d = pd.bdate_range("2026-01-05", periods=60)
        iv = pd.DataFrame({"date": d, "symbol": "X", "iv": np.arange(1, 61) / 100.0})
        r = O.iv_percentile_from(iv, "X", d[-1])
        self.assertEqual((r["status"], r["pct"], r["iv_now"]), ("ok", 100.0, 0.6))
        self.assertEqual(O.iv_percentile_from(iv, "X", d[34])["pct"], 100.0)
        self.assertEqual(O.iv_percentile_from(iv, "NOPE", d[-1])["status"], "unavailable")
        self.assertEqual(O.iv_percentile_from(pd.DataFrame(), "X", d[-1])["status"], "unavailable")
        self.assertEqual(O.iv_percentile_from(None, "X", d[-1])["status"], "unavailable")
        self.assertEqual(O.iv_percentile_from(iv.head(20), "X", d[-1])["status"], "unavailable")   # < 30 points

    def test_premium_lookup(self):
        fo = pd.DataFrame({"date": pd.to_datetime(["2026-10-27", "2026-10-28"]), "instr": "STO", "symbol": "X",
                           "expiry": ["2026-11-10", "2026-11-10"], "strike": 100.0, "opt_type": "CE",
                           "close": [4.0, 5.0]})
        self.assertEqual(O.lookup_premium(fo, "X", "2026-11-10", 100.0, "CE", "2026-10-28"), 5.0)
        self.assertEqual(O.lookup_premium(fo, "X", "2026-11-10", 100.0, "CE", "2026-10-27"), 4.0)
        self.assertIsNone(O.lookup_premium(fo, "X", "2026-11-10", 105.0, "CE", "2026-10-28"))
        self.assertIsNone(O.lookup_premium(fo, "X", "2026-11-10", 100.0, "PE", "2026-10-28"))
        self.assertIsNone(O.lookup_premium(pd.DataFrame(), "X", "2026-11-10", 100.0, "CE", "2026-10-28"))


class ExpiryRuleTests(unittest.TestCase):
    def test_last_thursday_then_tuesday(self):
        f = lambda y, m: f"{O.monthly_expiry_rule(y, m):%Y-%m-%d %a}"  # noqa: E731
        self.assertEqual(f(2025, 8), "2025-08-28 Thu")      # August 2025: last Thursday
        self.assertEqual(f(2025, 9), "2025-09-30 Tue")      # September 2025 onwards: last Tuesday
        self.assertEqual(f(2026, 10), "2026-10-27 Tue")     # Oct 31 2026 is a Saturday -> Tue 27
        self.assertEqual(f(2026, 11), "2026-11-24 Tue")

    def test_upcoming_monthly_skips_past_and_includes_today(self):
        u = [f"{e:%Y-%m-%d}" for e in O.upcoming_monthly("2026-10-28", 3)]
        self.assertEqual(u, ["2026-11-24", "2026-12-29", "2027-01-26"])
        self.assertEqual(f"{O.upcoming_monthly('2026-10-27', 1)[0]:%Y-%m-%d}", "2026-10-27")


class PlanTests(unittest.TestCase):
    def plan(self, **kw):
        args = dict(side="long", spot=100.0, stop=98.0, target=106.0, symbol="X", asof="2026-10-27",
                    trade_date="2026-10-28", expiries=["2026-11-10"], capital=1_000_000, lot_size=500,
                    reprice=linear(100.0, 10.0))
        args.update(kw)
        sp = args.pop("side"), args.pop("spot"), args.pop("stop"), args.pop("target"), args.pop("symbol")
        return O.option_plan(sp[0], sp[1], sp[2], sp[3], sp[4], args.pop("asof"), args.pop("trade_date"),
                             args.pop("expiries"), args.pop("capital"), **args)

    def fo(self, close=10.0):
        return pd.DataFrame({"date": pd.to_datetime(["2026-10-27"]), "instr": "STO", "symbol": "X",
                             "expiry": ["2026-11-10"], "strike": 100.0, "opt_type": "CE", "close": [close]})

    def test_sizing_hand_computed(self):
        # premium 10, delta 0.5: stop 98 -> 10 - 1.0 = 9.0 ; target 106 -> 10 + 3.0 = 13.0 ; risk/unit 1.0
        # risk 1% of 1,000,000 = 10,000 -> 10,000 units -> 20 lots of 500 ; cost 100,000 (10% of capital)
        p = self.plan(fo=self.fo(10.0))
        self.assertEqual(p["status"], "ok")
        self.assertEqual((p["type"], p["strike"], p["expiry"], p["premium_source"]), ("CE", 100.0, "2026-11-10", "bhavcopy"))
        self.assertAlmostEqual(p["premium_stop"], 9.0)
        self.assertAlmostEqual(p["premium_target"], 13.0)
        self.assertAlmostEqual(p["reward_risk"], 3.0)
        self.assertEqual((p["lots"], p["qty"]), (20, 10_000))
        self.assertAlmostEqual(p["cost"], 100_000.0)
        self.assertAlmostEqual(p["risk_at_stop"], 10_000.0)

    def test_risk_clamped_between_one_and_two_percent(self):
        hi = self.plan(fo=self.fo(10.0), cfg={"options": {"risk_pct": 5.0}})
        lo = self.plan(fo=self.fo(10.0), cfg={"options": {"risk_pct": 0.2}})
        self.assertEqual((hi["risk_pct"], hi["qty"]), (2.0, 20_000))      # 20,000 / 1.0
        self.assertEqual((lo["risk_pct"], lo["qty"]), (1.0, 10_000))

    def test_cost_cap(self):
        # premium 100: risk/unit still 1.0 -> 10,000 units would cost 1,000,000; cap 20% = 200,000 -> 2,000 units
        p = O.option_plan("long", 100.0, 98.0, 106.0, "X", "2026-10-27", "2026-10-28", ["2026-11-10"], 1_000_000,
                          fo=self.fo(100.0), lot_size=500, reprice=linear(100.0, 100.0))
        self.assertEqual((p["lots"], p["qty"]), (4, 2000))
        self.assertAlmostEqual(p["risk_at_stop"], 2000.0)
        self.assertTrue(any("capped" in n for n in p["notes"]))

    def test_premium_stop_floor(self):
        # stop far away: model premium would hit 0; floor = 20% of 10 = 2.0 -> risk/unit 8
        p = self.plan(stop=80.0, fo=self.fo(10.0))
        self.assertAlmostEqual(p["premium_stop"], 2.0)
        self.assertAlmostEqual(p["risk_per_unit"], 8.0)
        self.assertEqual(p["qty"], 1000)                                   # 10,000 / 8 = 1250 -> 2 lots of 500

    def test_one_lot_too_big_gives_size_zero(self):
        p = self.plan(fo=self.fo(10.0), capital=50_000)                    # risk 500 -> 500 units < lot 1000
        p2 = self.plan(fo=self.fo(10.0), capital=50_000, lot_size=1000)
        self.assertEqual(p["status"], "ok")
        self.assertEqual((p2["status"], p2["lots"], p2["qty"]), ("size_zero", 0, 0))

    def test_unknown_lot_size_sizes_in_units(self):
        p = self.plan(fo=self.fo(10.0), lot_size=None)
        self.assertEqual((p["lots"], p["qty"]), (None, 10_000))
        self.assertTrue(any("lot size unknown" in n for n in p["notes"]))

    def test_missing_iv_is_noted_never_a_veto(self):
        p = self.plan(fo=self.fo(10.0), iv_df=pd.DataFrame())
        self.assertEqual((p["iv_status"], p["iv_percentile"], p["moneyness"], p["status"]), ("unavailable", None, "atm", "ok"))
        self.assertTrue(any("no veto" in n for n in p["notes"]))
        self.assertNotIn("vetoed", p)

    def test_high_iv_percentile_picks_itm1(self):
        d = pd.bdate_range("2026-01-05", periods=60)
        iv = pd.DataFrame({"date": d, "symbol": "X", "iv": np.arange(1, 61) / 100.0})
        p = self.plan(fo=self.fo(10.0), iv_df=iv, asof=d[-1])
        self.assertEqual((p["iv_status"], p["moneyness"], p["strike"]), ("ok", "itm1", 95.0))   # step 5 at price 100: ATM 100, call 1-ITM 95

    def test_model_premium_when_no_bhavcopy_row(self):
        closes = 100 * np.cumprod(1 + np.array([0.01, -0.01] * 15))
        p = O.option_plan("long", 100.0, 98.0, 106.0, "X", "2026-10-27", "2026-10-28", ["2026-11-10"], 1_000_000,
                          closes=closes, lot_size=500)
        self.assertEqual(p["status"], "ok")
        self.assertTrue(p["premium_source"].startswith("model"))
        self.assertGreater(p["premium_target"], p["premium"])
        self.assertLess(p["premium_stop"], p["premium"])
        # model premium equals Black-Scholes at the realised vol (13 days, r 7%)
        iv = O.realized_vol(closes)
        self.assertAlmostEqual(p["premium"], O.bs_price(100.0, p["strike"], 13 / 365, iv, 0.07, "CE"), places=9)

    def test_no_premium_when_nothing_to_model_with(self):
        p = O.option_plan("long", 100.0, 98.0, 106.0, "X", "2026-10-27", "2026-10-28", ["2026-11-10"], 1_000_000)
        self.assertEqual(p["status"], "no_premium")
        self.assertIn("type", p)                                  # still says which contract it would be

    def test_no_expiry(self):
        p = O.option_plan("long", 100.0, 98.0, 106.0, "X", "2026-10-27", "2026-10-28", [], 1_000_000)
        self.assertEqual(p["status"], "no_expiry")

    def test_short_uses_put(self):
        p = O.option_plan("short", 100.0, 102.0, 94.0, "X", "2026-10-27", "2026-10-28", ["2026-11-10"], 1_000_000,
                          lot_size=500, reprice=linear(100.0, 10.0, delta=-0.5), fo=pd.DataFrame(
                              {"date": pd.to_datetime(["2026-10-27"]), "instr": "STO", "symbol": "X",
                               "expiry": ["2026-11-10"], "strike": 100.0, "opt_type": "PE", "close": [10.0]}))
        self.assertEqual((p["type"], p["status"]), ("PE", "ok"))
        self.assertAlmostEqual(p["premium_stop"], 9.0)             # 10 + (-0.5)(102-100)
        self.assertAlmostEqual(p["premium_target"], 13.0)          # 10 + (-0.5)(94-100)

    def test_max_two_positions(self):
        ok = lambda: dict(status="ok", notes=[])  # noqa: E731
        out = O.select_positions([ok(), ok(), ok()])
        self.assertEqual([p["status"] for p in out], ["ok", "ok", "skipped"])
        out = O.select_positions([ok(), ok()], open_count=1)
        self.assertEqual([p["status"] for p in out], ["ok", "skipped"])
        out = O.select_positions([dict(status="no_premium", notes=[]), ok(), ok()])
        self.assertEqual([p["status"] for p in out], ["no_premium", "ok", "ok"])    # failed plans use no slot


if __name__ == "__main__":
    unittest.main()
