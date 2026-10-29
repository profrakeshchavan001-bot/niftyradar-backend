import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import robust as R  # noqa: E402
from common import day_file, load_config  # noqa: E402
from layer1 import build_feature_frame, scan  # noqa: E402
from loader import Market, load_fixtures, load_market  # noqa: E402

CFG = load_config()


PRICES = ["open", "high", "low", "close", "prev_close"]


def clean_market(n=80, syms=("AAA", "BBB", "CCC"), seed=1):
    rng = np.random.default_rng(seed)
    d = pd.bdate_range("2026-05-04", periods=n)
    rows, fo = [], []
    for s in syms:
        c = 100.0
        for i, day in enumerate(d):
            prev, c = c, c * (1 + rng.normal(0, 0.01))
            rows.append(dict(date=day, symbol=s, prev_close=prev, open=prev, high=max(prev, c) * 1.002,
                             low=min(prev, c) * 0.998, close=c, volume=1e7, deliv_qty=4e6, deliv_pct=40.0))
            fo.append(dict(date=day, instr="STF", symbol=s, expiry="2026-12-31", strike=0.0, opt_type="XX", close=c,
                           oi=1e6, chg_oi=rng.normal(0, 1e4), volume=1e5))
            fo.append(dict(date=day, instr="STO", symbol=s, expiry="2026-12-31", strike=100.0, opt_type="CE", close=2.0,
                           oi=1e6, chg_oi=rng.normal(0, 1e4), volume=1e6))
    idx = pd.DataFrame(dict(date=d, index_name="Nifty 50", close=20000.0 + np.arange(n)))
    return Market(pd.DataFrame(rows), pd.DataFrame(fo), idx, pd.DataFrame(), pd.DataFrame(), "real")


def sanitize(m, **kw):
    kw.setdefault("renames", {})
    return R.sanitize_market(m, **kw)


