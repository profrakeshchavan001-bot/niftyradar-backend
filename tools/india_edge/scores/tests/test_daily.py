import json
import os
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path

import pandas as pd

from helpers import ROOT  # noqa: F401  (puts tools/india_edge on sys.path)
from scores import daily

NOW = datetime(2026, 10, 29, 10, 0)
_FIX = {}


def fixture_days(last_n=130, symbols=None):
    if "m" not in _FIX:
        from loader import load_fixtures
        _FIX["m"] = load_fixtures()
    m = _FIX["m"]
    days = sorted(m.cash["date"].unique())[-last_n:]
    return m, days


def write_days(root: Path, days, symbols=None):
    m, _ = fixture_days()
    for name, df in (("cash", m.cash), ("fo", m.fo), ("idx", m.idx)):
        (root / name).mkdir(parents=True, exist_ok=True)
        for d in days:
            sub = df[df["date"] == d]
            if symbols is not None and name != "idx":
                sub = sub[sub["symbol"].isin(symbols)]
            if len(sub):
                sub.to_parquet(root / name / f"{pd.Timestamp(d):%Y-%m-%d}.parquet")


class Base(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.root = Path(self.t.name)
        self.data, self.out = self.root / "data", self.root / "out"
        self.env_old = os.environ.get("DATA_DIR")
        self.fetch_calls, self.notes = [], []

    def tearDown(self):
        if self.env_old is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.env_old
        self.t.cleanup()

    def go(self, *extra, now=NOW, fetcher=None, env=None):
        a = daily.parse(["--data-dir", str(self.data), "--out", str(self.out), "--quiet", *extra])

        def fake_fetch(s, e, log=print):
            self.fetch_calls.append((s, e))
            return {"downloaded": 0}
        return daily.run(a, now=now, fetcher=fetcher or fake_fetch, notify=lambda text, env=None: self.notes.append(text) or True,
                         env={} if env is None else env)

    def status(self):
        return json.loads((self.out / "status.json").read_text())


class Happy(Base):
    def test_first_run_writes_everything_and_second_run_is_a_noop(self):
        write_days(self.data, fixture_days()[1])
        self.assertEqual(self.go(), daily.OK)
        st = self.status()
        self.assertEqual((st["result"], st["asof"]), ("ok", "2026-10-28"))
        for n in ("overview", "scores", "screeners", "rotation", "feargreed", "health"):
            self.assertTrue((self.out / f"{n}.json").exists(), n)
            json.loads((self.out / "history" / "2026-10-28" / f"{n}.json").read_text())
            self.assertTrue((self.out / "site" / "data" / f"{n}.json").exists(), n)
        man = self.out / "history" / "2026-10-28" / "manifest.json"
        m1 = man.stat().st_mtime_ns
        time.sleep(0.02)
        self.assertEqual(self.go(), daily.OK)
        self.assertEqual(self.status()["result"], "up_to_date")
        self.assertEqual(man.stat().st_mtime_ns, m1)                      # idempotent: nothing rewritten
        self.go("--force")
        self.assertEqual(self.status()["result"], "ok")
        self.assertGreater(man.stat().st_mtime_ns, m1)
        self.assertFalse((self.out / ".daily.lock").exists())             # lock released

    def test_site_is_static_and_contains_no_formulas(self):
        write_days(self.data, fixture_days()[1])
        self.go()
        site = self.out / "site"
        html = (site / "index.html").read_text()
        self.assertIn('<meta name="data-base" content="data/">', html)
        files = [p.name for p in site.rglob("*") if p.is_file()]
        self.assertFalse([f for f in files if f.endswith((".py", ".yaml", ".yml"))])
        blob = " ".join(p.read_text() for p in (site / "data").glob("*.json")).lower()
        for bad in ("weight", "formula", "wmean", "band_strong"):
            self.assertNotIn(bad, blob)

    def test_new_day_creates_new_history_and_old_is_kept(self):
        days = fixture_days()[1]
        write_days(self.data, days[:-1])
        self.go(now=datetime(2026, 10, 28, 10))
        self.assertEqual(self.status()["asof"], "2026-10-27")
        write_days(self.data, days[-1:])
        self.go()
        self.assertEqual(self.status()["asof"], "2026-10-28")
        self.assertEqual(sorted(p.name for p in (self.out / "history").iterdir()), ["2026-10-27", "2026-10-28"])

    def test_history_pruned_to_keep_days(self):
        write_days(self.data, fixture_days()[1])
        hist = self.out / "history"
        for d in ("2026-01-02", "2026-01-05", "2026-01-06", "2026-01-07"):
            (hist / d).mkdir(parents=True)
        old = daily.KEEP_DAYS
        daily.KEEP_DAYS = 3
        try:
            self.go()
        finally:
            daily.KEEP_DAYS = old
        self.assertEqual(sorted(p.name for p in hist.iterdir()), ["2026-01-06", "2026-01-07", "2026-10-28"])

    def test_downloads_only_missing_weekdays_and_survives_fetch_failure(self):
        write_days(self.data, fixture_days()[1])

        def boom(s, e, log=print):
            raise ConnectionError("nse down")
        self.assertEqual(self.go(fetcher=boom), daily.OK)                # data exists, so a failed download is only a warning
        self.assertEqual(self.go("--no-fetch", "--force"), daily.OK)
        self.assertEqual(self.fetch_calls, [])                            # --no-fetch never calls the fetcher
        self.go("--force")
        s, e = self.fetch_calls[0]
        self.assertEqual((s.weekday() < 5, e.weekday() < 5), (True, True))
        self.assertGreaterEqual(s, pd.Timestamp("2026-10-19"))            # within the 10-day lookback only

    def test_dry_run_writes_nothing_but_the_log(self):
        write_days(self.data, fixture_days()[1])
        self.assertEqual(self.go("--dry-run"), daily.OK)
        self.assertEqual(sorted(p.name for p in self.out.iterdir()), ["logs"])
        self.assertEqual(self.fetch_calls, [])


class Lockfile(Base):
    def test_fresh_lock_blocks_and_is_left_alone(self):
        write_days(self.data, fixture_days()[1])
        self.out.mkdir(parents=True)
        lock = self.out / ".daily.lock"
        lock.write_text(json.dumps({"pid": 1, "t": time.time()}))
        self.assertEqual(self.go(), daily.LOCKED)
        self.assertTrue(lock.exists())
        self.assertFalse((self.out / "history").exists())
        self.assertEqual(self.notes, [])                                  # overlapping run is not an alert

    def test_stale_lock_is_taken_over(self):
        write_days(self.data, fixture_days()[1])
        self.out.mkdir(parents=True)
        (self.out / ".daily.lock").write_text(json.dumps({"pid": 1, "t": time.time() - 5 * 3600}))
        self.assertEqual(self.go(), daily.OK)
        self.assertFalse((self.out / ".daily.lock").exists())

    def test_corrupt_lock_counts_as_stale(self):
        write_days(self.data, fixture_days()[1])
        self.out.mkdir(parents=True)
        (self.out / ".daily.lock").write_text("not json")
        self.assertEqual(self.go(), daily.OK)

    def test_lock_released_after_failure(self):
        self.data.mkdir()
        self.assertEqual(self.go(), daily.FAILED)
        self.assertFalse((self.out / ".daily.lock").exists())

    def test_lock_unit(self):
        a = daily.Lock(self.root / "l")
        self.assertTrue(a.acquire())
        self.assertFalse(daily.Lock(self.root / "l").acquire())
        a.release()
        self.assertTrue(daily.Lock(self.root / "l").acquire())


class Failures(Base):
    def test_empty_data_fails_with_alert_and_status(self):
        self.data.mkdir()
        self.assertEqual(self.go(env={"TELEGRAM_BOT_TOKEN": "SECRETTOKEN123", "TELEGRAM_CHAT_ID": "42"}), daily.FAILED)
        self.assertEqual(self.status()["result"], "failed")
        self.assertEqual(len(self.notes), 1)
        self.assertNotIn("SECRETTOKEN123", self.notes[0])
        log = next((self.out / "logs").glob("daily_*.log")).read_text()
        self.assertNotIn("SECRETTOKEN123", log)

    def test_no_alert_when_telegram_not_configured(self):
        self.data.mkdir()
        self.go()
        self.assertEqual(self.notes, [])
        self.assertIn("not sent", next((self.out / "logs").glob("daily_*.log")).read_text())

    def test_no_alert_on_success(self):
        write_days(self.data, fixture_days()[1])
        self.go(env={"TELEGRAM_BOT_TOKEN": "x", "TELEGRAM_CHAT_ID": "1"})
        self.assertEqual(self.notes, [])

    def test_bad_health_blocks_publishing(self):
        write_days(self.data, fixture_days()[1], symbols=["TCS", "INFY", "SBIN"])      # 3 stocks: below the 5-stock floor
        self.assertEqual(self.go(), daily.FAILED)
        self.assertIn("health is BAD", self.status()["error"])
        self.assertFalse((self.out / "site").exists())                    # nothing half-published

    def test_stale_data_fails(self):
        write_days(self.data, fixture_days()[1])
        self.assertEqual(self.go(now=datetime(2026, 12, 1, 10)), daily.FAILED)
        self.assertIn("days old", self.status()["error"])
        self.assertEqual(self.go("--asof", "2026-10-28", now=datetime(2026, 12, 1, 10)), daily.OK)   # explicit date is allowed

    def test_old_logs_pruned(self):
        write_days(self.data, fixture_days()[1])
        logs = self.out / "logs"
        logs.mkdir(parents=True)
        old = logs / "daily_2025-01-01.log"
        old.write_text("x")
        t = time.time() - 90 * 86400
        os.utime(old, (t, t))
        self.go()
        self.assertFalse(old.exists())


class Telegram(unittest.TestCase):
    def test_not_configured_makes_no_request(self):
        called = []
        self.assertFalse(daily.telegram_notify("hi", env={}, opener=lambda *a, **k: called.append(1)))
        self.assertEqual(called, [])

    def test_request_shape_and_text_truncated(self):
        seen = {}

        class R:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def opener(req, timeout=0):
            seen["url"], seen["body"] = req.full_url, req.data.decode()
            return R()
        ok = daily.telegram_notify("x" * 5000, env={"TELEGRAM_BOT_TOKEN": "T", "TELEGRAM_CHAT_ID": "9"}, opener=opener)
        self.assertTrue(ok)
        self.assertEqual(seen["url"], "https://api.telegram.org/botT/sendMessage")
        self.assertIn("chat_id=9", seen["body"])
        self.assertLess(len(seen["body"]), 1100)

    def test_network_error_returns_false(self):
        def opener(req, timeout=0):
            raise OSError("down")
        self.assertFalse(daily.telegram_notify("x", env={"TELEGRAM_BOT_TOKEN": "T", "TELEGRAM_CHAT_ID": "9"}, opener=opener))


class Fingerprint(Base):
    def test_changes_with_asof_and_new_files(self):
        write_days(self.data, fixture_days()[1][:-1])
        a = daily.fingerprint(self.data, "2026-10-27", None)
        self.assertEqual(a, daily.fingerprint(self.data, "2026-10-27", None))
        self.assertNotEqual(a, daily.fingerprint(self.data, "2026-10-28", None))
        write_days(self.data, fixture_days()[1][-1:])
        self.assertNotEqual(a, daily.fingerprint(self.data, "2026-10-27", None))
        f = self.root / "f.csv"
        f.write_text("a")
        b = daily.fingerprint(self.data, "x", f)
        f.write_text("b")
        self.assertNotEqual(b, daily.fingerprint(self.data, "x", f))


if __name__ == "__main__":
    unittest.main()
