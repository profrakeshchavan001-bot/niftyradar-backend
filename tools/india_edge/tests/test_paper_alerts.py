import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import alerts as A  # noqa: E402
from paper_ledger import PaperLedger  # noqa: E402
from timing import exec_config  # noqa: E402

DAY = "2026-10-05"


def cfg(**kw):
    c = exec_config()
    c["paper"] = {**c["paper"], "capital": 1_000_000, "risk_pct": 1.0, **kw}
    return c


def sig(sym="TCS", side="long", entry=1000.0, stop=990.0, target=1020.0):
    return dict(symbol=sym, side=side, entry=entry, stop=stop, target=target, trigger="bos")


class LedgerTests(unittest.TestCase):
    def test_sizing_one_percent_risk(self):
        # 1% of 1,000,000 = 10,000 risk; per-share risk 10 -> 1000 shares
        L = PaperLedger(cfg=cfg())
        self.assertEqual(L.size(1000, 990), (1000, 10_000.0))
        self.assertEqual(L.size(1000, 1010), (1000, 10_000.0))

    def test_risk_clamped_to_two_percent(self):
        L = PaperLedger(cfg=cfg(risk_pct=5.0))
        self.assertEqual(L.size(1000, 990), (2000, 20_000.0))
        self.assertEqual(PaperLedger(cfg=cfg(risk_pct=0.2)).size(1000, 990), (1000, 10_000.0))

    def test_target_and_stop_pnl(self):
        L = PaperLedger(cfg=cfg())
        L.open_trade(DAY, sig(), "2026-10-05 10:30")
        L.on_bar("TCS", "2026-10-05 10:45", 1005, 1021, 1003, 1019)
        t = L.trades_df().iloc[0]
        self.assertEqual((t["exit_reason"], t["pnl"], t["r"]), ("target", 20_000.0, 2.0))  # 20*1000
        L.open_trade(DAY, sig("INFY"), "2026-10-05 11:00")
        L.on_bar("INFY", "2026-10-05 11:15", 1000, 1002, 989, 995)
        t = L.trades_df().iloc[1]
        self.assertEqual((t["exit_reason"], t["pnl"], t["r"]), ("stop", -10_200.0, -1.0))  # qty 1020 after win

    def test_short_mirror(self):
        L = PaperLedger(cfg=cfg())
        L.open_trade(DAY, sig(side="short", stop=1010.0, target=980.0), "t")
        L.on_bar("TCS", "t2", 995, 996, 979, 981)
        t = L.trades_df().iloc[0]
        self.assertEqual((t["exit_reason"], t["pnl"], t["r"]), ("target", 20_000.0, 2.0))

    def test_stop_wins_when_both_levels_hit_in_one_bar(self):
        L = PaperLedger(cfg=cfg())
        L.open_trade(DAY, sig(), "t")
        L.on_bar("TCS", "t2", 1000, 1030, 980, 1000)
        self.assertEqual(L.trades_df().iloc[0]["exit_reason"], "stop")

    def test_gap_fills_at_open(self):
        L = PaperLedger(cfg=cfg())
        L.open_trade(DAY, sig(), "t")
        L.on_bar("TCS", "t2", 1030, 1031, 1029, 1030)   # opens above target
        t = L.trades_df().iloc[0]
        self.assertEqual((t["exit"], t["r"], t["pnl"]), (1030.0, 3.0, 30_000.0))
        L2 = PaperLedger(cfg=cfg())
        L2.open_trade(DAY, sig(), "t")
        L2.on_bar("TCS", "t2", 960, 965, 950, 955)      # opens below stop
        self.assertEqual(L2.trades_df().iloc[0]["pnl"], -40_000.0)

    def test_max_two_positions_and_no_duplicate_symbol(self):
        L = PaperLedger(cfg=cfg())
        self.assertIsNotNone(L.open_trade(DAY, sig("A"), "t"))
        self.assertIsNone(L.open_trade(DAY, sig("A"), "t"))        # same symbol
        self.assertIsNotNone(L.open_trade(DAY, sig("B"), "t"))
        self.assertIsNone(L.open_trade(DAY, sig("C"), "t"))        # third position
        self.assertEqual(L.can_open(DAY, "C")[1], "max 2 positions open")

    def test_kill_switch_after_two_stop_losses(self):
        L = PaperLedger(cfg=cfg())
        for s in ("A", "B"):
            L.open_trade(DAY, sig(s), "t")
            L.on_bar(s, "t2", 1000, 1001, 989, 990)
        self.assertEqual(L.stops_today(DAY), 2)
        halted, why = L.kill_switch(DAY)
        self.assertTrue(halted)
        self.assertIsNone(L.open_trade(DAY, sig("C"), "t"))
        self.assertFalse(L.kill_switch("2026-10-06")[0])           # fresh day, switch resets

    def test_kill_switch_on_daily_loss(self):
        L = PaperLedger(cfg=cfg(max_sl_per_day=10, daily_loss_pct=3.0))
        L.open_trade(DAY, sig(), "t")
        L.on_bar("TCS", "t2", 960, 965, 950, 955)   # -40 * 1000 = -40,000 <= -30,000
        halted, why = L.kill_switch(DAY)
        self.assertTrue(halted)
        self.assertIn("daily loss", why)

    def test_slippage_reduces_size(self):
        # long entry 1000 -> 1001 with 0.1% slippage; per-share risk 11 -> floor(10000/11) = 909
        L = PaperLedger(cfg=cfg(slippage_pct=0.1))
        L.open_trade(DAY, sig(), "t")
        t = L.trades_df().iloc[0]
        self.assertAlmostEqual(t["entry"], 1001.0)
        self.assertEqual(t["qty"], 909)

    def test_square_off_and_summary(self):
        L = PaperLedger(cfg=cfg())
        L.open_trade(DAY, sig("A"), "t")
        L.on_bar("A", "t2", 1000, 1021, 1000, 1020)          # +20,000
        L.open_trade(DAY, sig("B"), "t")                       # qty 1020 (capital 1,020,000)
        L.on_bar("B", "t3", 1000, 1001, 989, 990)              # -10,200
        L.open_trade(DAY, sig("C"), "t")
        self.assertEqual(len(L.square_off("eod", {"C": 1000.0})), 1)
        s = L.summary(DAY)
        self.assertEqual((s["closed_trades"], s["open_trades"]), (3, 0))
        self.assertAlmostEqual(s["total_pnl"], 9_800.0)
        self.assertAlmostEqual(s["win_pct"], 100 / 3, places=6)   # C closed flat: not a win
        self.assertAlmostEqual(s["profit_factor"], 20_000 / 10_200, places=6)
        self.assertAlmostEqual(s["max_drawdown"], 10_200.0)

    def test_csv_export_and_persistence(self):
        with tempfile.TemporaryDirectory() as t:
            db = Path(t) / "p.sqlite"
            L = PaperLedger(db, cfg=cfg())
            L.open_trade(DAY, sig(), "t", {"grade": "A", "setup": "trend", "score": 80})
            L.db.close()
            L2 = PaperLedger(db, cfg=cfg())
            self.assertEqual(len(L2.open_trades()), 1)
            out = L2.export_csv(Path(t) / "t.csv")
            self.assertEqual(pd.read_csv(out).iloc[0]["grade"], "A")


