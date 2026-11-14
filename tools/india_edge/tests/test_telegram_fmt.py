import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import alerts as A  # noqa: E402
import telegram_fmt as F  # noqa: E402

FULL = dict(stage="Go", symbol="TCS", side="long", grade="A", score=82.4, entry=5025.0, stop=5000.6, target=5073.8,
            cause=dict(label="long_buildup", reason="Long buildup: price +2.1% with futures OI +6.4% (fresh longs being added); "
                                                    "sector-driven (sector RS +4.0 vs stock +5.0)."),
            option_plan=dict(status="ok", type="CE", strike=5000.0, expiry="2026-11-10", premium=120.0, premium_stop=85.0,
                             premium_target=190.0, lots=4, qty=2000),
            prev_stage="Ready", early_stage="confirmation")


class FormatterTests(unittest.TestCase):
    def test_full_go_message_layout(self):
        m = F.format_message(FULL).split("\n")
        self.assertEqual(len(m), 6)
        self.assertEqual(m[0], "GO | TCS LONG | A 82")
        self.assertEqual(m[1], "Entry 5025.00 | SL 5000.60 | TGT 5073.80 | 2.0R")     # (5073.8-5025)/(5025-5000.6) = 2.0
        self.assertTrue(m[2].startswith("Why: Long buildup: price +2.1%"))
        self.assertEqual(m[3], "Opt CE 5000 exp 11-10 | prem 120.00 SL 85.00 TGT 190.00 | 4 lots")
        self.assertEqual(m[4], "Stage Ready -> Go | early: confirmation")
        self.assertEqual(m[5], F.FOOT)

    def test_never_more_than_six_lines_or_100_chars_per_line(self):
        long_info = dict(FULL, cause=dict(reason="x" * 500), note="y" * 300, reasons=["z" * 300] * 5)
        for st in ("Watch", "Ready", "Go", "Vetoed"):
            m = F.format_message(dict(long_info, stage=st)).split("\n")
            self.assertLessEqual(len(m), 6, st)
            self.assertTrue(all(len(x) <= max(F.MAX_LEN, len(F.FOOT)) for x in m), st)
            self.assertEqual(m[-1], F.FOOT)

    def test_minimal_watch_without_levels_or_options(self):
        m = F.format_message(dict(stage="Watch", symbol="INFY", side="short", note="Early accumulation: delivery 1.2x.")).split("\n")
        self.assertEqual(m, ["WATCH | INFY SHORT", "Why: Early accumulation: delivery 1.2x.", F.FOOT])

    def test_go_without_levels_says_pending(self):
        m = F.format_message(dict(stage="Go", symbol="X", side="long")).split("\n")
        self.assertEqual(m[1], "Levels pending")

    def test_vetoed_lists_reasons(self):
        m = F.format_message(dict(stage="Vetoed", symbol="X", side="long", grade="B", score=51.0,
                                  reasons=["expiry day", "IV percentile 84 > 70"])).split("\n")
        self.assertEqual(m[0], "VETOED | X LONG | B 51")
        self.assertEqual(m[1], "Why not: expiry day; IV percentile 84 > 70")
        self.assertEqual(len(m), 3)

    def test_option_line_skipped_when_plan_unusable(self):
        for plan in (None, {}, dict(status="no_premium"), dict(status="no_expiry"), dict(status="ok")):
            self.assertNotIn("Opt ", F.format_message(dict(FULL, option_plan=plan)))

    def test_exit_and_kill_switch(self):
        self.assertEqual(F.format_exit(dict(symbol="TCS", side="long", reason="target", r=2.0, pnl=20000.0)).split("\n"),
                         ["EXIT | TCS LONG | target", "R +2.00 | P&L +20,000", F.FOOT])
        k = F.format_kill_switch("2 stop-losses today", "2026-10-28").split("\n")
        self.assertEqual(k[0], "HALT | 2026-10-28")
        self.assertLessEqual(len(k), 6)

    def test_no_advice_wording(self):
        for st in ("Watch", "Ready", "Go", "Vetoed"):
            t = F.format_message(dict(FULL, stage=st)).lower()
            self.assertNotIn("guarantee", t)
            self.assertIn("not investment advice", t)

    def test_stays_stubbed_by_default(self):
        calls = []
        text = F.format_message(FULL)
        self.assertFalse(A.send_telegram(text, env={}, post=lambda *a, **k: calls.append(a)))
        self.assertEqual(calls, [])

    def test_stage_changes_returns_message_and_info(self):
        items = A.stage_changes({}, {"TCS": dict(stage="Watch", symbol="TCS", side="long", grade="A", score=80.0)})
        self.assertEqual(len(items), 1)
        text, info = items[0]
        self.assertTrue(text.startswith("[WATCH]"))
        self.assertEqual(info["symbol"], "TCS")


if __name__ == "__main__":
    unittest.main()
