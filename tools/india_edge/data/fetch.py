"""Download NSE daily bhavcopies (cash+delivery, F&O, index closes) to parquet.

    python data/fetch.py --from 2026-09-01 --to 2026-10-28

Incremental: a day already stored is skipped. Weekends are skipped; days NSE
answers 404 for (holidays) are remembered in data/.missing.json so they are
not retried once they are old enough that the file can no longer be "late".
"""
from __future__ import annotations

import argparse
import io
import json
import random
import sys
import time
from pathlib import Path

import pandas as pd
import requests

try:  # nsearchives omits its intermediate cert; the OS store (AIA fetch) can verify it, certifi can't
    import truststore
    truststore.inject_into_ssl()
except ImportError:
    pass

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import DATA_DIR, day_file  # noqa: E402

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,application/zip,application/octet-stream,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/all-reports",
}
URLS = {
    "cash": "https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{dmy}.csv",
    "fo": "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip",
    "idx": "https://nsearchives.nseindia.com/content/indices/ind_close_all_{dmy}.csv",
}
MISSING_FILE = DATA_DIR / ".missing.json"
MISSING_AFTER_DAYS = 4  # a 404 older than this is a holiday, not "not published yet"
POLITE_DELAY = 1.0


# ---------------------------------------------------------------- parsing
def parse_cash(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    df = df[df["SERIES"].astype(str).str.strip() == "EQ"].copy()
    num = lambda c: pd.to_numeric(df[c], errors="coerce")  # noqa: E731
    out = pd.DataFrame({
        "date": day,
        "symbol": df["SYMBOL"].astype(str).str.strip(),
        "prev_close": num("PREV_CLOSE"),
        "open": num("OPEN_PRICE"),
        "high": num("HIGH_PRICE"),
        "low": num("LOW_PRICE"),
        "close": num("CLOSE_PRICE"),
        "volume": num("TTL_TRD_QNTY"),
        "deliv_qty": num("DELIV_QTY"),
        "deliv_pct": num("DELIV_PER"),
    })
    return out.reset_index(drop=True)


def parse_fo(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    """UDiFF F&O bhavcopy; keeps stock futures (STF) and stock options (STO)."""
    df = pd.read_csv(io.BytesIO(raw), compression="zip")
    df = df[df["FinInstrmTp"].isin(["STF", "STO"])].copy()
    num = lambda c: pd.to_numeric(df[c], errors="coerce")  # noqa: E731
    out = pd.DataFrame({
        "date": day,
        "instr": df["FinInstrmTp"].values,
        "symbol": df["TckrSymb"].astype(str).str.strip().values,
        "expiry": _iso_expiry(df["XpryDt"]).values,
        "strike": num("StrkPric").fillna(0.0).values,
        "opt_type": df["OptnTp"].fillna("").astype(str).values,
        "close": num("ClsPric").values,
        "oi": num("OpnIntrst").values,
        "chg_oi": num("ChngInOpnIntrst").values,
        "volume": num("TtlTradgVol").values,
    })
    return out.reset_index(drop=True)


def parse_idx(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    df = pd.read_csv(io.BytesIO(raw), skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    return pd.DataFrame({
        "date": day,
        "index_name": df["Index Name"].astype(str).str.strip(),
        "close": pd.to_numeric(df["Closing Index Value"], errors="coerce"),
    })


def parse_fo_legacy(raw: bytes, day: pd.Timestamp) -> pd.DataFrame:
    """Pre-July-2024 F&O bhavcopy (fo<DD><MON><YYYY>bhav.csv.zip), mapped to the UDiFF schema."""
    df = pd.read_csv(io.BytesIO(raw), compression="zip", skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    df = df[df["INSTRUMENT"].isin(["FUTSTK", "OPTSTK"])].copy()
    num = lambda c: pd.to_numeric(df[c], errors="coerce")  # noqa: E731
    return pd.DataFrame({
        "date": day,
        "instr": df["INSTRUMENT"].map({"FUTSTK": "STF", "OPTSTK": "STO"}).values,
        "symbol": df["SYMBOL"].astype(str).str.strip().values,
        "expiry": _iso_expiry(df["EXPIRY_DT"]).values,
        "strike": num("STRIKE_PR").values,
        "opt_type": df["OPTION_TYP"].astype(str).str.strip().replace("XX", "").values,
        "close": num("CLOSE").values,
        "oi": num("OPEN_INT").values,
        "chg_oi": num("CHG_IN_OI").values,
        "volume": num("CONTRACTS").values,
    }).reset_index(drop=True)


def parse_cash_legacy(raw: tuple[bytes, bytes | None], day: pd.Timestamp) -> pd.DataFrame:
    """Pre-Sep-2019 cash: cm<DD><MON><YYYY>bhav.csv.zip joined with the MTO delivery file."""
    bhav, mto = raw
    df = pd.read_csv(io.BytesIO(bhav), compression="zip", skipinitialspace=True)
    df.columns = [c.strip() for c in df.columns]
    df = df[df["SERIES"].astype(str).str.strip() == "EQ"].copy()
    num = lambda c: pd.to_numeric(df[c], errors="coerce")  # noqa: E731
    out = pd.DataFrame({
        "date": day,
        "symbol": df["SYMBOL"].astype(str).str.strip(),
        "prev_close": num("PREVCLOSE"),
        "open": num("OPEN"),
        "high": num("HIGH"),
        "low": num("LOW"),
        "close": num("CLOSE"),
        "volume": num("TOTTRDQTY"),
    }).reset_index(drop=True)
    deliv = pd.DataFrame(columns=["symbol", "deliv_qty", "deliv_pct"])
    if mto:
        rows = [ln.split(",") for ln in mto.decode("latin-1").splitlines() if ln.startswith("20,")]
        rows = [r for r in rows if len(r) >= 7 and r[3].strip() == "EQ"]
        deliv = pd.DataFrame({
            "symbol": [r[2].strip() for r in rows],
            "deliv_qty": pd.to_numeric([r[5] for r in rows], errors="coerce"),
            "deliv_pct": pd.to_numeric([r[6] for r in rows], errors="coerce"),
        })
    return out.merge(deliv, on="symbol", how="left")


def _iso_expiry(s: pd.Series) -> pd.Series:
    return pd.to_datetime(s, format="mixed", errors="coerce").dt.strftime("%Y-%m-%d")


PARSERS = {"cash": parse_cash, "fo": parse_fo, "idx": parse_idx}
UDIFF_START = pd.Timestamp("2024-07-08")  # first day of the UDiFF F&O file format
CASH_FULL_START = pd.Timestamp("2019-09-30")  # first sec_bhavdata_full file on nsearchives
FO_LEGACY_URL = ("https://nsearchives.nseindia.com/content/historical/DERIVATIVES/"
                 "{yyyy}/{mon}/fo{dd}{mon}{yyyy}bhav.csv.zip")
CASH_LEGACY_URLS = ("https://nsearchives.nseindia.com/content/historical/EQUITIES/"
                    "{yyyy}/{mon}/cm{dd}{mon}{yyyy}bhav.csv.zip",
                    "https://nsearchives.nseindia.com/archives/equities/mto/MTO_{dmy}.DAT")


def source_for(name: str, day: pd.Timestamp):
    """(url template, parser) for one dataset on one day. A tuple of templates means
    the first file is required and the rest are optional extras passed alongside it."""
    if name == "fo" and day < UDIFF_START:
        return FO_LEGACY_URL, parse_fo_legacy
    if name == "cash" and day < CASH_FULL_START:
        return CASH_LEGACY_URLS, parse_cash_legacy
    return URLS[name], PARSERS[name]


def format_url(template: str, day: pd.Timestamp) -> str:
    return template.format(dmy=f"{day:%d%m%Y}", ymd=f"{day:%Y%m%d}", dd=f"{day:%d}",
                           mon=f"{day:%b}".upper(), yyyy=f"{day:%Y}")


# ---------------------------------------------------------------- network
def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    try:  # cookie warm-up; NSE sometimes rejects cookie-less clients
        s.get("https://www.nseindia.com", timeout=20)
    except requests.RequestException:
        pass
    return s


def download(session: requests.Session, url: str, retries: int = 4) -> bytes | None:
    """Return body bytes, None for 404 (no file for that day). Raises after retries."""
    delay = 2.0
    last: Exception | None = None
    for _ in range(retries):
        try:
            r = session.get(url, timeout=45)
            if r.status_code == 404:
                return None
            if r.status_code == 200 and r.content:
                return r.content
            last = RuntimeError(f"HTTP {r.status_code} for {url}")
        except requests.RequestException as exc:
            last = exc
        time.sleep(delay + random.uniform(0, 1))
        delay *= 2
    raise RuntimeError(f"giving up on {url}: {last}")


# ---------------------------------------------------------------- driver
def _load_missing() -> dict:
    try:
        return json.loads(MISSING_FILE.read_text())
    except (OSError, ValueError):
        return {}


def is_holiday_copy(df: pd.DataFrame, day: pd.Timestamp) -> bool:
    """NSE publishes sec_bhavdata_full on holidays as a copy of the previous session."""
    for back in range(1, 8):
        prev = day_file("cash", day - pd.Timedelta(days=back))
        if prev.exists():
            p = pd.read_parquet(prev, columns=["symbol", "close", "volume"])
            cur = df[["symbol", "close", "volume"]]
            return len(p) == len(cur) and p.reset_index(drop=True).equals(cur.reset_index(drop=True))
    return False


def fetch_range(start: pd.Timestamp, end: pd.Timestamp, log=print) -> dict:
    missing = _load_missing()
    today = pd.Timestamp.today().normalize()
    stats = {"downloaded": 0, "skipped": 0, "no_file": 0, "failed": 0}
    session = None
    for day in pd.date_range(start, end, freq="D"):
        if day.weekday() >= 5:
            continue
        for name in ("fo", "idx", "cash"):
            path = day_file(name, day)
            key = f"{name}:{day:%Y-%m-%d}"
            if path.exists() or key in missing:
                stats["skipped"] += 1
                continue
            if name == "cash" and not (day_file("fo", day).exists() or day_file("idx", day).exists()):
                # NSE publishes the cash file on holidays too (a copy of the last session,
                # which may be a weekend special session); no F&O/index file -> no session
                stats["no_file"] += 1
                if (today - day).days > MISSING_AFTER_DAYS:
                    missing[key] = True
                continue
            session = session or make_session()
            url_t, parser = source_for(name, day)
            try:
                if isinstance(url_t, tuple):
                    raw = download(session, format_url(url_t[0], day))
                    if raw is not None:
                        raw = (raw, *(download(session, format_url(u, day)) for u in url_t[1:]))
                else:
                    raw = download(session, format_url(url_t, day))
                if name == "cash" and raw is not None and raw[:2] == b"PK":
                    # a few sec_bhavdata_full days (e.g. 2022-08-08) were published as xlsx
                    parser = parse_cash_legacy
                    raw = download(session, format_url(CASH_LEGACY_URLS[0], day))
                    if raw is not None:
                        raw = (raw, download(session, format_url(CASH_LEGACY_URLS[1], day)))
            except RuntimeError as exc:
                log(f"FAIL {key}: {exc}")
                stats["failed"] += 1
                continue
            time.sleep(POLITE_DELAY)
            if raw is None:
                stats["no_file"] += 1
                if (today - day).days > MISSING_AFTER_DAYS:
                    missing[key] = True
                continue
            try:
                df = parser(raw, day)
                if name == "cash" and is_holiday_copy(df, day):
                    stats["no_file"] += 1
                    missing[key] = True
                    log(f"hol  {key}: copy of previous session")
                    continue
                df.to_parquet(path, index=False)
                stats["downloaded"] += 1
                log(f"ok   {key}")
            except Exception as exc:  # malformed file: report, keep going
                log(f"FAIL {key}: parse error {exc}")
                stats["failed"] += 1
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    missing = {**_load_missing(), **missing}  # keep entries written by a concurrent run
    MISSING_FILE.write_text(json.dumps(missing, indent=0))
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--from", dest="start", help="YYYY-MM-DD")
    src.add_argument("--days", type=int, help="incremental: the last N calendar days")
    ap.add_argument("--to", dest="end", default=None, help="YYYY-MM-DD (default today)")
    a = ap.parse_args(argv)
    end = pd.Timestamp(a.end) if a.end else pd.Timestamp.today().normalize()
    start = pd.Timestamp(a.start) if a.start else end - pd.Timedelta(days=a.days)
    stats = fetch_range(start, end)
    print(stats)
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    sys.exit(main())
