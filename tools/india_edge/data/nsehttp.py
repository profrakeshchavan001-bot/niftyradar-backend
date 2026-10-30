"""Polite NSE archive downloader shared by the CC8 index scripts: browser headers, disk cache, 1-1.6 s pause, 404 remembered.
Uses curl (see Fetcher)."""
from __future__ import annotations

import random
import subprocess
import time
from pathlib import Path

try:
    import truststore
    truststore.inject_into_ssl()
except ImportError:  # pragma: no cover
    pass


HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/csv,application/zip,application/octet-stream,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/all-reports",
}


class FetchError(RuntimeError):
    pass


class Fetcher:
    """Downloads through the curl binary: python's TLS stack re-verifies nsearchives' incomplete cert chain on every new
    connection (10+ s each on Windows), curl/schannel takes ~0.4 s. Still one request at a time with a 1-2 s pause."""

    def __init__(self, cache: Path, delay=(1.0, 1.6)):
        self.cache, self.delay = Path(cache), delay
        self.cache.mkdir(parents=True, exist_ok=True)
        self.requests = 0

    def get(self, url: str, name: str):
        """Bytes from cache or network; None when NSE answers 404 (cached as an empty .404 marker)."""
        f, miss = self.cache / name, self.cache / (name + ".404")
        if f.exists():
            return f.read_bytes()
        if miss.exists():
            return None
        wait = 4.0
        out = None
        tmp = f.with_suffix(f.suffix + ".part")
        for _ in range(5):
            time.sleep(random.uniform(*self.delay))
            self.requests += 1
            cmd = ["curl", "-sS", "-m", "90", "-A", HEADERS["User-Agent"], "-e", HEADERS["Referer"],
                   "-H", "Accept-Language: en-US,en;q=0.9", "-o", str(tmp), "-w", "%{http_code}", url]
            try:
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                code = out.stdout.strip()
            except (subprocess.TimeoutExpired, OSError):
                code = "000"
            if code == "404":
                tmp.unlink(missing_ok=True)
                miss.write_bytes(b"")
                return None
            if code == "200" and tmp.exists() and tmp.stat().st_size > 0:
                tmp.replace(f)
                return f.read_bytes()
            tmp.unlink(missing_ok=True)
            time.sleep(wait)
            wait *= 2
        raise FetchError(f"giving up on {url}: {out.stderr.strip()[:120] if out is not None else ''} code={code}")
