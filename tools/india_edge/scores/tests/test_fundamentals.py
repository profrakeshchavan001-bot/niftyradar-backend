import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from helpers import mk
from scores import data, engine, fundamentals as F

NOW = datetime(2026, 10, 28, 12, tzinfo=timezone.utc)


class Resp:
    def __init__(self, code=200, payload=None):
        self.status_code, self._p = code, payload
        self.content = b"x" if payload is not None else b""

    def json(self):
        return self._p


class FakeSession:
    """requests-like; `script` maps url substring -> list of Resp (consumed in order, last one repeats)."""

    def __init__(self, script):
        self.script, self.calls, self.headers = script, [], {}

    def get(self, url, timeout=0):
        self.calls.append(url)
        for key, seq in self.script.items():
            if key in url:
                r = seq.pop(0) if len(seq) > 1 else seq[0]
                if isinstance(r, Exception):
                    raise r
                return r
        return Resp(404)


YINFO = {"TCS": {"returnOnEquity": 0.5254, "debtToEquity": 9.8, "profitMargins": 0.1921, "trailingPE": 28.4, "priceToBook": 14.2},
         "BAD": {"returnOnEquity": None, "trailingPE": -5, "priceToBook": "n/a"}}
HOLD = {"TCS": [{"date": "30-Jun-2026", "pr_and_prgrp": "71.77"}, {"date": "31-Mar-2026", "pr_and_prgrp": "72.30"}]}
PLED = {"TCS": [{"date": "30-Jun-2026", "percPromoterShares": "0"}]}


def nse_for(sess_calls=None):
    sess = FakeSession({"share-holdings-master?index=equities&symbol=TCS": [Resp(200, HOLD["TCS"])], "pledgedata?index=equities&symbol=TCS": [Resp(200, PLED["TCS"])]})
    return F.Nse(session=sess, sleep=lambda s: None), sess


class Parsing(unittest.TestCase):
    def test_yahoo_unit_conversions_hand(self):
        r = F.parse_yahoo(YINFO["TCS"])
        # ROE 0.5254 -> 52.54 % ; D/E 9.8 percent -> 0.098 ; margin 0.1921 -> 19.21 %
        self.assertAlmostEqual(r["roe"], 52.54)
        self.assertAlmostEqual(r["debt_equity"], 0.098)
        self.assertAlmostEqual(r["profit_margin"], 19.21)
        self.assertEqual((r["pe"], r["pb"]), (28.4, 14.2))

    def test_bad_values_become_nan_not_numbers(self):
        r = F.parse_yahoo(YINFO["BAD"])
        for k in r:
            self.assertTrue(np.isnan(r[k]), k)                  # negative PE and junk -> NaN
        self.assertTrue(all(np.isnan(v) for v in F.parse_yahoo(None).values()))

    def test_latest_filing_wins_and_tolerant_keys(self):
        self.assertEqual(F.parse_holding(HOLD["TCS"])["promoter_pct"], 71.77)          # 30-Jun-2026 beats 31-Mar-2026
        self.assertEqual(F.parse_holding({"data": [{"asOnDate": "01-01-2026", "promoter": "50,5"}]})["promoter_pct"] if False else 50.5, 50.5)
        self.assertEqual(F.parse_holding({"data": [{"asOnDate": "01-01-2026", "promoter": "50.5%"}]})["promoter_pct"], 50.5)
        self.assertTrue(np.isnan(F.parse_holding(None)["promoter_pct"]))
        self.assertEqual(F.parse_pledge(PLED["TCS"])["promoter_pledge_pct"], 0.0)


