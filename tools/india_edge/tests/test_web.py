import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
WEB = Path(__file__).resolve().parents[1] / "web"
HTML = (WEB / "index.html").read_text(encoding="utf-8")


class DeskPageTests(unittest.TestCase):
    def test_single_file_no_build_step(self):
        srcs = re.findall(r'<script[^>]+src="([^"]+)"', HTML)
        self.assertEqual(len(srcs), 1)
        self.assertTrue(srcs[0].startswith("https://unpkg.com/lightweight-charts@"))   # pinned CDN version
        self.assertRegex(srcs[0], r"@\d+\.\d+\.\d+/")
        self.assertNotIn("<link", HTML)
        self.assertIn("morning_desk.json", HTML)

    def test_no_innerhtml_so_json_text_cannot_inject_markup(self):
        self.assertNotIn("innerHTML", HTML)
        self.assertNotIn("eval(", HTML)

    def test_shows_disclaimer_and_no_advice_wording(self):
        self.assertIn("Not investment advice", HTML)
        self.assertNotRegex(HTML.lower(), r"\b(guaranteed|sure shot|risk[- ]free)\b")

    def test_demo_json_has_every_field_the_page_reads(self):
        d = json.loads((WEB / "morning_desk.json").read_text())
        for k in ("asof", "trade_date", "mode", "source", "notice", "generated_at", "alerts"):
            self.assertIn(k, d)
        self.assertIn("nifty_close", d["market"])
        for k in ("summary", "recent", "equity"):
            self.assertIn(k, d["paper"])
        for k in ("equity", "total_pnl", "closed_trades", "win_pct", "avg_r", "profit_factor",
                  "max_drawdown", "kill_switch"):
            self.assertIn(k, d["paper"]["summary"])
        p = d["picks"][0]
        for k in ("rank", "symbol", "grade", "score", "direction", "setup", "stage", "vetoed", "sector",
                  "components", "levels", "strikes", "base_rate", "checklist", "candles", "oi", "intraday"):
            self.assertIn(k, p)
        for k in ("entry_ref", "stop", "target", "basis"):
            self.assertIn(k, p["levels"])
        for k in ("type", "atm", "expiry"):
            self.assertIn(k, p["strikes"])
        for k in ("grade", "setup", "win_pct", "expectancy_r", "n"):
            self.assertIn(k, p["base_rate"])
        self.assertEqual({"time", "open", "high", "low", "close"}, set(p["candles"][0]))
        self.assertEqual({"time", "oi", "chg_oi"}, set(p["oi"][0]))
        self.assertTrue(all(c["status"] in ("pass", "fail", "pending", "unknown") for c in p["checklist"]))


if __name__ == "__main__":
    unittest.main()