class CleaningTests(unittest.TestCase):
    def test_clean_input_passes_through_untouched(self):
        m = clean_market()
        out = sanitize(m)
        pd.testing.assert_frame_equal(out.cash.sort_values(["symbol", "date"]).reset_index(drop=True)[m.cash.columns],
                                      m.cash.sort_values(["symbol", "date"]).reset_index(drop=True))
        n = out.health_notes
        self.assertEqual((n["rows_dropped"], n["duplicates"], n["ohlc_repaired"], n["corp_actions"]), (0, 0, 0, []))

    def test_fixtures_are_unchanged_by_sanitising(self):
        m = load_fixtures()
        out = sanitize(m)
        n = out.health_notes
        self.assertEqual((n["rows_dropped"], n["duplicates"], n["ohlc_repaired"], len(n["corp_actions"])), (0, 0, 0, 0))
        self.assertEqual(len(out.cash), len(m.cash))
        self.assertEqual(n["suspect_jumps"], [])

    def test_empty_or_all_invalid_cash_raises_readable_error(self):
        m = clean_market()
        with self.assertRaises(R.MarketDataError) as cm:
            sanitize(Market(pd.DataFrame(), m.fo, m.idx))
        self.assertIn("cash bhavcopy", str(cm.exception))
        bad = m.cash.assign(close=np.nan)
        with self.assertRaises(R.MarketDataError):
            sanitize(Market(bad, m.fo, m.idx))

    def test_bad_rows_duplicates_and_ohlc_repairs(self):
        m = clean_market()
        c = m.cash.copy()
        c.loc[5, "close"] = np.nan                      # missing close: dropped
        c.loc[6, "close"] = 0.0                         # zero close: dropped
        c.loc[7, "high"] = c.loc[7, "low"] - 1          # high below low: repaired
        c.loc[8, "open"] = np.nan                       # missing open: filled
        c = pd.concat([c, c.iloc[[10]]], ignore_index=True)   # exact duplicate row
        c.loc[11, "volume"] = -5                        # negative volume -> 0
        out = sanitize(Market(c, m.fo, m.idx)).cash
        n = sanitize(Market(c, m.fo, m.idx)).health_notes
        self.assertEqual((n["rows_dropped"], n["duplicates"]), (2, 1))
        self.assertGreaterEqual(n["ohlc_repaired"], 2)
        self.assertTrue((out["high"] >= out[["open", "close"]].max(axis=1)).all())
        self.assertTrue((out["low"] <= out[["open", "close"]].min(axis=1)).all())
        self.assertTrue((out["volume"] >= 0).all() and out["volume"].notna().all())
        self.assertEqual(len(out), len(m.cash) - 2)

    def test_string_numbers_and_bad_dates_do_not_crash(self):
        m = clean_market()
        c = m.cash.astype({"close": object, "date": object})
        c.loc[3, "close"] = "n/a"
        c.loc[4, "date"] = "not a date"
        out = sanitize(Market(c, m.fo, m.idx)).cash
        self.assertEqual(len(out), len(m.cash) - 2)

    def test_symbol_rename_merges_history(self):
        m = clean_market()
        c = m.cash.copy()
        c.loc[(c["symbol"] == "AAA") & (c["date"] < pd.Timestamp("2026-06-15")), "symbol"] = "OLD"
        out = sanitize(Market(c, m.fo, m.idx), renames={"OLD": "AAA"})
        self.assertNotIn("OLD", set(out.cash["symbol"]))
        self.assertEqual(int((out.cash["symbol"] == "AAA").sum()), 80)
        self.assertEqual(out.health_notes["renames"], ["OLD->AAA"])

    def test_rename_overlap_keeps_the_new_symbols_rows(self):
        m = clean_market()
        extra = m.cash[(m.cash["symbol"] == "AAA") & (m.cash["date"] == m.cash["date"].iloc[10])].assign(symbol="OLD", close=999.0)
        out = sanitize(Market(pd.concat([m.cash, extra], ignore_index=True), m.fo, m.idx), renames={"OLD": "AAA"}).cash
        day = out[(out["symbol"] == "AAA") & (out["date"] == m.cash["date"].iloc[10])]
        self.assertEqual(len(day), 1)
        self.assertLess(float(day["close"].iloc[0]), 200)

    def test_split_is_back_adjusted_hand_computed(self):
        m = clean_market()
        c = m.cash.copy()
        sym = c["symbol"] == "BBB"
        t = c.loc[sym, "date"].iloc[40]
        before = sym & (c["date"] < t)
        after = sym & (c["date"] >= t)
        # 1:2 split on day t: raw prices halve. NSE's prev_close on day t is already adjusted (= yesterday / 2).
        ycl = float(c.loc[sym & (c["date"] == c.loc[sym, "date"].iloc[39]), "close"].iloc[0])
        c.loc[after, PRICES] = c.loc[after, PRICES] / 2
        c.loc[sym & (c["date"] == t), "prev_close"] = ycl / 2
        c.loc[sym & (c["date"] == t), "close"] = ycl / 2 * 1.02          # genuine +2% that day
        out = sanitize(Market(c, m.fo, m.idx))
        ev = out.health_notes["corp_actions"]
        self.assertEqual((len(ev), ev[0]["symbol"], ev[0]["factor"]), (1, "BBB", 0.5))
        s = out.cash[out.cash["symbol"] == "BBB"].sort_values("date").reset_index(drop=True)
        k = int(np.nonzero(s["date"] == t)[0][0])
        ret = s["close"].iloc[k] / s["close"].iloc[k - 1] - 1
        self.assertAlmostEqual(ret, 0.02, places=9)                      # continuous return across the split
        self.assertAlmostEqual(s["close"].iloc[k - 1], ycl / 2, places=9)  # earlier close scaled x0.5
        self.assertAlmostEqual(s["volume"].iloc[k - 1], 2e7)              # earlier volume doubled
        other = out.cash[out.cash["symbol"] == "AAA"]
        self.assertTrue(np.allclose(np.sort(other["close"].to_numpy()), np.sort(m.cash[m.cash["symbol"] == "AAA"]["close"].to_numpy())))

    def test_two_events_compound(self):
        m = clean_market()
        c = m.cash.copy()
        sym = c["symbol"] == "CCC"
        dates = c.loc[sym, "date"].to_numpy()
        for k in (30, 60):                                              # two 1:2 splits
            y = float(c.loc[sym & (c["date"] == dates[k - 1]), "close"].iloc[0])
            later = sym & (c["date"] >= dates[k])
            c.loc[later, PRICES] = c.loc[later, PRICES] / 2
            c.loc[sym & (c["date"] == dates[k]), "prev_close"] = y / 2
        out = sanitize(Market(c, m.fo, m.idx))
        self.assertEqual(len(out.health_notes["corp_actions"]), 2)
        s = out.cash[out.cash["symbol"] == "CCC"].sort_values("date")
        r = s["close"].pct_change().dropna()
        self.assertLess(r.abs().max(), 0.06)                             # no 50% / 75% cliffs left

    def test_big_move_with_unadjusted_prev_close_is_flagged_not_adjusted(self):
        m = clean_market()
        c = m.cash.copy()
        i = c.index[(c["symbol"] == "AAA") & (c["date"] == c["date"].iloc[30])][0]
        prev = c.loc[i, "prev_close"]
        c.loc[i, ["open", "high", "low", "close"]] = prev * 0.5          # -50% crash, prev_close untouched
        nxt = c.index[(c["symbol"] == "AAA") & (c["date"] == c["date"].iloc[31])][0]
        c.loc[nxt, "prev_close"] = prev * 0.5                            # next day's reference is the crashed close
        out = sanitize(Market(c, m.fo, m.idx))
        self.assertEqual(out.health_notes["corp_actions"], [])
        self.assertGreaterEqual(len(out.health_notes["suspect_jumps"]), 1)   # the crash (and the synthetic rebound)
        self.assertAlmostEqual(out.health_notes["suspect_jumps"][0]["move_pct"], -50.0, delta=1.5)

    def test_partial_day_and_stale_symbol_are_reported(self):
        m = clean_market(syms=tuple(f"S{i:02d}" for i in range(20)))
        c = m.cash
        last = c["date"].max()
        drop_day = c["date"].unique()[-5]
        keep = ~((c["date"] == drop_day) & (c["symbol"] > "S01"))           # only 2 of 20 symbols on that day
        c = c[keep]
        c = c[~((c["symbol"] == "S19") & (c["date"] > c["date"].unique()[-12]))]   # S19 stops trading
        out = sanitize(Market(c, m.fo, m.idx))
        self.assertIn(f"{drop_day:%Y-%m-%d}", out.health_notes["partial_days"])
        self.assertIn("S19", out.health_notes["stale_symbols"])
        h = R.data_health(out, last)
        self.assertEqual(h["status"], "degraded")
        self.assertTrue(any("partial days" in w for w in h["warnings"]))


