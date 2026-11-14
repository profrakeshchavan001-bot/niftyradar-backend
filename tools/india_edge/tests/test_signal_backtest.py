"""CC4 signal backtest core: entry timing, stop/target/gap rules, capital model, option maths."""
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backtest"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sigbt as B  # noqa: E402


def world(rows, sym="AAA"):
    """rows: (open, high, low, close) per day starting 2024-01-01 (business days). prev_close = previous close."""
    d = pd.bdate_range("2024-01-01", periods=len(rows))
    o, h, l, c = (np.array(x, dtype=float) for x in zip(*rows))
    pc = np.concatenate([[c[0]], c[:-1]])
    cash = pd.DataFrame({"date": d, "symbol": sym, "open": o, "high": h, "low": l, "close": c, "prev_close": pc,
                         "volume": 1000})
    return B.World(cash)


def flat(n, px=100.0):
    return [(px, px + 1, px - 1, px)] * n


class UnderlyingRules(unittest.TestCase):
    def test_entry_is_next_open_not_signal_close(self):
        rows = flat(20) + [(110.0, 111, 109, 110)] + flat(5, 110)     # day 20 opens at 110
        w = world(rows)
        t = B.sim_underlying(w, "AAA", 19, "long", stop_dist=5.0, hold=3)
        self.assertEqual(t["entry"], 110.0)
        self.assertEqual(t["entry_idx"], 20)

    def test_long_stop_then_target_and_stop_first_when_both(self):
        rows = flat(20) + [(100, 100.5, 99.5, 100), (100, 103, 94, 98)] + flat(5)   # day 21: hits both
        w = world(rows)
        t = B.sim_underlying(w, "AAA", 19, "long", stop_dist=5.0, rr=1.0, hold=3)
        self.assertEqual((t["kind"], t["exit"]), ("stop", 95.0))

    def test_gap_through_stop_fills_at_open(self):
        rows = flat(20) + [(100, 100.5, 99.5, 100), (90, 91, 89, 90)] + flat(5, 90)
        w = world(rows)
        t = B.sim_underlying(w, "AAA", 19, "long", stop_dist=5.0, hold=3)
        self.assertEqual((t["kind"], t["exit"]), ("gap_stop", 90.0))

    def test_short_target(self):
        rows = flat(20) + [(100, 100.5, 99.5, 100), (99, 99.5, 88, 90)] + flat(5, 90)
        w = world(rows)
        t = B.sim_underlying(w, "AAA", 19, "short", stop_dist=5.0, rr=2.0, hold=3)
        self.assertEqual((t["kind"], t["exit"]), ("target", 90.0))

    def test_time_exit_on_last_day_close(self):
        rows = flat(20) + [(100, 101, 99, 100)] * 3 + flat(5)
        w = world(rows)
        t = B.sim_underlying(w, "AAA", 19, "long", stop_dist=50.0, hold=3)
        self.assertEqual((t["kind"], t["exit_idx"]), ("time", 22))


class CapitalModel(unittest.TestCase):
    def trade(self, w, e, x, pnl_px, rank=1.0):
        return dict(entry_idx=e, exit_idx=x, entry=100.0, exit=100.0 + pnl_px, risk=2.0, side="long", sym="AAA", atr=2.0,
                    rank=rank)

    def test_max_two_open_positions(self):
        w = world(flat(60))
        trades = [self.trade(w, 20, 25, 1, r) for r in (3, 2, 1)]          # three entries the same day
        out = B.run_capital(trades, w.dates[0], w.dates[-1], "stock", w)
        self.assertEqual(len(out), 2)
        self.assertEqual(sorted(out["rank"]), [2.0, 3.0])                   # best two taken

    def test_slot_frees_after_exit(self):
        w = world(flat(60))
        trades = [self.trade(w, 20, 22, 1), self.trade(w, 20, 22, 1), self.trade(w, 23, 25, 1)]
        self.assertEqual(len(B.run_capital(trades, w.dates[0], w.dates[-1], "stock", w)), 3)

    def test_risk_sizing_and_costs_reduce_pnl(self):
        w = world(flat(60))
        t = self.trade(w, 20, 22, 2.0)
        out = B.run_capital([t], w.dates[0], w.dates[-1], "stock", w)
        r = out.iloc[0]
        self.assertEqual(r["qty"], 500)            # risk would allow 750 shares (Rs 1,500 / 2.0) but the 50% notional cap (Rs 50,000 / 100) binds
        self.assertGreater(r["cost"], 0)
        self.assertLess(r["pnl"], r["gross"])

    def test_period_split_by_entry_date(self):
        w = world(flat(60))
        out = B.run_capital([self.trade(w, 20, 22, 1)], pd.Timestamp("2030-01-01"), pd.Timestamp("2031-01-01"), "stock", w)
        self.assertTrue(out.empty)

    def test_verdict_rules(self):
        few = dict(trades=5, pnl=100.0)
        ok = dict(trades=40, pnl=100.0)
        bad = dict(trades=40, pnl=-1.0)
        self.assertEqual(B.verdict(few, ok), "TOO FEW TRADES")
        self.assertEqual(B.verdict(ok, ok), "PROFITABLE")
        self.assertEqual(B.verdict(ok, bad), "NOT PROFITABLE")


class OptionMaths(unittest.TestCase):
    def test_implied_vol_round_trip(self):
        for call in (True, False):
            p = B.bs_price(100, 105, 20 / 365, 0.35, call)
            self.assertAlmostEqual(B.implied_vol(p, 100, 105, 20 / 365, call), 0.35, places=3)

    def test_no_vol_below_intrinsic(self):
        self.assertIsNone(B.implied_vol(1.0, 120, 100, 0.05, True))

    def test_bs_survives_nonpositive_spot(self):
        self.assertGreaterEqual(B.bs_price(-1.0, 100, 0.05, 0.3, False), 0.0)

    def test_option_costs_positive_and_doubled(self):
        c = B.option_costs(10.0, 12.0, 100)
        self.assertGreater(c, 0)
        self.assertEqual(B.COST_MULT, 2.0)


if __name__ == "__main__":
    unittest.main()
