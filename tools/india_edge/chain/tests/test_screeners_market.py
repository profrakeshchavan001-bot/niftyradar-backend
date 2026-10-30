import unittest

from helpers import chain
from india_edge.chain import backtest, bs, market, screeners
from india_edge.chain.model import Chain, Strike


class SrStocksTests(unittest.TestCase):
    def test_tolerance_cooldown_and_repeat_badge(self):
        sc = screeners.SrStocksScanner()
        a = sc.on_tick("X", 0, 1000.5, 1000.0, None)           # 0.05% exactly -> inside
        self.assertEqual((len(a), a[0]["side"], a[0]["badge"]), (1, "support", ""))
        self.assertEqual(sc.on_tick("X", 300, 1000.0, 1000.0, None), [])    # inside 10-min cooldown
        self.assertEqual(sc.on_tick("X", 599, 1000.0, 1000.0, None), [])
        b = sc.on_tick("X", 600, 1000.0, 1000.0, None)
        self.assertEqual((b[0]["count"], b[0]["badge"]), (2, "x2"))
        self.assertEqual(sc.on_tick("X", 1300, 1000.6, 1000.0, None), [])   # 0.06% -> outside
        self.assertEqual(sc.on_tick("X", 1300, 999.5, 1000.0, None)[0]["count"], 3)
        # other symbol / other side are independent
        self.assertEqual(len(sc.on_tick("Y", 0, 500.0, None, 500.0)), 1)


class TripleSrTests(unittest.TestCase):
    def test_support_and_resistance(self):
        c = chain(100, pe={90: 500, 80: 300}, pe_vol={90: 80, 80: 10}, pe_chg={90: 40, 80: 5},
                  ce={110: 400, 120: 300}, ce_vol={110: 9, 120: 90}, ce_chg={110: 5, 120: 7})
        t = screeners.triple_sr(c)
        self.assertEqual(t["support"], 90)
        self.assertIsNone(t["resistance"])               # OI at 110, volume/chg at 120

    def test_none_when_empty(self):
        self.assertEqual(screeners.triple_sr(chain(100, strikes=[90, 110])), {"support": None, "resistance": None})


class PowerStockTests(unittest.TestCase):
    def test_bull(self):
        # PE adds 100+50 = 150, CE adds 40 -> 150 >= 2.5*40 = 100; PCR = 600/400 = 1.5; support 90 is also top PE chg
        c = chain(100, pe={90: 400, 80: 200}, pe_chg={90: 100, 80: 50}, ce={110: 400}, ce_chg={110: 40})
        self.assertEqual(screeners.power_stock(c), "bull")

    def test_not_one_sided_enough(self):
        c = chain(100, pe={90: 400, 80: 200}, pe_chg={90: 100, 80: 50}, ce={110: 400}, ce_chg={110: 61})   # 150 < 152.5
        self.assertIsNone(screeners.power_stock(c))

    def test_bear(self):
        c = chain(100, ce={110: 400, 120: 200}, ce_chg={110: 100, 120: 50}, pe={90: 400}, pe_chg={90: 40})
        self.assertEqual(screeners.power_stock(c), "bear")


class Oi2OiTests(unittest.TestCase):
    def test_long_with_room(self):
        # spot 100 at max-PE-OI strike 100; 2nd PE strike 80 -> SL 20; max CE strike 130 -> room 30 >= 20
        c = chain(100, pe={100: 900, 80: 500, 70: 100}, ce={130: 800, 110: 100})
        o = screeners.oi2oi(c)
        self.assertEqual((o["side"], o["sl"], o["room"], o["target"]), ("long", 20, 30, 130))

    def test_skipped_when_room_below_sl(self):
        c = chain(100, pe={100: 900, 80: 500}, ce={110: 800})        # room 10 < SL 20
        self.assertIsNone(screeners.oi2oi(c))

    def test_not_at_the_strike(self):
        c = chain(95, pe={90: 900, 70: 500}, ce={130: 800})          # 5.3% away from the PE strike
        self.assertIsNone(screeners.oi2oi(c))

    def test_short_mirror(self):
        c = chain(100, ce={100: 900, 120: 500}, pe={70: 800, 90: 100})   # SL 20, room 30
        o = screeners.oi2oi(c)
        self.assertEqual((o["side"], o["sl"], o["room"]), ("short", 20, 30))


