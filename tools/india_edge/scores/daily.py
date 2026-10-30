"""Daily runner for the owner's PC (Windows Task Scheduler). One command, safe to run twice.

    python -m scores.daily [--data-dir D] [--asof YYYY-MM-DD] [--no-fetch] [--force] [--dry-run]

Steps: lockfile -> download missing bhavcopy days (polite, existing fetcher) -> data-health gate ->
scores, screeners, rotation, fear/greed -> JSON + static site -> keep 30 days of history -> status.json.
Idempotent: if the inputs and code are unchanged for that day, a re-run does nothing.
Failure alert (optional): set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in the environment. Nothing secret
is stored in the repo or written to logs. Exit codes: 0 ok or up to date, 1 failed, 3 another run is active.
Research and analytics only. Never places orders.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import shutil
import sys
import time
import traceback
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

OK, FAILED, LOCKED = 0, 1, 3
KEEP_DAYS = 30
LOG_DAYS = 60
LOCK_STALE_SECONDS = 3 * 3600


class RunError(Exception):
    pass


# ------------------------------------------------------------------ lock
class Lock:
    """Exclusive lockfile (O_EXCL). A lock older than `stale` seconds is taken over (crashed run)."""

    def __init__(self, path: Path, stale: int = LOCK_STALE_SECONDS, now=time.time):
        self.path, self.stale, self.now, self.held = path, stale, now, False

    def acquire(self) -> bool:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w") as fh:
                    fh.write(json.dumps({"pid": os.getpid(), "t": self.now()}))
                self.held = True
                return True
            except FileExistsError:
                try:
                    age = self.now() - json.loads(self.path.read_text())["t"]
                except (OSError, ValueError, KeyError):
                    age = self.stale + 1                          # unreadable lock counts as stale
                if age <= self.stale:
                    return False
                try:
                    self.path.unlink()                            # stale: take over, retry once
                except OSError:
                    return False
        return False

    def release(self) -> None:
        if self.held:
            try:
                self.path.unlink()
            except OSError:
                pass
            self.held = False


# ------------------------------------------------------------------ helpers
def setup_log(logdir: Path, today: str, console: bool = True) -> logging.Logger:
    logdir.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - LOG_DAYS * 86400
    for f in logdir.glob("daily_*.log"):
        try:
            if f.stat().st_mtime < cutoff:
                f.unlink()
        except OSError:
            pass
    lg = logging.getLogger("scores.daily")
    lg.setLevel(logging.INFO)
    for h in list(lg.handlers):
        lg.removeHandler(h)
        h.close()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    fh = logging.FileHandler(logdir / f"daily_{today}.log", encoding="utf-8")
    fh.setFormatter(fmt)
    lg.addHandler(fh)
    if console:
        sh = logging.StreamHandler(sys.stdout)
        sh.setFormatter(fmt)
        lg.addHandler(sh)
    return lg


def _hash_files(paths) -> str:
    h = hashlib.sha256()
    for p in paths:
        h.update(p.read_bytes() if p.exists() else b"-")
    return h.hexdigest()


def fingerprint(data_dir: Path, asof: str, fundamentals: Path | None) -> str:
    """Cheap, stable: code + config + the newest day files + file counts + fundamentals file."""
    h = hashlib.sha256()
    h.update(asof.encode())
    h.update(_hash_files(sorted(HERE.glob("*.py")) + [HERE / "config.yaml", ROOT / "sectors.json"]).encode())
    for name in ("cash", "fo", "idx"):
        d = data_dir / name
        files = sorted(d.glob("*.parquet")) if d.is_dir() else []
        h.update(f"{name}:{len(files)}".encode())
        for f in files[-3:]:
            h.update(f"{f.name}:{f.stat().st_size}".encode())
    if fundamentals and fundamentals.exists():
        h.update(_hash_files([fundamentals]).encode())
    return h.hexdigest()


def missing_days(data_dir: Path, now: datetime, lookback: int = 10) -> list[pd.Timestamp]:
    """Weekdays in the last `lookback` days with no stored cash file (holidays show up here too; the
    fetcher remembers 404 holidays, so it is cheap to ask again)."""
    out = []
    for i in range(lookback, -1, -1):
        d = pd.Timestamp(now.date()) - pd.Timedelta(days=i)
        if d.weekday() < 5 and not (data_dir / "cash" / f"{d:%Y-%m-%d}.parquet").exists():
            out.append(d)
    return out


def default_fetch(start, end, log=print):
    from data.fetch import fetch_range  # noqa: PLC0415
    return fetch_range(start, end, log=log)


def telegram_notify(text: str, env=os.environ, opener=urllib.request.urlopen) -> bool:
    token, chat = env.get("TELEGRAM_BOT_TOKEN"), env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return False
    body = urllib.parse.urlencode({"chat_id": chat, "text": text[:900]}).encode()
    req = urllib.request.Request(f"https://api.telegram.org/bot{token}/sendMessage", data=body)
    try:
        with opener(req, timeout=20) as r:
            return 200 <= getattr(r, "status", 200) < 300
    except Exception:
        return False


def _write_site(out_root: Path, asof: str, names: list[str], html: str) -> None:
    site = out_root / "site"
    tmp = out_root / "site.tmp"
    shutil.rmtree(tmp, ignore_errors=True)
    (tmp / "data").mkdir(parents=True)
    for n in names:
        shutil.copy2(out_root / f"{n}.json", tmp / "data" / f"{n}.json")
    page = html.replace('<meta name="data-base" content="../out/">', '<meta name="data-base" content="data/">')
    (tmp / "index.html").write_text(page, encoding="utf-8")
    shutil.rmtree(site, ignore_errors=True)
    os.replace(tmp, site)


def prune_history(history: Path, keep: int) -> list[str]:
    dirs = sorted(d for d in history.iterdir() if d.is_dir() and len(d.name) == 10) if history.is_dir() else []
    gone = []
    for d in dirs[:-keep] if keep > 0 else dirs:
        shutil.rmtree(d, ignore_errors=True)
        gone.append(d.name)
    return gone


# ------------------------------------------------------------------ main run
def run(args, now: datetime | None = None, fetcher=None, notify=None, env=os.environ) -> int:
    now = now or datetime.now()
    out_root = Path(args.out).resolve()
    log = setup_log(out_root / "logs", f"{now:%Y-%m-%d}", console=not getattr(args, "quiet", False))
    notify = notify or telegram_notify
    fetcher = fetcher or default_fetch
    t0 = time.time()
    status = {"started": now.isoformat(timespec="seconds"), "result": "running"}
    lock = Lock(out_root / ".daily.lock", now=time.time)
    if not lock.acquire():
        log.warning("another run is active (fresh lockfile); exiting without doing anything")
        return LOCKED
    try:
        data_dir = Path(args.data_dir).resolve()
        os.environ["DATA_DIR"] = str(data_dir)
        log.info("start data_dir=%s out=%s", data_dir, out_root)
        if args.dry_run:
            miss = missing_days(data_dir, now)
            log.info("dry run: would download %d missing weekday(s): %s; then score the latest day, write history/ and site/. Nothing written.",
                     len(miss), ", ".join(f"{d:%Y-%m-%d}" for d in miss) or "none")
            return OK
        if not args.no_fetch:
            miss = missing_days(data_dir, now)
            if miss:
                try:
                    log.info("download: %d missing day(s) %s..%s", len(miss), f"{miss[0]:%Y-%m-%d}", f"{miss[-1]:%Y-%m-%d}")
                    st = fetcher(miss[0], miss[-1], log=log.info)
                    log.info("download result: %s", st)
                except Exception as exc:                          # network trouble must not kill a run that has data
                    log.warning("download failed (%s); continuing with stored data", type(exc).__name__)
        from loader import load_market  # noqa: PLC0415
        from scores import build, data  # noqa: PLC0415
        try:
            m = load_market()
        except SystemExit as exc:
            raise RunError(f"no usable market data: {exc}")
        P = data.from_market(m, data.load_sectors(), data.read_fundamentals(args.fundamentals))
        P.source = m.source
        asof = pd.Timestamp(args.asof) if args.asof else P.dates[-1]
        a = f"{asof:%Y-%m-%d}"
        stale = (pd.Timestamp(now.date()) - asof).days
        if args.asof is None and stale > args.max_stale_days:
            raise RunError(f"latest bar is {a}, {stale} days old (limit {args.max_stale_days}); download probably failed")
        fp = fingerprint(data_dir, a, Path(args.fundamentals) if args.fundamentals else None)
        hist = out_root / "history" / a
        man = hist / "manifest.json"
        if not args.force and man.exists() and json.loads(man.read_text()).get("fingerprint") == fp:
            log.info("up to date for %s (inputs and code unchanged); nothing to do", a)
            status.update(result="up_to_date", asof=a)
            return OK
        out, R = build.build(P, day=asof)
        grade = out["health"]["grade"]
        if grade == "bad":
            raise RunError("data health is BAD: " + "; ".join(out["health"]["notes"][:3]))
        names = build.write(out, out_root)                        # latest = files in out_root
        tmp = out_root / "history" / f".{a}.tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        for n in names:
            shutil.copy2(out_root / f"{n}.json", tmp / f"{n}.json")
        (tmp / "manifest.json").write_text(json.dumps({"fingerprint": fp, "asof": a, "written": now.isoformat(timespec="seconds"),
                                                       "health": grade, "scored": out["overview"]["scored"], "source": P.source}, indent=1))
        shutil.rmtree(hist, ignore_errors=True)
        os.replace(tmp, hist)
        _write_site(out_root, a, names, (HERE / "web" / "index.html").read_text(encoding="utf-8"))
        gone = prune_history(out_root / "history", KEEP_DAYS)
        log.info("ok asof=%s scored=%d health=%s history_pruned=%s", a, out["overview"]["scored"], grade, gone or "none")
        status.update(result="ok", asof=a, health=grade, scored=out["overview"]["scored"])
        return OK
    except Exception as exc:
        msg = f"{type(exc).__name__}: {str(exc)[:300]}"
        log.error("FAILED %s", msg)
        log.debug("trace %s", traceback.format_exc())
        status.update(result="failed", error=msg)
        sent = notify(f"NiftyRadar daily scores FAILED on {now:%Y-%m-%d %H:%M}: {msg}", env=env) if env.get("TELEGRAM_BOT_TOKEN") else False
        log.info("failure alert %s", "sent" if sent else "not sent (TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set or send failed)")
        return FAILED
    finally:
        status["seconds"] = round(time.time() - t0, 1)
        if not args.dry_run:
            try:
                (out_root / "status.json").write_text(json.dumps(status, indent=1))
            except OSError:
                pass
        lock.release()


def parse(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--data-dir", default=os.environ.get("DATA_DIR") or str(ROOT / "data"),
                    help="folder with cash/ fo/ idx/ day files (default tools/india_edge/data; never the synthetic fixtures)")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--asof", help="score this date instead of the latest")
    ap.add_argument("--fundamentals", default=None, help="optional fundamentals.csv")
    ap.add_argument("--no-fetch", action="store_true", help="do not download, use stored data")
    ap.add_argument("--force", action="store_true", help="recompute even if inputs are unchanged")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-stale-days", type=int, default=5)
    ap.add_argument("--quiet", action="store_true")
    return ap.parse_args(argv)


def main(argv=None) -> int:
    return run(parse(argv))


if __name__ == "__main__":
    sys.exit(main())
