import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from intraday import BARS_PER_DAY, get_bars, synth_bars  # noqa: E402
from loader import FIXTURES, load_fixtures, load_market  # noqa: E402

spec = importlib.util.spec_from_file_location("fx_generate", FIXTURES / "generate.py")
GEN = importlib.util.module_from_spec(spec)
spec.loader.exec_module(GEN)


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = load_fixtures()

    def test_shape_and_span(self):
        m = self.m
        self.assertEqual(m.cash["symbol"].nunique(), 60)
        self.assertEqual(m.dates[0].year, 2015)
        self.assertEqual(m.dates[-1], pd.Timestamp("2026-10-28"))
        self.assertEqual(set(m.fo["instr"]), {"STF", "STO"})
        self.assertEqual(m.idx["index_name"].unique().tolist(), ["Nifty 50"])
        self.assertGreater(len(m.events), 100)

    def test_ohlc_is_consistent(self):
        c = self.m.cash
        self.assertTrue((c["high"] >= c[["open", "close"]].max(axis=1)).all())
        self.assertTrue((c["low"] <= c[["open", "close"]].min(axis=1)).all())
        self.assertTrue((c["close"] > 0).all() and c["deliv_pct"].between(0, 100).all())

    def test_has_all_regimes_and_gaps(self):
        c = self.m.cash
        gap = (c["open"] / c["prev_close"] - 1).abs()
        self.assertGreater((gap > 0.03).sum(), 500)                    # event gaps exist
        one = c[c["symbol"] == c["symbol"].iloc[0]].set_index("date")["close"]
        er = (one.diff(40).abs() / one.diff().abs().rolling(40).sum()).dropna()
        self.assertGreater((er > 0.3).mean(), 0.05)                    # trending stretches
        self.assertGreater((er < 0.1).mean(), 0.05)                   # choppy stretches

    def test_generator_matches_committed_files(self):
        small = GEN.generate(n_symbols=3)
        syms = small["cash"]["symbol"].unique()
        committed = self.m.cash[self.m.cash["symbol"].isin(syms)].reset_index(drop=True)
        pd.testing.assert_frame_equal(small["cash"], committed, check_dtype=False)

    def test_load_market_defaults_to_fixtures(self):
        os.environ.pop("DATA_DIR", None)
        self.assertEqual(load_market().source, "fixtures")

    def test_load_market_reads_data_dir(self):
        from common import day_file
        with tempfile.TemporaryDirectory() as t:
            os.environ["DATA_DIR"] = t
            try:
                d = pd.Timestamp("2026-10-27")
                row = self.m.cash[self.m.cash["date"] == self.m.dates[-1]].head(2).assign(date=d)
                row.to_parquet(day_file("cash", d), index=False)
                self.m.fo[self.m.fo["date"] == self.m.dates[-1]].head(4).assign(date=d).to_parquet(
                    day_file("fo", d), index=False)
                self.m.idx.tail(1).assign(date=d).to_parquet(day_file("idx", d), index=False)
                m = load_market()
                self.assertEqual((m.source, len(m.cash)), ("real", 2))
            finally:
                os.environ.pop("DATA_DIR", None)


class IntradayTests(unittest.TestCase):
    O, H, L, C, V = 100.0, 104.0, 98.0, 102.5, 1_000_000

    def test_bars_respect_the_daily_bar(self):
        b = synth_bars("TCS", "2026-10-05", self.O, self.H, self.L, self.C, self.V)
        self.assertEqual(len(b), BARS_PER_DAY)
        self.assertEqual(b["open"].iloc[0], self.O)
        self.assertEqual(b["close"].iloc[-1], self.C)
        self.assertAlmostEqual(b["high"].max(), self.H)
        self.assertAlmostEqual(b["low"].min(), self.L)
        self.assertTrue((b["high"] >= b[["open", "close"]].max(axis=1)).all())
        self.assertTrue((b["low"] <= b[["open", "close"]].min(axis=1)).all())
        self.assertAlmostEqual(b["volume"].sum(), self.V, delta=BARS_PER_DAY)
        self.assertEqual(b["ts"].iloc[0], pd.Timestamp("2026-10-05 09:15"))
        self.assertEqual(b["ts"].iloc[-1], pd.Timestamp("2026-10-05 15:15"))

    def test_deterministic_and_symbol_specific(self):
        a = synth_bars("TCS", "2026-10-05", self.O, self.H, self.L, self.C, self.V)
        b = synth_bars("TCS", "2026-10-05", self.O, self.H, self.L, self.C, self.V)
        c = synth_bars("INFY", "2026-10-05", self.O, self.H, self.L, self.C, self.V)
        pd.testing.assert_frame_equal(a, b)
        self.assertFalse(np.allclose(a["close"], c["close"]))

    def test_real_csv_wins(self):
        with tempfile.TemporaryDirectory() as t:
            f = Path(t) / "intraday" / "TCS"
            f.mkdir(parents=True)
            pd.DataFrame({"ts": ["2026-10-05 09:15"], "open": [1], "high": [2], "low": [0.5],
                          "close": [1.5], "volume": [10]}).to_csv(f / "2026-10-05.csv", index=False)
            cash = pd.DataFrame()
            got = get_bars(cash, "TCS", "2026-10-05", root=Path(t))
            self.assertEqual(len(got), 1)


if __name__ == "__main__":
    unittest.main()
