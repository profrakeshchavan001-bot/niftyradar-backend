import json
import math
import unittest
import zipfile
import io

from helpers import chain  # noqa: F401  (also puts tools/ on sys.path)
from india_edge.chain import adapters, bs, reversal, shifts, sr
from india_edge.chain.model import Chain, Strike


class BlackScholesTests(unittest.TestCase):
    def test_atm_call_zero_rate(self):
        # r=0, S=K=100, v=0.2, T=1: C = S*(2*N(v*sqrt(T)/2)-1) = 100*(2*0.539828-1) = 7.9656
        self.assertAlmostEqual(bs.price(100, 100, 1, 0.2, True, r=0.0), 7.9656, places=3)
        # ATM call delta with r=0 is N(0.1) = 0.539828
        self.assertAlmostEqual(bs.greeks(100, 100, 1, 0.2, True, r=0.0)["delta"], 0.539828, places=5)

    def test_put_call_parity(self):
        c, p = bs.price(100, 105, 0.5, 0.3, True), bs.price(100, 105, 0.5, 0.3, False)
        self.assertAlmostEqual(c - p, 100 - 105 * math.exp(-0.07 * 0.5), places=6)

    def test_iv_roundtrip_and_bad_input(self):
        p = bs.price(100, 110, 0.25, 0.27, True)
        self.assertAlmostEqual(bs.implied_vol(p, 100, 110, 0.25, True), 0.27, places=4)
        self.assertIsNone(bs.implied_vol(0.0, 100, 110, 0.25, True))
        self.assertIsNone(bs.implied_vol(1.0, 100, 50, 0.25, True))   # below intrinsic

    def test_theta_is_positive_decay(self):
        self.assertGreater(bs.greeks(100, 100, 0.1, 0.2, True)["theta"], 0)


def udiff(rows):
    head = "TradDt,FinInstrmTp,TckrSymb,XpryDt,StrkPric,OptnTp,ClsPric,LastPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,UndrlygPric\n"
    return (head + "\n".join(",".join(map(str, r)) for r in rows)).encode()