class TrapTests(unittest.TestCase):
    def test_big_bull_and_bear_conditions(self):
        c = chain(100, ce={90: 1000, 100: 500, 110: 300})
        self.assertEqual(screeners.trap_signal(c), ["BIG_BULL"])
        c = chain(100, ce={90: 400, 100: 500})
        self.assertEqual(screeners.trap_signal(c), [])
        c = chain(100, pe={110: 1000, 100: 500, 90: 300})
        self.assertEqual(screeners.trap_signal(c), ["BIG_BEAR"])

    def test_window_and_once_per_side_per_day(self):
        sc = screeners.TrapScanner()
        c = chain(100, ce={90: 1000, 100: 500}, pe={110: 1000, 100: 500})
        self.assertEqual(sc.scan(c, "09:29"), [])
        self.assertEqual(sc.scan(c, "09:30"), ["BIG_BULL", "BIG_BEAR"])
        self.assertEqual(sc.scan(c, "10:00"), [])                       # already fired today
        self.assertEqual(sc.scan(chain(100, ce={90: 1000, 100: 500}, date="2026-10-02"), "14:30"), ["BIG_BULL"])
        self.assertEqual(sc.scan(chain(100, ce={90: 1000, 100: 500}, date="2026-10-03"), "14:31"), [])