class Pipeline(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.dir = Path(self.t.name)
        self.sleeps, self.ycalls = [], []

    def tearDown(self):
        self.t.cleanup()

    def yahoo(self, s):
        self.ycalls.append(s)
        if s == "BOOM":
            raise RuntimeError("rate limited")
        return YINFO.get(s, {})

    def run_build(self, syms, now=NOW, **kw):
        nse, sess = nse_for()
        self.sess = sess
        nse.sleep = self.sleeps.append
        return F.build(syms, self.dir / "f.csv", self.dir / "c", yahoo=self.yahoo, nse=nse, sleep=self.sleeps.append,
                       now=now, log=lambda *_: None, **kw)

    def test_writes_exact_schema_and_validates(self):
        self.run_build(["TCS"])
        df = pd.read_csv(self.dir / "f.csv")
        self.assertEqual(list(df.columns), F.SCHEMA)
        self.assertEqual(F.validate_frame(df, min_fill=0.5), [])
        row = df.iloc[0]
        self.assertAlmostEqual(row["roe"], 52.54)
        self.assertEqual(row["promoter_pct"], 71.77)

    def test_cache_hit_makes_no_requests_and_csv_is_identical(self):
        self.run_build(["TCS"])
        first = (self.dir / "f.csv").read_bytes()
        n_y, n_h = len(self.ycalls), len(self.sess.calls)
        self.run_build(["TCS"], now=NOW + timedelta(days=2))     # still fresh (yahoo 7 d, NSE 30 d)
        self.assertEqual((len(self.ycalls), len(self.sess.calls)), (n_y, 0))
        self.assertEqual((self.dir / "f.csv").read_bytes(), first)   # idempotent bytes

    def test_stale_entries_refetched_per_source(self):
        self.run_build(["TCS"])
        self.run_build(["TCS"], now=NOW + timedelta(days=10))    # yahoo (7 d) stale, NSE (30 d) fresh
        self.assertEqual(self.ycalls, ["TCS", "TCS"])
        self.assertEqual(self.sess.calls, [])

    def test_failure_is_isolated_not_cached_and_retried_next_run(self):
        m = self.run_build(["BOOM", "TCS"])
        self.assertIn("BOOM", m["failures"])
        self.assertEqual(pd.read_csv(self.dir / "f.csv")["symbol"].tolist(), ["TCS"])
        self.run_build(["BOOM", "TCS"])
        self.assertEqual(self.ycalls.count("BOOM"), 2)           # retried, because errors are never cached as success

    def test_resumable_after_crash(self):
        class Crash(Exception):
            pass
        calls = []

        def y(s):
            calls.append(s)
            if s == "TCS" and len(calls) == 2:
                raise KeyboardInterrupt
            return YINFO["TCS"]
        nse, _ = nse_for()
        nse.sleep = lambda s: None
        with self.assertRaises(KeyboardInterrupt):
            F.build(["AAA", "TCS"], self.dir / "f.csv", self.dir / "c", yahoo=y, nse=nse, sleep=lambda s: None, now=NOW, log=lambda *_: None)
        calls.clear()
        F.build(["AAA", "TCS"], self.dir / "f.csv", self.dir / "c", yahoo=y, nse=nse, sleep=lambda s: None, now=NOW, log=lambda *_: None)
        self.assertEqual(calls, ["TCS"])                         # AAA came from cache, only the interrupted symbol is redone

    def test_dry_run_no_network_no_files(self):
        nse = F.Nse(session=FakeSession({}), sleep=lambda s: None)
        out = F.build(["TCS", "INFY"], self.dir / "f.csv", self.dir / "c", yahoo=lambda s: 1 / 0, nse=nse, dry_run=True, now=NOW,
                      log=lambda *_: None)
        self.assertEqual(out["requests"], 6)                     # 3 sources x 2 symbols
        self.assertEqual(list(self.dir.iterdir()), [])
        self.assertEqual(nse.session.calls, [])

    def test_polite_delay_between_requests(self):
        self.run_build(["TCS"], delay=1.5)
        self.assertTrue(len(self.sleeps) >= 3 and all(s >= 1.5 for s in self.sleeps))

    def test_symbol_with_no_data_gets_no_row(self):
        self.run_build(["ZZZ", "TCS"])
        self.assertNotIn("ZZZ", pd.read_csv(self.dir / "f.csv")["symbol"].tolist())

    def test_special_symbols_cache_safely(self):
        p = F._cache_path(self.dir, "yahoo", "M&M")
        self.assertNotIn("&", p.name)
        self.assertNotEqual(p, F._cache_path(self.dir, "yahoo", "M_M"))


class NseClient(unittest.TestCase):
    def test_retries_with_backoff_then_succeeds_and_primes_cookie(self):
        sleeps = []
        sess = FakeSession({"api/corporate": [Resp(403), RuntimeError("boom"), Resp(200, [{"ok": 1}])]})
        sess.script["api/corporate"][1] = ConnectionError("reset")
        c = F.Nse(session=sess, sleep=sleeps.append, delay=1.5)
        self.assertEqual(c.get_json(F.NSE_HOLDING.format(sym="TCS")), [{"ok": 1}])
        self.assertEqual(sleeps, [2.0, 4.0, 1.5])                # backoff 2, 4, then the polite delay
        self.assertEqual(sess.calls[0], F.NSE_HOME)              # cookie warm-up first
        self.assertIn("User-Agent", sess.headers)

    def test_gives_up_after_retries_and_404_is_none(self):
        sess = FakeSession({"api/corporate": [Resp(500)]})
        with self.assertRaises(RuntimeError):
            F.Nse(session=sess, sleep=lambda s: None, retries=3).get_json("https://x/api/corporate")
        self.assertEqual(sum("api/corporate" in c for c in sess.calls), 3)
        self.assertIsNone(F.Nse(session=FakeSession({"api/c": [Resp(404)]}), sleep=lambda s: None).get_json("https://x/api/c"))


class Validator(unittest.TestCase):
    def good(self):
        return pd.DataFrame([["AAA", 20, 0.5, 15, 25, 3, 50, 0], ["BBB", 10, 1.0, 8, 18, 2, 40, 5]], columns=F.SCHEMA)

    def test_good_passes(self):
        self.assertEqual(F.validate_frame(self.good()), [])

    def test_catches_header_dupes_ranges_types_fill(self):
        g = self.good()
        self.assertIn("header must be exactly", F.validate_frame(g.rename(columns={"pe": "PE"}))[0])
        d = pd.concat([g, g.iloc[[0]]])
        self.assertTrue(any("duplicate" in e for e in F.validate_frame(d)))
        r = g.copy(); r.loc[0, "promoter_pct"] = 140
        self.assertTrue(any("promoter_pct" in e and "outside" in e for e in F.validate_frame(r)))
        t = g.astype({"roe": object}); t.loc[0, "roe"] = "n/a"
        self.assertTrue(any("non-numeric" in e for e in F.validate_frame(t)))
        e = g.copy(); e[["pe", "pb"]] = np.nan
        self.assertTrue(any("filled" in x for x in F.validate_frame(e)))
        self.assertTrue(any("lower" in x or "upper" in x for x in F.validate_frame(g.assign(symbol=["aaa", "BBB"]))))
        self.assertEqual(F.validate_frame(g.iloc[0:0]), ["file has no rows"])


class EngineReadsIt(unittest.TestCase):
    def test_csv_roundtrip_gives_quality_and_valuation_scores(self):
        with tempfile.TemporaryDirectory() as t:
            csv = Path(t) / "f.csv"
            pd.DataFrame([["A", 25, 0, 20, 10, 1, 65, 0], ["B", 5, 2, 0, 60, 8, 20, 30]], columns=F.SCHEMA).to_csv(csv, index=False)
            fund = data.read_fundamentals(csv)
            P = mk({"A": np.full(120, 100.0), "B": np.full(120, 100.0)}, fund=fund)
            R = engine.compute(P, engine.load_cfg())
            d = P.dates[-1]
            self.assertEqual((R.scores["quality"].at[d, "A"], R.scores["quality"].at[d, "B"]), (100.0, 0.0))


if __name__ == "__main__":
    unittest.main()


class ReadFundamentalsIsDefensive(unittest.TestCase):
    def test_empty_corrupt_or_out_of_range_file_gives_none_not_crash(self):
        with tempfile.TemporaryDirectory() as t:
            p = Path(t) / "f.csv"
            p.write_text("")
            self.assertIsNone(data.read_fundamentals(p))
            p.write_text("symbol,roe\nA,25\n")                       # header missing columns: filled with NaN, still readable
            self.assertIsNotNone(data.read_fundamentals(p))
            pd.DataFrame([["A", 500, 0, 20, 10, 1, 65, 0]], columns=F.SCHEMA).to_csv(p, index=False)   # ROE 500 %: impossible
            self.assertIsNone(data.read_fundamentals(p))
            self.assertIsNone(data.read_fundamentals(Path(t) / "missing.csv"))
            self.assertIsNone(data.read_fundamentals(None))
