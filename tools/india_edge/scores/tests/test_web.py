import re
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))
import serve  # noqa: E402


class Serve(unittest.TestCase):
    def test_only_web_and_out_json_are_served(self):
        for ok in ("/", "/web/", "/web/index.html", "/out/overview.json"):
            self.assertTrue(serve.allowed(ok), ok)
        for bad in ("/engine.py", "/config.yaml", "/web/../engine.py", "/out/../config.yaml", "/%2e%2e/engine.py",
                    "/web/x.py", "/out/x.py", "/out/", "/tests/test_engine.py", "/README.md", "/data.py"):
            self.assertFalse(serve.allowed(bad), bad)


class Page(unittest.TestCase):
    html = (HERE / "web" / "index.html").read_text()

    def test_no_formula_or_weight_text_shipped_in_page(self):
        low = self.html.lower()
        for bad in ("weights", "config.yaml", "wmean", "rolling(", "band_strong", "min_history"):
            self.assertNotIn(bad, low, bad)

    def test_no_advice_words_in_page(self):
        low = re.sub(r"not a recommendation|not investment advice", "", self.html.lower())
        for bad in ("buy", "sell", "avoid", "stop loss", "guarantee"):
            self.assertIsNone(re.search(r"\b" + bad + r"\b", low), bad)

    def test_no_innerhtml_with_data(self):
        # data goes in through textContent only; the single innerHTML use is a static table header
        self.assertEqual(len(re.findall(r"innerHTML", self.html)), 0)

    def test_no_chained_append_bug(self):
        # Node.append() returns undefined, so `x.append(...).append(...)` throws at runtime
        self.assertIsNone(re.search(r"\.append\([^;]*\)\)?\.append\(", self.html))

    def test_font_sizes_not_tiny(self):
        sizes = [float(x) for x in re.findall(r"font-size:\s*([\d.]+)px", self.html)]
        self.assertTrue(sizes and min(sizes) >= 11)


if __name__ == "__main__":
    unittest.main()
