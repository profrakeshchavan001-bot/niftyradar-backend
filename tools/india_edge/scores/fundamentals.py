"""Fundamentals pipeline: yfinance (ratios) + NSE (promoter holding, pledge) -> fundamentals.csv.

    python -m scores.fundamentals --from-data --out fundamentals.csv          # real run (on your PC)
    python -m scores.fundamentals --symbols TCS,INFY --dry-run                # plan only, no network, no writes
    python -m scores.fundamentals --probe TCS                                 # print raw field names, write nothing
    python -m scores.fundamentals --validate fundamentals.csv                 # schema check only

Polite: browser headers, cookie warm-up, 1.5 s between requests, retries with backoff, per-symbol
JSON cache (resumable and idempotent: a re-run only fetches what is missing or stale, and the CSV is
byte-identical for identical inputs). The CSV is a SNAPSHOT (not point-in-time): the scores engine uses
it for today's score only and validation never sees it. No network is touched at import or in tests.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import numpy as np
import pandas as pd

SCHEMA = ["symbol", "roe", "debt_equity", "profit_margin", "pe", "pb", "promoter_pct", "promoter_pledge_pct"]
RANGES = {"roe": (-100, 200), "debt_equity": (0, 50), "profit_margin": (-200, 100), "pe": (0, 2000),
          "pb": (0, 200), "promoter_pct": (0, 100), "promoter_pledge_pct": (0, 100)}
NSE_HOME = "https://www.nseindia.com"
NSE_HOLDING = NSE_HOME + "/api/corporate-share-holdings-master?index=equities&symbol={sym}"
NSE_PLEDGE = NSE_HOME + "/api/corporate-pledgedata?index=equities&symbol={sym}"
HEADERS = {"User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
           "Accept": "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9",
           "Referer": NSE_HOME + "/companies-listing/corporate-filings-shareholding-pattern"}
HOLDING_KEYS = ("pr_and_prgrp", "promoter_and_promoter_group", "promoterAndPromoterGroup", "promoter")
PLEDGE_KEYS = ("percPromoterShares", "perc_promoter_shares", "pledgedPercentage", "percSharesPledged")
DATE_KEYS = ("date", "asOnDate", "recordDate", "toDate", "broadcastDate")


# ------------------------------------------------------------------ parsing (pure)
def num(x) -> float:
    """Float or NaN; strips commas/percent signs; bool/None/garbage -> NaN."""
    if x is None or isinstance(x, bool):
        return np.nan
    try:
        v = float(str(x).replace(",", "").replace("%", "").strip())
    except ValueError:
        return np.nan
    return v if math.isfinite(v) else np.nan


def parse_yahoo(info: dict | None) -> dict:
    """yfinance .info -> percent/ratio fields. Yahoo gives ROE and margins as fractions and
    debtToEquity as a percent (45.3 means 0.453)."""
    i = info or {}
    roe, de, pm = num(i.get("returnOnEquity")), num(i.get("debtToEquity")), num(i.get("profitMargins"))
    pe, pb = num(i.get("trailingPE")), num(i.get("priceToBook"))
    return {"roe": roe * 100, "debt_equity": de / 100, "profit_margin": pm * 100,
            "pe": pe if pe > 0 else np.nan, "pb": pb if pb > 0 else np.nan}


def _latest(rows, key_fn):
    rows = [r for r in rows if isinstance(r, dict)]
    if not rows:
        return None
    dated = []
    for r in rows:
        for k in DATE_KEYS:
            if r.get(k):
                d = pd.to_datetime(str(r[k]), errors="coerce", dayfirst=True)
                if not pd.isna(d):
                    dated.append((d, r))
                    break
    if dated:
        return max(dated, key=lambda t: t[0])[1]
    return rows[0]


def _first(d: dict, keys) -> float:
    for k in keys:
        if k in d:
            v = num(d[k])
            if not np.isnan(v):
                return v
    return np.nan


def _rows(payload):
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        for k in ("data", "records", "result"):
            if isinstance(payload.get(k), list):
                return payload[k]
        return [payload]
    return []


def parse_holding(payload) -> dict:
    r = _latest(_rows(payload), None)
    return {"promoter_pct": _first(r, HOLDING_KEYS) if r else np.nan}


def parse_pledge(payload) -> dict:
    r = _latest(_rows(payload), None)
    v = _first(r, PLEDGE_KEYS) if r else np.nan
    return {"promoter_pledge_pct": v}


# ------------------------------------------------------------------ transports (injectable)
def yahoo_default(symbol: str) -> dict:
    """Real yfinance call; imported lazily so tests and dry runs never need the package."""
    import yfinance  # noqa: PLC0415  (optional dependency: pip install yfinance)
    return yfinance.Ticker(symbol + ".NS").info


class Nse:
    """Tiny polite NSE JSON client. `session` is any requests-like object (mocked in tests)."""

    def __init__(self, session=None, sleep: Callable = time.sleep, delay: float = 1.5, retries: int = 4):
        self.session, self.sleep, self.delay, self.retries, self._warm = session, sleep, delay, retries, False

    def _s(self):
        if self.session is None:
            import requests  # noqa: PLC0415
            self.session = requests.Session()
        self.session.headers.update(HEADERS)
        if not self._warm:                         # NSE rejects cookie-less API calls
            try:
                self.session.get(NSE_HOME, timeout=20)
            except Exception:                      # warm-up failure is not fatal; the call itself will tell
                pass
            self._warm = True
        return self.session

    def get_json(self, url: str):
        wait, last = 2.0, None
        for attempt in range(self.retries):
            try:
                r = self._s().get(url, timeout=30)
                if r.status_code == 404:
                    return None
                if r.status_code == 200 and r.content:
                    out = r.json()
                    self.sleep(self.delay)
                    return out
                last = RuntimeError(f"HTTP {r.status_code}")
            except Exception as exc:               # network / JSON errors
                last = exc
            self.sleep(wait)
            wait *= 2
        raise RuntimeError(f"giving up on {url}: {last}")

    def holding(self, symbol: str):
        return self.get_json(NSE_HOLDING.format(sym=symbol))

    def pledge(self, symbol: str):
        return self.get_json(NSE_PLEDGE.format(sym=symbol))


# ------------------------------------------------------------------ cache
def _cache_path(cache: Path, source: str, symbol: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" + format(ord(c), "x") for c in symbol)
    return cache / source / f"{safe}.json"


def _fresh(path: Path, max_age_days: float, now: datetime) -> dict | None:
    try:
        d = json.loads(path.read_text())
        age = (now - datetime.fromisoformat(d["fetched"])).total_seconds() / 86400
        return d["data"] if age <= max_age_days else None
    except (OSError, ValueError, KeyError):
        return None


def _store(path: Path, data: dict, now: datetime) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps({"fetched": now.isoformat(), "data": {k: (None if np.isnan(v) else v) for k, v in data.items()}}))
    os.replace(tmp, path)


def _load(d: dict) -> dict:
    return {k: np.nan if v is None else v for k, v in d.items()}


# ------------------------------------------------------------------ pipeline
def plan(symbols, cache: Path, max_age: dict, now: datetime) -> list[dict]:
    out = []
    for s in symbols:
        need = [src for src in ("yahoo", "holding", "pledge") if _fresh(_cache_path(cache, src, s), max_age[src], now) is None]
        out.append({"symbol": s, "fetch": need})
    return out


def build(symbols, out_csv: Path, cache: Path, yahoo: Callable = yahoo_default, nse: Nse | None = None,
          max_age_days: dict | None = None, dry_run: bool = False, sleep: Callable = time.sleep, delay: float = 1.5,
          now: datetime | None = None, log: Callable = print) -> dict:
    """Fetch what is missing/stale, merge, write fundamentals.csv atomically. Returns a summary."""
    now = now or datetime.now(timezone.utc)
    max_age = {"yahoo": 7, "holding": 30, "pledge": 30, **(max_age_days or {})}
    symbols = sorted({s.strip().upper() for s in symbols if s and s.strip()})
    todo = plan(symbols, cache, max_age, now)
    if dry_run:
        n = sum(len(t["fetch"]) for t in todo)
        for t in todo:
            log(f"{t['symbol']}: " + (", ".join(t["fetch"]) if t["fetch"] else "cached"))
        log(f"dry run: {n} requests would be made for {len(symbols)} symbols (~{n * delay / 60:.1f} min); nothing written")
        return {"dry_run": True, "requests": n, "symbols": len(symbols)}
    nse = nse or Nse(sleep=sleep, delay=delay)
    fetchers = {"yahoo": (lambda s: parse_yahoo(yahoo(s)), "yahoo"),
                "holding": (lambda s: parse_holding(nse.holding(s)), "nse"),
                "pledge": (lambda s: parse_pledge(nse.pledge(s)), "nse")}
    rows, failures, fetched = [], {}, 0
    for t in todo:
        s, row = t["symbol"], {"symbol": t["symbol"]}
        for src, (fn, kind) in fetchers.items():
            p = _cache_path(cache, src, s)
            data = _fresh(p, max_age[src], now)
            if data is None:
                try:
                    data = fn(s)
                    _store(p, data, now)
                    fetched += 1
                    if kind == "yahoo":
                        sleep(delay)
                except Exception as exc:            # one bad symbol never stops the run; retried next run
                    failures.setdefault(s, []).append(f"{src}: {type(exc).__name__}: {str(exc)[:120]}")
                    log(f"FAIL {s} {src}: {exc}")
                    continue
            row.update(_load(data))
        rows.append(row)
    df = pd.DataFrame(rows).reindex(columns=SCHEMA).sort_values("symbol").reset_index(drop=True)
    df = df.dropna(how="all", subset=SCHEMA[1:])             # no data at all -> no row (never a row of fakes)
    out_csv.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_csv.with_suffix(".tmp")
    df.to_csv(tmp, index=False, float_format="%.6g")
    os.replace(tmp, out_csv)
    meta = {"generated": now.isoformat(), "symbols": len(symbols), "rows": int(len(df)), "requests": fetched,
            "failures": failures, "note": "snapshot, not point-in-time"}
    out_csv.with_suffix(".meta.json").write_text(json.dumps(meta, indent=1, sort_keys=True))
    return meta


# ------------------------------------------------------------------ validator
def validate_frame(df: pd.DataFrame, min_fill: float = 0.5) -> list[str]:
    errs = []
    if list(df.columns) != SCHEMA:
        return [f"header must be exactly {','.join(SCHEMA)} (got {','.join(map(str, df.columns))})"]
    if df.empty:
        return ["file has no rows"]
    sym = df["symbol"].astype(str)
    if sym.duplicated().any():
        errs.append("duplicate symbols: " + ", ".join(sym[sym.duplicated()].head(5)))
    if (sym != sym.str.strip().str.upper()).any() or (sym == "").any():
        errs.append("symbols must be non-empty upper-case with no spaces")
    for c, (lo, hi) in RANGES.items():
        v = pd.to_numeric(df[c], errors="coerce")
        bad_type = df[c].notna() & v.isna()
        if bad_type.any():
            errs.append(f"{c}: non-numeric values in {int(bad_type.sum())} rows")
        out = v.notna() & ((v < lo) | (v > hi))
        if out.any():
            errs.append(f"{c}: {int(out.sum())} values outside [{lo}, {hi}] (e.g. {sym[out].iloc[0]})")
        if v.notna().mean() < min_fill:
            errs.append(f"{c}: only {v.notna().mean():.0%} filled (need {min_fill:.0%}+)")
    return errs


def validate_csv(path: Path, min_fill: float = 0.5) -> list[str]:
    try:
        return validate_frame(pd.read_csv(path), min_fill)
    except Exception as exc:
        return [f"cannot read {path}: {exc}"]


# ------------------------------------------------------------------ CLI
def symbols_from_data() -> list[str]:
    """Symbols in F&O on the latest day of the loaded bhavcopy."""
    from scores import universe
    return universe.current_members_from_market()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--symbols", help="comma separated NSE symbols")
    ap.add_argument("--from-data", action="store_true", help="use the F&O symbols on the latest day of the DATA_DIR bhavcopy")
    ap.add_argument("--out", default="fundamentals.csv")
    ap.add_argument("--cache-dir", default=str(Path(__file__).resolve().parent / "cache" / "fundamentals"))
    ap.add_argument("--max-age-days", type=float, default=None, help="override cache age for all sources")
    ap.add_argument("--delay", type=float, default=1.5, help="seconds between requests (keep >= 1)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--validate", metavar="FILE")
    ap.add_argument("--probe", metavar="SYMBOL", help="print raw field names for one symbol (needs network); writes nothing")
    a = ap.parse_args(argv)
    if a.validate:
        errs = validate_csv(Path(a.validate))
        print("OK" if not errs else "\n".join(errs))
        return 0 if not errs else 1
    if a.probe:
        nse = Nse(delay=a.delay)
        info = yahoo_default(a.probe)
        print("yahoo keys used:", {k: info.get(k) for k in ("returnOnEquity", "debtToEquity", "profitMargins", "trailingPE", "priceToBook")})
        for name, fn in (("holding", nse.holding), ("pledge", nse.pledge)):
            rows = _rows(fn(a.probe))
            print(name, "rows:", len(rows), "first row keys:", sorted(rows[0]) if rows and isinstance(rows[0], dict) else rows[:1])
        return 0
    if a.delay < 1.0:
        ap.error("--delay must be at least 1 second (be polite to NSE)")
    syms = [s for s in (a.symbols or "").split(",") if s] if a.symbols else (symbols_from_data() if a.from_data else [])
    if not syms:
        ap.error("give --symbols or --from-data")
    age = None if a.max_age_days is None else {k: a.max_age_days for k in ("yahoo", "holding", "pledge")}
    res = build(syms, Path(a.out), Path(a.cache_dir), max_age_days=age, dry_run=a.dry_run, delay=a.delay)
    if a.dry_run:
        return 0
    errs = validate_csv(Path(a.out))
    print(f"{res['rows']} rows, {len(res['failures'])} symbols with failures -> {a.out}")
    if errs:
        print("VALIDATION PROBLEMS:\n" + "\n".join(errs))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
