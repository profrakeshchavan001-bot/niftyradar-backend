import os
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from helpers import mk
from scores import build, data, engine, health, sensitivity

CFG = engine.load_cfg()


class Edge(unittest.TestCase):
    def test_duplicate_rows_do_not_double_count(self):
        P = mk({"A": np.linspace(100, 130, 120), "B": np.linspace(100, 90, 120)})
        cash = pd.concat([_long(P), _long(P)])
        P2 = data.Panels(cash, pd.DataFrame({"date": P.dates, "index_name": "Nifty 50", "close": 20000.0}), {"A": "S", "B": "S"})
        pd.testing.assert_frame_equal(P.close, P2.close)

    def test_nan_delivery_and_zero_volume_run(self):
        n = 150
        v = {"A": np.r_[np.full(n - 3, 1e6), np.zeros(3)], "B": np.full(n, 1e6)}
        d = {"A": np.full(n, np.nan), "B": np.full(n, 50.0)}
        P = mk({"A": np.linspace(100, 120, n), "B": np.linspace(100, 115, n)}, volume=v, deliv=d)
        R = engine.compute(P, CFG)
        self.assertEqual(R.status.iloc[-1]["A"], "illiquid")
        self.assertFalse(np.isnan(R.scores["trend"].iloc[-1]["B"]))
        # B has delivery data but A has none: A's delivery component is NaN, not 0
        self.assertTrue(np.isnan(R.comps["volume_delivery"][1].score.iloc[-1]["A"]))

    def test_one_bar_symbol_and_all_nan_symbol(self):
        n = 120
        P = mk({"A": np.linspace(100, 130, n), "NEWB": np.r_[np.full(n - 1, np.nan), 50.0], "GHOST": np.full(n, np.nan)})
        R = engine.compute(P, CFG)
        self.assertEqual(R.status.iloc[-1]["NEWB"], "new_listing")
        self.assertEqual(R.status.iloc[-1]["GHOST"], "not_listed")
        out, _ = build.build(P)
        syms = {c["symbol"] for c in out["scores"]["stocks"]}
        self.assertNotIn("GHOST", syms)                              # never listed: not shown at all
        self.assertIn("NEWB", syms)
        self.assertEqual(next(c for c in out["scores"]["stocks"] if c["symbol"] == "NEWB")["status"], "new_listing")

    def test_unmapped_sector_goes_to_other(self):
        P = mk({"A": np.linspace(100, 130, 120)}, sectors={"ZZZ": "Banks"})
        self.assertEqual(P.sector["A"], "Other")

    def test_bad_asof_raises_clear_error(self):
        P = mk({"A": np.linspace(100, 130, 120)})
        with self.assertRaises(ValueError):
            build.build(P, day="2020-01-01")

    def test_earlier_asof_works_and_matches_full_history(self):
        P = mk({f"S{i}": np.linspace(100, 100 + i, 300) for i in range(1, 8)})
        day = P.dates[-50]
        out, R = build.build(P, day=day)
        self.assertEqual(out["overview"]["date"], f"{day:%Y-%m-%d}")

    def test_split_like_jump_is_flagged_not_hidden(self):
        a = np.r_[np.full(100, 100.0), np.full(20, 50.0)]
        P = mk({"A": a, "B": np.full(120, 100.0)})
        h = health.check(P, engine.compute(P, CFG), P.dates[-1])
        self.assertIn("price jumps", " ".join(h["notes"]).lower())

    def test_missing_nifty_is_reported_bad(self):
        P = mk({"A": np.linspace(100, 130, 120)})
        P.nifty = pd.Series(np.nan, index=P.dates)
        h = health.check(P, engine.compute(P, CFG), P.dates[-1])
        self.assertEqual(h["grade"], "bad")


def _long(P):
    return pd.DataFrame({"date": np.repeat(P.dates, len(P.symbols)), "symbol": list(P.symbols) * len(P.dates),
                         "open": P.open.to_numpy().ravel(), "high": P.high.to_numpy().ravel(), "low": P.low.to_numpy().ravel(),
                         "close": P.close.to_numpy().ravel(), "volume": P.volume.to_numpy().ravel(),
                         "deliv_pct": P.deliv.to_numpy().ravel()})


class RealDataInterface(unittest.TestCase):
    """DATA_DIR day-file layout (what data/fetch.py writes) must run end to end."""

    def test_day_files_roundtrip_via_cli(self):
        from loader import load_fixtures
        from scores import run
        m = load_fixtures()
        days = sorted(m.cash["date"].unique())[-320:]
        with tempfile.TemporaryDirectory() as t:
            for name, df in (("cash", m.cash), ("fo", m.fo), ("idx", m.idx)):
                (Path(t) / name).mkdir()
                for d in days:
                    sub = df[df["date"] == d]
                    if len(sub):
                        sub.to_parquet(Path(t) / name / f"{pd.Timestamp(d):%Y-%m-%d}.parquet")
            outdir = Path(t) / "o"
            old = os.environ.get("DATA_DIR")
            os.environ["DATA_DIR"] = t
            try:
                self.assertEqual(run.main(["--out", str(outdir), "--validate"]), 0)
            finally:
                os.environ.pop("DATA_DIR") if old is None else os.environ.__setitem__("DATA_DIR", old)
            self.assertTrue((outdir / "overview.json").exists())
            self.assertTrue((outdir / "validation.json").exists())


class Sensitivity(unittest.TestCase):
    def test_equal_weights_baseline_is_perfectly_stable(self):
        rng = np.random.default_rng(2)
        P = mk({f"S{i}": 100 * np.exp(np.cumsum(rng.normal(0.0004, 0.012, 300))) for i in range(30)},
               nifty=20000 * np.exp(np.cumsum(rng.normal(0.0003, 0.007, 300))), sectors={f"S{i}": f"X{i % 5}" for i in range(30)})
        R = engine.compute(P, CFG)
        out = sensitivity.run(P, R, CFG, days=20)
        self.assertEqual(len(out["variants"]), 2 * 5)                # 5 weights with data x two nudges
        for v in out["variants"].values():
            self.assertGreater(v["rank_corr"], 0.9)                  # +-25% on one weight barely reorders stocks
        self.assertGreater(out["min_rank_corr"], 0.9)


if __name__ == "__main__":
    unittest.main()


class ScreenerThresholds(unittest.TestCase):
    def test_rule_text_follows_config_and_looser_gives_more(self):
        from scores import screeners
        rng = np.random.default_rng(4)
        P = mk({f"S{i}": 100 * np.exp(np.cumsum(rng.normal(0.001, 0.012, 300))) for i in range(40)},
               nifty=20000 * np.exp(np.cumsum(rng.normal(0.0003, 0.007, 300))), sectors={f"S{i}": f"X{i % 5}" for i in range(40)})
        R = engine.compute(P, CFG)
        d = P.dates[-1]
        strict = dict(CFG["screeners"], strong_trend=95)
        loose = dict(CFG["screeners"], strong_trend=40, strong_overall=30)
        a = {s["id"]: s for s in screeners.run(P, R, d, strict)}["strong_trend"]
        b = {s["id"]: s for s in screeners.run(P, R, d, loose)}["strong_trend"]
        self.assertLessEqual(a["count"], b["count"])
        self.assertIn("95+", a["rule"])
        out = sensitivity.screener_sensitivity(P, R, CFG)
        self.assertEqual(len(out["variants"]), 2 * len(CFG["screeners"]))
