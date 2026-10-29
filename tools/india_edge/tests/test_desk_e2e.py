import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import morning_desk as MD  # noqa: E402
from loader import Market, load_fixtures  # noqa: E402
from run_daily import run  # noqa: E402
from timing import exec_config, in_trade_window  # noqa: E402


def short_market(since="2025-03-01"):
    m = load_fixtures()
    cut = lambda df: df[df["date"] >= pd.Timestamp(since)].reset_index(drop=True)  # noqa: E731
    # keep the warm-up history features need; the run itself replays only the last sessions
    keep = lambda df: df[df["date"] >= pd.Timestamp(since) - pd.Timedelta(days=400)].reset_index(drop=True)  # noqa: E731
    return Market(keep(m.cash), keep(m.fo), keep(m.idx), keep(m.iv), m.events, "fixtures")


class DeskHelperTests(unittest.TestCase):
    def test_strike_steps_and_atm(self):
        self.assertEqual(MD.strike_step(34), 2.5)
        self.assertEqual(MD.strike_step(100), 5)       # boundary: < 100 is 2.5, 100 falls to next band
        self.assertEqual(MD.strike_step(1731), 50)
        self.assertEqual(MD.strike_step(9000), 250)
        s = MD.suggest_strike(1731.17, "short")
        self.assertEqual((s["type"], s["atm"], s["otm1"]), ("PE", 1750.0, 1700.0))   # 1731/50=34.6 -> 35 -> 1750
        s = MD.suggest_strike(264.3, "long", "2026-10-27")
        self.assertEqual((s["type"], s["atm"], s["otm1"], s["expiry"]), ("CE", 260.0, 270.0, "2026-10-27"))
        self.assertEqual(MD.suggest_strike(34.0, "long")["atm"], 35.0)                # 34/2.5=13.6 -> 14 -> 35.0

    def test_clean_removes_nan_and_numpy(self):
        d = MD.clean({"a": np.float64("nan"), "b": np.int64(3), "c": [np.inf, 1.5], "d": pd.Timestamp("2026-10-05"),
                      "e": np.bool_(True), "f": pd.Timestamp("2026-10-05 09:30")})
        self.assertEqual(d, {"a": None, "b": 3, "c": [None, 1.5], "d": "2026-10-05", "e": True, "f": "2026-10-05 09:30"})
        json.dumps(d, allow_nan=False)


class EndToEndTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        t = Path(cls.tmp.name)
        cls.web, cls.state = t / "web", t / "out"
        cls.market = short_market()
        cls.desk = run(replay=25, out_dir=cls.web, state_dir=cls.state, market=cls.market, quiet=True)
        cls.trades = pd.read_csv(cls.state / "paper_trades.csv", parse_dates=["entry_ts", "exit_ts"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_json_written_and_strict(self):
        raw = (self.web / "morning_desk.json").read_text()
        d = json.loads(raw, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))  # rejects NaN
        for k in ("asof", "trade_date", "picks", "paper", "alerts", "base_rates", "notice", "mode"):
            self.assertIn(k, d)
        self.assertIn("Not investment advice", d["notice"])

    def test_top5_cards_complete(self):
        p = self.desk["picks"]
        self.assertTrue(1 <= len(p) <= 5)
        self.assertEqual([c["rank"] for c in p], list(range(1, len(p) + 1)))
        for c in p:
            self.assertIn(c["grade"], "ABC")
            self.assertIn(c["direction"], ("long", "short"))
            for k in ("levels", "strikes", "base_rate", "checklist", "candles", "oi", "features", "stage"):
                self.assertIn(k, c)
            self.assertEqual(c["strikes"]["type"], "CE" if c["direction"] == "long" else "PE")
            self.assertGreater(len(c["candles"]), 30)
            names = [i["name"] for i in c["checklist"]]
            self.assertIn("OI quadrant", names)
            self.assertIn("15m timing (OB/FVG pullback + BOS/engulfing)", names)
            self.assertTrue(all(i["status"] in ("pass", "fail", "pending", "unknown") for i in c["checklist"]))
            lv = c["levels"]
            if c["direction"] == "long":
                self.assertLess(lv["stop"], lv["entry_ref"])
                self.assertGreater(lv["target"], lv["entry_ref"])
            else:
                self.assertGreater(lv["stop"], lv["entry_ref"])
                self.assertLess(lv["target"], lv["entry_ref"])
            # 2R: target distance is twice the stop distance
            self.assertAlmostEqual(abs(lv["target"] - lv["entry_ref"]), 2 * abs(lv["entry_ref"] - lv["stop"]), places=6)

    def test_paper_rules_hold_over_the_replay(self):
        tr = self.trades
        cfg = exec_config()["paper"]
        self.assertGreater(len(tr), 0)
        self.assertTrue(all(in_trade_window(t) for t in tr["entry_ts"]))
        self.assertTrue((tr["status"] == "closed").all())                      # all squared off intraday
        for day, g in tr.groupby("trade_date"):
            ev = sorted([(r.entry_ts, 1) for r in g.itertuples()] + [(r.exit_ts, -1) for r in g.itertuples()],
                        key=lambda x: (x[0], x[1]))
            open_, peak = 0, 0
            for _, d in ev:
                open_ += d
                peak = max(peak, open_)
            self.assertLessEqual(peak, cfg["max_positions"], day)
            stops = g.sort_values("exit_ts")
            first_two = stops[stops["exit_reason"] == "stop"].head(cfg["max_sl_per_day"])
            if len(first_two) == cfg["max_sl_per_day"]:                       # nothing opens after the 2nd stop-out
                self.assertTrue((g["entry_ts"] <= first_two["exit_ts"].iloc[-1]).all())
        self.assertTrue(((tr["risk_amt"] / 1e6) <= 0.0201 * 1.5).all())     # <= ~2% of capital (+ compounding)
        self.assertTrue((tr["risk_amt"] > 0).all())

    def test_summary_matches_ledger_csv(self):
        s = self.desk["paper"]["summary"]
        self.assertEqual(s["closed_trades"], len(self.trades))
        self.assertAlmostEqual(s["total_pnl"], self.trades["pnl"].sum(), places=4)
        self.assertAlmostEqual(s["equity"], 1_000_000 + self.trades["pnl"].sum(), places=4)

    def test_alerts_logged_and_never_sent_by_default(self):
        files = list(self.state.glob("alerts_*.txt"))
        self.assertEqual(len(files), 1)
        text = files[0].read_text()
        self.assertIn("[WATCH]", text)
        self.assertTrue(all("not investment advice" in l for l in text.strip().splitlines()))

    def test_replay_is_deterministic(self):
        with tempfile.TemporaryDirectory() as t:
            d2 = run(replay=25, out_dir=Path(t) / "w", state_dir=Path(t) / "o", market=self.market, quiet=True)
        a = {k: v for k, v in self.desk.items() if k != "generated_at"}
        b = {k: v for k, v in d2.items() if k != "generated_at"}
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