class PipelineSurvivesBrokenInputs(unittest.TestCase):
    def feats(self, m):
        m = sanitize(m)
        return m, build_feature_frame(m, CFG)

    def test_holiday_gap_in_calendar(self):
        m = clean_market()
        gap = m.cash["date"].unique()[60:63]
        m2 = Market(m.cash[~m.cash["date"].isin(gap)], m.fo[~m.fo["date"].isin(gap)], m.idx[~m.idx["date"].isin(gap)])
        m2, f = self.feats(m2)
        self.assertGreater(len(f), 0)
        picks = scan(m2, m2.cash["date"].max(), CFG)
        self.assertIsInstance(picks, pd.DataFrame)
        self.assertTrue(any("weekday" in w for w in R.data_health(m2, m2.cash["date"].max())["warnings"]))

    def test_no_futures_or_options_data(self):
        m = clean_market()
        m2, f = self.feats(Market(m.cash, pd.DataFrame(), m.idx))
        self.assertGreater(len(f), 0)
        self.assertTrue((f["quadrant"] == "neutral").all())                # no OI -> no quadrant, no crash
        self.assertEqual(len(scan(m2, m2.cash["date"].max(), CFG)), 0)     # nothing qualifies without a direction
        h = R.data_health(m2, m2.cash["date"].max())
        self.assertTrue(any("F&O bhavcopy" in x for x in h["missing"]))

    def test_no_nifty_series(self):
        m = clean_market()
        m2, f = self.feats(Market(m.cash, m.fo, pd.DataFrame()))
        self.assertGreater(len(f), 0)
        self.assertTrue(f["rs"].isna().all())
        h = R.data_health(m2, m2.cash["date"].max())
        self.assertEqual(h["status"], "bad")
        self.assertTrue(any("Nifty 50" in x for x in h["missing"]))

    def test_all_delivery_missing(self):
        m = clean_market()
        m2, f = self.feats(Market(m.cash.assign(deliv_pct=np.nan, deliv_qty=np.nan), m.fo, m.idx))
        self.assertTrue(f["deliv_ratio"].isna().all())
        self.assertIsInstance(scan(m2, m2.cash["date"].max(), CFG), pd.DataFrame)

    def test_single_symbol_and_very_short_history(self):
        for n, syms in ((12, ("AAA",)), (80, ("AAA",))):
            m2, f = self.feats(clean_market(n=n, syms=syms))
            self.assertIsInstance(scan(m2, m2.cash["date"].max(), CFG), pd.DataFrame)


