import json
import shutil
import tempfile
import unittest
from pathlib import Path

from helpers import chain  # noqa: F401
from india_edge.chain import adapters, fixtures, runner
from india_edge.chain.fixtures import STOCKS

DIR = None
DATES = None


def setUpModule():
    global DIR, DATES
    DIR = Path(tempfile.mkdtemp())
    DATES = fixtures.make_fixtures(DIR)


def tearDownModule():
    shutil.rmtree(DIR, ignore_errors=True)


class FixtureShapeTests(unittest.TestCase):
    def test_sixty_days_all_symbols_nearest_expiry(self):
        self.assertEqual(len(DATES), 60)
        self.assertEqual(len(runner.available_days(DIR)), 60)
        self.assertEqual(len(STOCKS), 20)
        for d in (DATES[0], DATES[30], DATES[-1]):
            fo, part, ctx = runner.load_day(d, DIR)
            self.assertEqual(set(fo.chains), set(STOCKS) | {"NIFTY", "BANKNIFTY"})
            self.assertEqual(set(part), {"Client", "DII", "FII", "Pro"})
            self.assertEqual(len(ctx["sectors"]), 11)
            for ch in fo.chains.values():
                self.assertEqual(ch.expiry, fo.expiries[ch.symbol][0])
                self.assertGreaterEqual(ch.dte, 0)
                self.assertTrue(all(r.ce_oi >= 0 and r.pe_oi >= 0 and r.ce_ltp > 0 and r.pe_ltp > 0 for r in ch.rows))
            self.assertEqual(set(fo.index_fut), {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50"})

    def test_oi_change_matches_day_over_day_diff(self):
        a = runner.load_day(DATES[10], DIR)[0].chains["TCS"]
        b = runner.load_day(DATES[11], DIR)[0].chains["TCS"]
        if a.expiry == b.expiry:
            for r in b.rows:
                self.assertAlmostEqual(r.ce_chg, r.ce_oi - a.row(r.strike).ce_oi, delta=1)

    def test_live_fixture(self):
        ch = adapters.LiveChainFetcher(fixture_dir=DIR).get("NIFTY")
        self.assertEqual(ch.symbol, "NIFTY")
        self.assertGreater(len(ch.rows), 30)


class RunnerTests(unittest.TestCase):
    def test_run_day_contract(self):
        res = runner.run_day(DATES[-1], DIR)
        self.assertEqual(len(res["records"]), 22)
        self.assertIn(res["market"]["overview"]["label"], {"Strong Bull", "Bull", "Neutral", "Bear", "Strong Bear"})
        for r in res["records"]:
            for key in ("symbol", "support", "resistance", "reversal_s", "reversal_r", "flags", "market_score", "fii_pulse"):
                self.assertIn(key, r)
            self.assertIsInstance(r["flags"], list)
            if r["support"] is not None and r["reversal_s"] is not None:
                self.assertLess(r["reversal_s"], r["spot"] * 1.2)
        json.dumps(res, default=str)

    def test_deterministic_and_cli_output_file(self):
        out = Path(tempfile.mkdtemp())
        self.assertEqual(runner.main(["run", "--raw-dir", str(DIR), "--out-dir", str(out), "--date", DATES[-1]]), 0)
        first = (out / f"chain_{DATES[-1]}.json").read_text()
        runner.main(["run", "--raw-dir", str(DIR), "--out-dir", str(out), "--date", DATES[-1]])
        self.assertEqual(first, (out / f"chain_{DATES[-1]}.json").read_text())
        shutil.rmtree(out)

    def test_every_flag_appears_somewhere_in_sixty_days(self):
        seen = set()
        for d in DATES[1:]:
            for r in runner.run_day(d, DIR)["records"]:
                seen.update(r["flags"])
        for f in ("TRIPLE_SR_SUPPORT", "POWER_BULL", "BIG_BULL", "SFB", "SFT"):
            self.assertIn(f, seen)

    def test_backtest_base_rates(self):
        res = runner.run_backtest(DIR)
        self.assertEqual(res["days"], 60)
        self.assertGreater(res["labels"], 100)
        for f, v in res["base_rates"].items():
            self.assertTrue(0 <= v["hit_pct"] <= 100 and v["n"] > 0, f)
        self.assertIn("TRIPLE_SR_SUPPORT", res["base_rates"])


if __name__ == "__main__":
    unittest.main()