class AdapterTests(unittest.TestCase):
    ROWS = [
        ["2026-10-01", "STO", "ABC", "2026-10-29", 100, "CE", 5, 5.5, 100, 10, 50, 98],
        ["2026-10-01", "STO", "ABC", "2026-10-29", 100, "PE", 6, 6.5, 200, -20, 70, 98],
        ["2026-10-01", "STO", "ABC", "2026-11-26", 100, "CE", 9, 9, 999, 1, 1, 98],
        ["2026-10-01", "STO", "ABC", "2026-09-24", 100, "CE", 1, 1, 777, 1, 1, 98],   # expired: ignored
        ["2026-10-01", "IDF", "NIFTY", "2026-10-29", 0, "", 25100, 25100, 1, 0, 1, 25000],
    ]

    def test_nearest_expiry_default_and_strike_cells(self):
        day = adapters.parse_fo_bhavcopy(udiff(self.ROWS))
        ch = day.chains["ABC"]
        self.assertEqual(ch.expiry, "2026-10-29")
        r = ch.row(100)
        self.assertEqual((r.ce_oi, r.ce_chg, r.ce_vol, r.ce_ltp), (100, 10, 50, 5.5))
        self.assertEqual((r.pe_oi, r.pe_chg, r.pe_vol, r.pe_ltp), (200, -20, 70, 6.5))
        self.assertEqual(ch.spot, 98)
        self.assertEqual(day.expiries["ABC"], ["2026-10-29", "2026-11-26"])
        self.assertEqual(day.index_fut["NIFTY"]["fut"], 25100)

    def test_next_expiry_and_zip_input(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("x.csv", udiff(self.ROWS))
        day = adapters.parse_fo_bhavcopy(buf.getvalue(), expiry_index=1)
        self.assertEqual(day.chains["ABC"].expiry, "2026-11-26")
        self.assertEqual(day.chains["ABC"].row(100).ce_oi, 999)

    def test_legacy_format_needs_spots(self):
        raw = ("INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,CLOSE,CONTRACTS,OPEN_INT,CHG_IN_OI,TIMESTAMP\n"
               "OPTSTK,ABC,29-Oct-2015,100,CE,5,12,300,30,01-Oct-2015\n"
               "OPTSTK,ABC,29-Oct-2015,100,PE,4,8,100,-5,01-Oct-2015\n").encode()
        ch = adapters.parse_fo_bhavcopy(raw, spots={"ABC": 99.0}).chains["ABC"]
        self.assertEqual((ch.date, ch.expiry, ch.spot), ("2015-10-01", "2015-10-29", 99.0))
        self.assertEqual((ch.row(100).ce_vol, ch.row(100).pe_chg), (12, -5))

    def test_participant_file_with_title_line(self):
        raw = ("Participant wise Open Interest as on Oct 01, 2026\n"
               "Client Type,Future Index Long ,Future Index Short,Option Index Call Long,TOTAL X\n"
               "Client,10,20,30,1\nFII,100,50,7,1\nTOTAL,1,1,1,1\n").encode()
        p = adapters.parse_participant_oi(raw)
        self.assertEqual(set(p), {"Client", "FII"})
        self.assertEqual((p["FII"]["idx_fut_long"], p["FII"]["idx_fut_short"], p["FII"]["idx_ce_long"]), (100, 50, 7))

    def test_live_chain_parse_and_cache(self):
        payload = {"records": {"timestamp": "01-Oct-2026 11:00:00", "underlyingValue": 100.0, "data": [
            {"strikePrice": 100, "expiryDate": "29-Oct-2026", "CE": {"openInterest": 5, "changeinOpenInterest": 1, "totalTradedVolume": 9, "lastPrice": 3.0},
             "PE": {"openInterest": 7, "changeinOpenInterest": -2, "totalTradedVolume": 8, "lastPrice": 2.0}},
            {"strikePrice": 100, "expiryDate": "26-Nov-2026", "CE": {"openInterest": 99}}]}}
        ch = adapters.parse_live_chain(payload, "ABC")
        self.assertEqual((ch.date, ch.expiry, ch.row(100).ce_oi, ch.row(100).pe_chg), ("2026-10-01", "2026-10-29", 5, -2))

        calls, t = [], [1000.0]
        f = adapters.LiveChainFetcher(refresh_s=5, clock=lambda: t[0])    # clamped up to 60 s
        self.assertEqual(f.refresh_s, 60)
        f._payload = lambda s: calls.append(s) or payload
        f.get("ABC"); t[0] += 59; f.get("ABC")
        self.assertEqual(len(calls), 1)
        t[0] += 2; f.get("ABC")
        self.assertEqual(len(calls), 2)
        self.assertEqual(adapters.LiveChainFetcher(refresh_s=9999).refresh_s, 180)


class SupportResistanceTests(unittest.TestCase):
    def setUp(self):
        # spot 100: PE strikes <= spot -> 100:200, 90:500, 80:300 => max OI 90. CE >= spot -> 120:450 beats 110:400.
        self.ch = chain(100, pe={100: 200, 90: 500, 80: 300}, ce={100: 150, 110: 400, 120: 450},
                        pe_vol={90: 10, 100: 50}, ce_vol={110: 70}, pe_chg={100: 40, 90: 5}, ce_chg={110: 9})

    def test_three_metrics(self):
        s = sr.support_resistance(self.ch)
        self.assertEqual(s["support"], {"oi": 90, "vol": 100, "chg": 100})
        self.assertEqual(s["resistance"], {"oi": 120, "vol": 110, "chg": 110})
        self.assertEqual((s["primary_support"], s["primary_resistance"]), (90, 120))

    def test_tie_goes_to_strike_nearest_spot(self):
        c = chain(100, pe={90: 500, 80: 500})
        self.assertEqual(sr.pick(c, "pe", "oi"), 90)

    def test_colour_tags(self):
        tags = sr.colour_tags(self.ch, "ce")
        self.assertEqual((tags[120], tags[110]), ("red", "yellow"))
        self.assertNotIn(100, tags)                      # 150 < 75% of 450
        c2 = chain(100, ce={110: 400, 120: 450, 130: 340, 140: 337})     # 0.75*450 = 337.5
        t2 = sr.colour_tags(c2, "ce")
        self.assertEqual(t2[130], "light_yellow")
        self.assertNotIn(140, t2)
        self.assertEqual(sr.colour_tags(self.ch, "pe")[90], "green")

    def test_pcr_bar_thresholds(self):
        self.assertEqual(sr.pcr_bar(chain(100, pe={90: 121}, ce={110: 100}))["colour"], "green")   # 1.21
        self.assertEqual(sr.pcr_bar(chain(100, pe={90: 120}, ce={110: 100}))["colour"], "grey")    # exactly 1.2
        self.assertEqual(sr.pcr_bar(chain(100, pe={90: 79}, ce={110: 100}))["colour"], "red")      # 0.79
        self.assertEqual(sr.pcr_bar(chain(100, pe={90: 80}, ce={110: 100}))["colour"], "grey")     # exactly 0.8


def bs_chain(spot=100.0, iv=0.2, step=10, days=30):
    exp = f"2026-10-{1 + days:02d}"
    rows = []
    for k in range(60, 141, step):
        T = days / 365
        rows.append(Strike(k, 100, 100, 1, round(bs.price(spot, k, T, iv, True), 4), 100, 100, 1, round(bs.price(spot, k, T, iv, False), 4)))
    return Chain("T", "2026-10-01", exp, spot, rows)


class ReversalTests(unittest.TestCase):
    def test_support_level_between_pair_strikes(self):
        # Hand reasoning: at S=K-d the PE(K-d) is ATM and CE(K) is OTM -> gap<0; at S=K the CE(K) is ATM and
        # PE(K-d) is OTM -> gap>0. CE(K)-PE(K-d) is increasing in S, so the zero lies in (K-d, K).
        c = bs_chain()
        r = reversal.support_level(c, 100)
        self.assertTrue(90 < r["level"] < 100)
        self.assertTrue(90 < r["projection"] < 100 or abs(r["projection"] - r["level"]) < 10)
        # the solved level really zeroes the gap
        gap_at, _, _ = reversal._pair(c, 100, 90, 15)
        self.assertAlmostEqual(gap_at(r["level"]), 0.0, places=6)

    def test_resistance_level_between_pair_strikes(self):
        r = reversal.resistance_level(bs_chain(), 100)      # CE(110) == PE(100) -> level in (100, 110)
        self.assertTrue(100 < r["level"] < 110)

    def test_projection_is_gap_over_slope(self):
        c = bs_chain()
        r = reversal.support_level(c, 100)
        # S_rev = spot - gap/(delta_ce + |delta_pe|)
        self.assertAlmostEqual(r["projection"], c.spot - r["gap"] / (r["delta_ce"] + abs(r["delta_pe"])), places=9)

    def test_missing_premium_returns_none(self):
        c = bs_chain()
        c.row(90).pe_ltp = 0
        self.assertIsNone(reversal.support_level(c, 100))

    def test_gap_cross(self):
        self.assertEqual(reversal.gap_cross(2.0, -1.0), "down")
        self.assertEqual(reversal.gap_cross(-2.0, 1.0), "up")
        self.assertIsNone(reversal.gap_cross(2.0, 1.0))
        self.assertIsNone(reversal.gap_cross(None, 1.0))
        self.assertIsNone(reversal.gap_cross(0.0, 1.0))


class ShiftTests(unittest.TestCase):
    def test_tot_table_all_nine(self):
        exp = {("up", "up"): "strong-bull", ("up", "same"): "bull", ("up", "down"): "neutral",
               ("same", "up"): "bull", ("same", "same"): "neutral", ("same", "down"): "bear",
               ("down", "up"): "neutral", ("down", "same"): "bear", ("down", "down"): "strong-bear"}
        self.assertEqual(shifts.TOT, exp)

    def test_flags(self):
        f = shifts.shift_flags(90, 120, 100, 110)        # support up, resistance down
        self.assertEqual((f["flags"], f["bias"]), (["SFT", "SFB"], "neutral"))
        f = shifts.shift_flags(90, 120, 100, 130)        # both up
        self.assertEqual((f["flags"], f["bias"]), (["SFB", "STT"], "strong-bull"))
        f = shifts.shift_flags(90, 120, 80, 110)        # both down
        self.assertEqual((f["flags"], f["bias"]), (["SFT", "STB"], "strong-bear"))
        self.assertEqual(shifts.shift_flags(90, 120, 90, 120)["flags"], [])
        self.assertEqual(shifts.shift_flags(None, 120, 90, 120)["support_move"], "same")


if __name__ == "__main__":
    unittest.main()