class LoaderTests(unittest.TestCase):
    def write_days(self, root, m, days):
        os.environ["DATA_DIR"] = str(root)
        for d in days:
            m.cash[m.cash["date"] == d].to_parquet(day_file("cash", d), index=False)
            m.fo[m.fo["date"] == d].to_parquet(day_file("fo", d), index=False)
            m.idx[m.idx["date"] == d].to_parquet(day_file("idx", d), index=False)

    def tearDown(self):
        os.environ.pop("DATA_DIR", None)

    def test_corrupt_empty_and_stray_files_are_skipped(self):
        m = clean_market()
        days = list(m.cash["date"].unique()[:30])
        with tempfile.TemporaryDirectory() as t:
            self.write_days(t, m, days)
            (Path(t) / "cash" / "2026-06-30.parquet").write_bytes(b"this is not parquet")
            m.cash.iloc[0:0].to_parquet(Path(t) / "cash" / "2026-07-01.parquet", index=False)
            (Path(t) / "cash" / "notes.txt").write_text("ignore me")
            (Path(t) / "idx" / "2026-06-30.parquet").write_bytes(b"")
            mk = load_market()
            self.assertEqual(mk.cash["date"].nunique(), 30)
            errs = " ".join(mk.health_notes["load_errors"])
            self.assertIn("cash/2026-06-30.parquet", errs)
            self.assertIn("cash/2026-07-01.parquet: empty", errs)
            self.assertIn("idx/2026-06-30.parquet", errs)
            h = R.data_health(mk, days[-1])
            self.assertEqual(h["status"], "degraded")
            self.assertTrue(any("unreadable" in w for w in h["warnings"]))

    def test_missing_folders_and_optional_files(self):
        m = clean_market()
        with tempfile.TemporaryDirectory() as t:
            self.write_days(t, m, list(m.cash["date"].unique()[:30]))
            import shutil
            shutil.rmtree(Path(t) / "fo")                                   # whole F&O folder gone
            (Path(t) / "iv.parquet").write_bytes(b"garbage")                # corrupt optional input
            (Path(t) / "events.csv").write_text("date,symbol,kind\nnot-a-date,TCS,x\n")
            mk = load_market()
            self.assertTrue(mk.fo.empty and mk.iv.empty)
            h = R.data_health(mk, mk.cash["date"].max())
            self.assertTrue(any("F&O" in x for x in h["missing"]))
            self.assertTrue(any("iv.parquet" in x for x in h["missing"]))

    def test_missing_required_data_raises_readable_error(self):
        with tempfile.TemporaryDirectory() as t:
            os.environ["DATA_DIR"] = t
            with self.assertRaises(R.MarketDataError) as cm:
                load_market()
            self.assertIn("cash day files", str(cm.exception))
            m = clean_market()
            m.cash.head(10).to_parquet(day_file("cash", pd.Timestamp("2026-05-04")), index=False)
            with self.assertRaises(R.MarketDataError) as cm:
                load_market()
            self.assertIn("index", str(cm.exception))


class HealthTests(unittest.TestCase):
    def test_all_present_but_optional_inputs_is_degraded_with_a_list(self):
        m = sanitize(clean_market())
        h = R.data_health(m, m.cash["date"].max(), today=m.cash["date"].max())
        self.assertEqual(h["status"], "degraded")
        self.assertEqual([x.split(" ")[0] for x in h["missing"]], ["iv.parquet", "events.csv"])
        self.assertGreater(h["inputs"]["cash_rows"], 0)

    def test_complete_inputs_is_ok(self):
        m = sanitize(clean_market())
        m.iv = m.cash[["date", "symbol"]].assign(iv=0.3, opt_spread_pct=0.01, opt_premium=2.0)
        m.events = pd.DataFrame({"date": [pd.Timestamp("2026-07-01")], "symbol": ["ALL"], "kind": ["macro"]})
        h = R.data_health(m, m.cash["date"].max(), today=m.cash["date"].max())
        self.assertEqual((h["status"], h["missing"], h["warnings"]), ("ok", [], []))

    def test_missing_asof_day_is_bad(self):
        m = sanitize(clean_market())
        h = R.data_health(m, m.cash["date"].max() + pd.Timedelta(days=1))
        self.assertEqual(h["status"], "bad")
        self.assertTrue(any("cash bhavcopy for" in x for x in h["missing"]))

    def test_lag_and_bars_reporting(self):
        m = sanitize(clean_market())
        last = m.cash["date"].max()
        h = R.data_health(m, last, today=last + pd.Timedelta(days=7), bars_present=2, bars_expected=5)
        self.assertTrue(any("weekdays behind today" in w for w in h["warnings"]))
        self.assertTrue(any("15-minute bars for 3 of 5 picks" in x for x in h["missing"]))
        h0 = R.data_health(m, last, bars_present=0, bars_expected=5)
        self.assertTrue(any("0 of 5 picks" in x for x in h0["missing"]))

    def test_renames_file_loads_and_ignores_comments(self):
        r = R.load_renames()
        self.assertEqual(r["ZOMATO"], "ETERNAL")
        self.assertNotIn("_comment", r)
        self.assertEqual(R.load_renames(Path("/nonexistent/x.json")), {})


if __name__ == "__main__":
    unittest.main()