class OverviewTests(unittest.TestCase):
    def test_score_formula_and_labels(self):
        # score = (net + 8) / 16 * 100
        cases = {8: (100.0, "Strong Bull"), 4: (75.0, "Strong Bull"), 3: (68.75, "Bull"), 2: (62.5, "Bull"),
                 1: (56.25, "Neutral"), 0: (50.0, "Neutral"), -1: (43.75, "Neutral"), -2: (37.5, "Bear"),
                 -3: (31.25, "Bear"), -4: (25.0, "Strong Bear"), -8: (0.0, "Strong Bear")}
        for net, (score, label) in cases.items():
            sig = {k: 0 for k in market.SIGNALS}
            n = abs(net)
            for k in list(market.SIGNALS)[:n]:
                sig[k] = 1 if net > 0 else -1
            r = market.overview_score(sig)
            self.assertEqual((r["net"], r["score"], r["label"]), (net, score, label), net)

    def test_signal_thresholds(self):
        n = chain(100, pe={90: 600}, ce={110: 400}, pe_chg={90: 60}, ce_chg={110: 40})     # PE share exactly 60, PCR 1.5
        b = chain(100, pe={90: 400}, ce={110: 500}, pe_chg={90: 40}, ce_chg={110: 60})     # share exactly 40, PCR 0.8
        fut = lambda base: {s: {"fut": base, "spot": 100.0} for s in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50")}  # noqa: E731
        sig = market.overview_signals(n, b, fut(101), fut(100.5), {f"s{i}": 1 for i in range(9)} | {"x": -1, "y": -1}, 55.0)
        self.assertEqual(sig["pe_share_nifty"], 1)
        self.assertEqual(sig["pe_share_banknifty"], -1)
        self.assertEqual(sig["pcr_nifty"], 1)
        self.assertEqual(sig["pcr_banknifty"], 0)         # exactly 0.8 is not < 0.8
        self.assertEqual((sig["premium_nifty"], sig["premium_5_indices"]), (1, 1))
        self.assertEqual((sig["sectors"], sig["breadth"]), (1, 1))     # 9 green; 55 >= 55
        sig = market.overview_signals(n, b, fut(100.0), fut(100.5), {f"s{i}": 1 for i in range(8)} | {"x": -1}, 45.0)
        self.assertEqual((sig["premium_nifty"], sig["premium_5_indices"], sig["sectors"], sig["breadth"]), (-1, -1, 0, -1))


class PulseMmiLtpTests(unittest.TestCase):
    def test_fii_pulse_hand_values(self):
        def part(fii, pro):
            return {"FII": fii, "Pro": pro}
        prev = part({"idx_fut_long": 100, "idx_fut_short": 100, "idx_ce_long": 50, "idx_ce_short": 50,
                     "idx_pe_long": 10, "idx_pe_short": 10, "stk_fut_long": 70, "stk_fut_short": 70}, {})
        today = part({"idx_fut_long": 160, "idx_fut_short": 100, "idx_ce_long": 50, "idx_ce_short": 80,
                      "idx_pe_long": 30, "idx_pe_short": 10, "stk_fut_long": 70, "stk_fut_short": 90},
                     {"idx_fut_long": 10, "idx_fut_short": 0})
        # index fut net: (160-100)+(10-0) = +70 vs 0 -> +1 | ce net 50-80 = -30 vs 0 -> -1 (bear)
        # pe net 30-10 = +20 vs 0 -> up = bear -> -1 | stock fut net 70-90 = -20 vs 0 -> -1
        p = market.fii_pulse(today, prev)
        self.assertEqual(p["points"], {"index_futures": 1, "index_calls": -1, "index_puts": -1, "stock_futures": -1})
        self.assertEqual((p["total"], p["bias"]), (-2, "bear"))

    def test_mmi_hand_value(self):
        # parts: pcr 1.0 -> 0.5; pe_share 60 -> 0.6; adv 50 -> 0.5; sectors 5/10 -> 0.5; overview 50 -> 0.5; pulse 0 -> 0.5
        # mean = 3.1 / 6 = 0.516667 -> 51.67
        m = market.mmi(1.0, 60, 50, 5, 10, 50, 0)
        self.assertEqual((m["mmi"], m["zone"]), (51.67, "optimistic"))
        self.assertEqual(market.mmi(0.5, 0, 0, 0, 10, 0, -4)["mmi"], 0.0)
        self.assertEqual(market.mmi(1.5, 100, 100, 10, 10, 100, 4)["mmi"], 100.0)

    def test_ltp_calc(self):
        T = 30 / 365
        px = round(bs.price(100, 100, T, 0.2, True), 4)
        c = Chain("T", "2026-10-01", "2026-10-31", 100.0, [Strike(100, ce_ltp=px, pe_ltp=px)])
        r = market.ltp_calc(c, 100, True, support=90, resistance=110, days_ahead=1)
        self.assertEqual((r["width"], r["target_spot"], r["stop_spot"]), (20, 120, 90.0))     # target full width, SL half width
        want = px + r["delta"] * 20 + 0.5 * r["gamma"] * 400 - r["theta"]
        self.assertAlmostEqual(r["ltp_at_target"], want, places=9)
        self.assertGreater(r["ltp_at_target"], px)
        self.assertLess(r["ltp_at_stop"], px)
        put = market.ltp_calc(c, 100, False, 90, 110)
        self.assertEqual((put["target_spot"], put["stop_spot"]), (80, 110.0))
        self.assertIsNone(market.ltp_calc(chain(100, strikes=[100]), 100, True, 90, 110))


class BacktestLabelTests(unittest.TestCase):
    def test_labels_and_base_rates(self):
        recs = [{"symbol": "A", "date": "d1", "spot": 100.0, "support": 95.0, "resistance": 105.0, "flags": ["TRIPLE_SR_SUPPORT", "SFT"]},
                {"symbol": "B", "date": "d1", "spot": 200.0, "support": 190.0, "resistance": 210.0, "flags": ["TRIPLE_SR_SUPPORT"]}]
        labs = backtest.label_day(recs, {"A": 102.0, "B": 188.0})
        a_sup = [x for x in labs if x["symbol"] == "A" and x["flag"] == "TRIPLE_SR_SUPPORT"][0]
        self.assertEqual((a_sup["hit"], a_sup["held"], round(a_sup["ret_pct"], 6)), (True, True, 2.0))
        sft = [x for x in labs if x["flag"] == "SFT"][0]
        self.assertEqual((sft["dir"], sft["hit"], sft["held"]), ("bear", False, True))     # up 2%: bear flag missed; 102 <= 105
        rates = backtest.base_rates(labs)["TRIPLE_SR_SUPPORT"]
        # A: +2% hit/held; B: 188/200-1 = -6% miss, 188 < 190 not held -> hit 50%, held 50%, avg (2-6)/2 = -2
        self.assertEqual((rates["n"], rates["hit_pct"], rates["held_pct"], rates["avg_ret_pct"]), (2, 50.0, 50.0, -2.0))


if __name__ == "__main__":
    unittest.main()
