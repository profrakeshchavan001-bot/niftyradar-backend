"""Data adapters: F&O bhavcopy -> strike-wise chain, participant-wise OI, live NSE chain JSON.

Each adapter parses bytes/dicts (so tests run on fixtures); the downloaders are thin wrappers.
"""
from __future__ import annotations

import csv
import io
import json
import random
import time
import zipfile
from datetime import date as _date, datetime
from pathlib import Path

from .model import Chain, Strike, INDEX_SYMBOLS

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "chain"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/csv,application/json,application/zip,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/option-chain",
}
FO_URL = "https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip"
PART_URL = "https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{dmy}.csv"
LIVE_INDEX_URL = "https://www.nseindia.com/api/option-chain-indices?symbol={sym}"
LIVE_EQUITY_URL = "https://www.nseindia.com/api/option-chain-equities?symbol={sym}"
POLITE_DELAY = 1.0


# ------------------------------------------------------------ (a) F&O bhavcopy
def _text(raw: bytes) -> str:
    if raw[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            raw = z.read(z.namelist()[0])
    return raw.decode("utf-8-sig")


def _num(v) -> float:
    try:
        return float(str(v).strip().replace(",", ""))
    except ValueError:
        return 0.0


def _iso(v: str) -> str:
    v = str(v).strip()
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y", "%d-%b-%y"):
        try:
            return datetime.strptime(v, fmt).date().isoformat()
        except ValueError:
            continue
    raise ValueError(f"unrecognised date {v!r}")


class FoDay:
    """One trading day parsed from a bhavcopy: chains per symbol + index futures."""

    def __init__(self, date: str):
        self.date = date
        self.chains: dict[str, Chain] = {}
        self.expiries: dict[str, list] = {}
        self.index_fut: dict[str, dict] = {}   # symbol -> {"fut": close, "spot": underlying}


def _records(text: str):
    """Yield normalised dicts from UDiFF (new) or legacy (pre-2024) bhavcopy rows."""
    rd = csv.DictReader(io.StringIO(text))
    cols = [c.strip() for c in (rd.fieldnames or [])]
    rd.fieldnames = cols
    udiff = "FinInstrmTp" in cols
    for r in rd:
        if udiff:
            yield {
                "date": _iso(r["TradDt"]), "instr": r["FinInstrmTp"].strip(),
                "sym": r["TckrSymb"].strip(), "expiry": _iso(r["XpryDt"]),
                "strike": _num(r.get("StrkPric")), "opt": (r.get("OptnTp") or "").strip(),
                "ltp": _num(r.get("LastPric")) or _num(r.get("ClsPric")), "close": _num(r.get("ClsPric")),
                "oi": _num(r.get("OpnIntrst")), "chg": _num(r.get("ChngInOpnIntrst")),
                "vol": _num(r.get("TtlTradgVol")), "spot": _num(r.get("UndrlygPric")),
            }
        else:  # legacy fo<DD><MMM><YYYY>bhav.csv: no underlying price, volume = CONTRACTS
            instr = {"OPTIDX": "IDO", "OPTSTK": "STO", "FUTIDX": "IDF", "FUTSTK": "STF"}.get(r["INSTRUMENT"].strip())
            if not instr:
                continue
            yield {
                "date": _iso(r["TIMESTAMP"]), "instr": instr, "sym": r["SYMBOL"].strip(),
                "expiry": _iso(r["EXPIRY_DT"]), "strike": _num(r.get("STRIKE_PR")),
                "opt": (r.get("OPTION_TYP") or "").strip().replace("XX", ""),
                "ltp": _num(r.get("CLOSE")), "close": _num(r.get("CLOSE")),
                "oi": _num(r.get("OPEN_INT")), "chg": _num(r.get("CHG_IN_OI")),
                "vol": _num(r.get("CONTRACTS")), "spot": 0.0,
            }


def parse_fo_bhavcopy(raw: bytes, symbols=None, expiry_index: int = 0, spots: dict | None = None) -> FoDay:
    """Strike-wise OI, volume, OI change and LTP per expiry; nearest expiry by default
    (expiry_index=1 is the next one). `spots` supplies underlying prices for legacy files."""
    recs = list(_records(_text(raw)))
    if not recs:
        raise ValueError("empty bhavcopy")
    day = FoDay(recs[0]["date"])
    want = set(symbols) if symbols else None
    spots = spots or {}
    by_sym: dict[str, dict] = {}
    for r in recs:
        if want and r["sym"] not in want:
            continue
        if r["instr"] == "IDF":
            if r["expiry"] >= day.date:
                cur = day.index_fut.get(r["sym"])
                if cur is None or r["expiry"] < cur["expiry"]:
                    day.index_fut[r["sym"]] = {"fut": r["close"], "spot": r["spot"] or spots.get(r["sym"], 0.0), "expiry": r["expiry"]}
            continue
        if r["instr"] not in ("IDO", "STO") or r["opt"] not in ("CE", "PE") or r["expiry"] < day.date:
            continue
        by_sym.setdefault(r["sym"], {}).setdefault(r["expiry"], {})[(r["strike"], r["opt"])] = r
    for sym, exps in by_sym.items():
        order = sorted(exps)
        day.expiries[sym] = order
        exp = order[min(expiry_index, len(order) - 1)]
        rows: dict[float, Strike] = {}
        spot = 0.0
        for (k, opt), r in exps[exp].items():
            s = rows.setdefault(k, Strike(strike=k))
            spot = spot or r["spot"]
            p = "ce" if opt == "CE" else "pe"
            setattr(s, f"{p}_oi", r["oi"]); setattr(s, f"{p}_vol", r["vol"])
            setattr(s, f"{p}_chg", r["chg"]); setattr(s, f"{p}_ltp", r["ltp"])
        spot = spot or spots.get(sym, 0.0)
        if spot > 0:
            day.chains[sym] = Chain(sym, day.date, exp, spot, list(rows.values()))
    return day


# ------------------------------------------------------ (b) participant-wise OI
PART_COLS = {
    "future index long": "idx_fut_long", "future index short": "idx_fut_short",
    "future stock long": "stk_fut_long", "future stock short": "stk_fut_short",
    "option index call long": "idx_ce_long", "option index put long": "idx_pe_long",
    "option index call short": "idx_ce_short", "option index put short": "idx_pe_short",
    "option stock call long": "stk_ce_long", "option stock put long": "stk_pe_long",
    "option stock call short": "stk_ce_short", "option stock put short": "stk_pe_short",
}


def parse_participant_oi(raw: bytes) -> dict:
    """fao_participant_oi_DDMMYYYY.csv -> {"FII": {idx_fut_long: n, ...}, "DII":..., "Pro":..., "Client":...}"""
    lines = [ln for ln in _text(raw).splitlines() if ln.strip()]
    start = next(i for i, ln in enumerate(lines) if ln.lower().lstrip().startswith("client type"))
    rd = csv.reader(lines[start:])
    head = [h.strip().lower() for h in next(rd)]
    out = {}
    for row in rd:
        name = row[0].strip()
        if not name or name.upper() == "TOTAL":
            continue
        key = name.upper() if name.upper() in ("FII", "DII") else name.title()
        out[key] = {PART_COLS[h]: int(_num(v)) for h, v in zip(head[1:], row[1:]) if h in PART_COLS}
    return out


# ------------------------------------------------------------- (c) live chain
def parse_live_chain(payload: dict, symbol: str, date: str | None = None, expiry: str | None = None) -> Chain:
    """NSE option-chain API JSON -> Chain (nearest expiry unless `expiry` ISO given)."""
    recs = payload["records"]
    rows = recs["data"]
    exps = sorted({_iso(r["expiryDate"]) for r in rows})
    exp = expiry or exps[0]
    spot = float(recs.get("underlyingValue") or 0)
    cells = []
    for r in rows:
        if _iso(r["expiryDate"]) != exp:
            continue
        ce, pe = r.get("CE") or {}, r.get("PE") or {}
        spot = spot or float(ce.get("underlyingValue") or pe.get("underlyingValue") or 0)
        cells.append(Strike(
            r["strikePrice"],
            ce.get("openInterest", 0), ce.get("totalTradedVolume", 0), ce.get("changeinOpenInterest", 0), ce.get("lastPrice", 0.0),
            pe.get("openInterest", 0), pe.get("totalTradedVolume", 0), pe.get("changeinOpenInterest", 0), pe.get("lastPrice", 0.0),
        ))
    ts = recs.get("timestamp")
    day = date or (_iso(ts.split(" ")[0]) if ts else _date.today().isoformat())
    return Chain(symbol, day, exp, spot, cells)


class LiveChainFetcher:
    """Polite cached poller for the NSE live chain. Refresh is clamped to 60-180 s.
    `fixture_dir` switches to offline mode (reads live_<SYMBOL>.json, never touches the network)."""

    def __init__(self, refresh_s: int = 120, fixture_dir=None, session=None, clock=time.time):
        self.refresh_s = min(max(int(refresh_s), 60), 180)
        self.fixture_dir = Path(fixture_dir) if fixture_dir else None
        self.session = session
        self.clock = clock
        self._cache: dict[str, tuple] = {}

    def _session(self):
        if self.session is None:
            import requests
            s = requests.Session()
            s.headers.update(HEADERS)
            try:
                s.get("https://www.nseindia.com", timeout=20)  # cookie warm-up
            except requests.RequestException:
                pass
            self.session = s
        return self.session

    def _payload(self, symbol: str) -> dict:
        if self.fixture_dir:
            return json.loads((self.fixture_dir / f"live_{symbol}.json").read_text())
        url = (LIVE_INDEX_URL if symbol in INDEX_SYMBOLS else LIVE_EQUITY_URL).format(sym=symbol)
        delay, last = 2.0, None
        for _ in range(3):
            try:
                r = self._session().get(url, timeout=30)
                if r.status_code == 200 and r.content:
                    return r.json()
                last = RuntimeError(f"HTTP {r.status_code}")
            except Exception as exc:  # network / bad json: back off, retry
                last = exc
            time.sleep(delay + random.uniform(0, 1))
            delay *= 2
        raise RuntimeError(f"live chain {symbol}: {last}")

    def get(self, symbol: str, force: bool = False) -> Chain:
        now = self.clock()
        hit = self._cache.get(symbol)
        if hit and not force and now - hit[0] < self.refresh_s:
            return hit[1]
        chain = parse_live_chain(self._payload(symbol), symbol)
        self._cache[symbol] = (now, chain)
        return chain


# ------------------------------------------------------------------ downloaders
def raw_paths(day: str, raw_dir=None):
    d = Path(raw_dir) if raw_dir else RAW_DIR
    ymd = day.replace("-", "")
    dmy = f"{day[8:10]}{day[5:7]}{day[:4]}"
    return d / f"fo_{ymd}.csv", d / f"participant_{dmy}.csv", d / f"market_{ymd}.json"


def download_day(day: str, raw_dir=None, session=None) -> dict:
    """Fetch F&O bhavcopy + participant OI for one day into raw_dir. Returns {"fo": bool, "part": bool}."""
    import requests
    s = session
    if s is None:
        s = requests.Session()
        s.headers.update(HEADERS)
        try:
            s.get("https://www.nseindia.com", timeout=20)
        except requests.RequestException:
            pass
    fo_p, part_p, _ = raw_paths(day, raw_dir)
    fo_p.parent.mkdir(parents=True, exist_ok=True)
    ymd, dmy = day.replace("-", ""), f"{day[8:10]}{day[5:7]}{day[:4]}"
    res = {}
    for key, url, path in (("fo", FO_URL.format(ymd=ymd), fo_p), ("part", PART_URL.format(dmy=dmy), part_p)):
        if path.exists():
            res[key] = True
            continue
        try:
            r = s.get(url, timeout=45)
            ok = r.status_code == 200 and bool(r.content)
        except requests.RequestException:
            ok = False
        if ok:
            path.write_bytes(_text(r.content).encode() if key == "fo" else r.content)
        res[key] = ok
        time.sleep(POLITE_DELAY)
    return res