class AlertTests(unittest.TestCase):
    def info(self, stage, **kw):
        return {"stage": stage, "symbol": "TCS", "side": "long", "grade": "A", "score": 82.0,
                "entry": 5025.0, "stop": 5000.6, "target": 5073.8, **kw}

    def test_transitions_emit_once(self):
        m = A.stage_alerts({}, {"TCS": self.info("Watch")})
        self.assertEqual(len(m), 1)
        self.assertTrue(m[0].startswith("[WATCH]"))
        self.assertEqual(A.stage_alerts({"TCS": "Watch"}, {"TCS": self.info("Watch")}), [])
        r = A.stage_alerts({"TCS": "Watch"}, {"TCS": self.info("Ready")})
        self.assertTrue(r[0].startswith("[READY]"))
        g = A.stage_alerts({"TCS": "Ready"}, {"TCS": self.info("Go")})
        self.assertIn("paper entry 5025.00, SL 5000.60, target 5073.80", g[0])
        self.assertTrue(g[0].startswith("[GO]"))

    def test_no_message_when_stage_goes_backwards(self):
        self.assertEqual(A.stage_alerts({"TCS": "Go"}, {"TCS": self.info("Ready")}), [])

    def test_veto_message_carries_reason(self):
        m = A.stage_alerts({"TCS": "Watch"}, {"TCS": self.info("Vetoed", reasons=["expiry day"])})
        self.assertIn("[VETOED]", m[0])
        self.assertIn("expiry day", m[0])

    def test_every_message_has_paper_disclaimer(self):
        for st in ("Watch", "Ready", "Go"):
            self.assertIn("not investment advice", A.stage_alerts({}, {"TCS": self.info(st)})[0])

    def test_stage_mapping(self):
        self.assertEqual([A.stage_of(s) for s in ("none", "zone", "ready", "go")],
                         ["Watch", "Watch", "Ready", "Go"])
        self.assertEqual(A.stage_of("go", vetoed=True), "Vetoed")


class TelegramStubTests(unittest.TestCase):
    def test_disabled_by_default_sends_nothing(self):
        calls = []
        self.assertFalse(A.send_telegram("hi", env={}, post=lambda *a, **k: calls.append(a)))
        self.assertFalse(A.send_telegram("hi", env={"TELEGRAM_ENABLED": "false", "TELEGRAM_BOT_TOKEN": "x",
                                                    "TELEGRAM_CHAT_ID": "1"}, post=lambda *a, **k: calls.append(a)))
        self.assertEqual(calls, [])

    def test_enabled_needs_credentials(self):
        calls = []
        self.assertFalse(A.send_telegram("hi", env={"TELEGRAM_ENABLED": "true"}, post=lambda *a, **k: calls.append(a)))
        self.assertEqual(calls, [])

    def test_enabled_posts_once(self):
        calls = []

        class R:
            ok = True

        def post(url, data=None, timeout=None):
            calls.append((url, data))
            return R()

        env = {"TELEGRAM_ENABLED": "true", "TELEGRAM_BOT_TOKEN": "TOK", "TELEGRAM_CHAT_ID": "42"}
        self.assertTrue(A.send_telegram("hello", env=env, post=post))
        self.assertEqual(calls, [("https://api.telegram.org/botTOK/sendMessage", {"chat_id": "42", "text": "hello"})])
        self.assertEqual(A.dispatch(["a", "b"], env=env, post=post), 2)


if __name__ == "__main__":
    unittest.main()
