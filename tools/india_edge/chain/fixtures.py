"""Deterministic synthetic fixtures (NSE downloads are blocked in CI): 20 F&O stocks + NIFTY/BANKNIFTY
x N days of strike-wise OI/volume/OI-change/premium in UDiFF layout, participant-wise OI, market context
and a live-chain JSON. Numbers are random, shapes match the real files."""
from __future__ import annotations

import csv
import json
import math
import random
from datetime import date, timedelta
from pathlib import Path

from . import bs
from .adapters import raw_paths

# symbol -> (start spot, strike step, half-width in steps, base OI)
STOCKS = {
    "RELIANCE": (1400, 20, 12, 90000), "TCS": (3300, 50, 12, 40000), "HDFCBANK": (1700, 20, 12, 120000),
    "INFY": (1600, 20, 12, 90000), "ICICIBANK": (1250, 20, 12, 100000), "SBIN": (820, 10, 12, 150000),
    "ITC": (410, 5, 12, 200000), "LT": (3600, 50, 12, 30000), "AXISBANK": (1150, 20, 12, 80000),
    "KOTAKBANK": (2100, 20, 12, 40000), "BHARTIARTL": (1900, 20, 12, 60000), "MARUTI": (12500, 100, 12, 6000),
    "TATAMOTORS": (700, 10, 12, 140000), "SUNPHARMA": (1700, 20, 12, 50000), "ONGC": (250, 5, 12, 250000),
    "NTPC": (340, 5, 12, 200000), "WIPRO": (260, 5, 12, 180000), "TITAN": (3500, 50, 12, 25000),
    "ADANIENT": (2400, 50, 12, 40000), "HINDALCO": (680, 10, 12, 90000),
}
INDICES = {"NIFTY": (24500, 100, 20, 600000), "BANKNIFTY": (53000, 200, 20, 150000)}
OTHER_FUT_INDICES = {"FINNIFTY": 24000, "MIDCPNIFTY": 12500, "NIFTYNXT50": 68000}
SECTORS = ["BANK", "IT", "AUTO", "FMCG", "PHARMA", "METAL", "ENERGY", "REALTY", "MEDIA", "PSU BANK", "FIN SERVICE"]
HOLIDAYS = {"2026-10-02", "2026-10-20"}
PARTICIPANTS = ("Client", "DII", "FII", "Pro")
HEAD = ["TradDt", "FinInstrmTp", "TckrSymb", "XpryDt", "StrkPric", "OptnTp", "ClsPric", "LastPric",
        "OpnIntrst", "ChngInOpnIntrst", "TtlTradgVol", "UndrlygPric"]


def trading_days(end: str, n: int) -> list[str]:
    d, out = date.fromisoformat(end), []
    while len(out) < n:
        if d.weekday() < 5 and d.isoformat() not in HOLIDAYS:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out[::-1]


def _last_thursday(y: int, m: int) -> date:
    d = date(y + (m == 12), m % 12 + 1, 1) - timedelta(days=1)
    while d.weekday() != 3:
        d -= timedelta(days=1)
    return d


def expiries_for(day: str, n: int = 2) -> list[str]:
    d, out, y, m = date.fromisoformat(day), [], date.fromisoformat(day).year, date.fromisoformat(day).month
    while len(out) < n:
        e = _last_thursday(y, m)
        if e >= d:
            out.append(e.isoformat())
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def _tick(x: float) -> float:
    return max(0.05, round(x / 0.05) * 0.05)


def make_fixtures(out_dir, end: str = "2026-10-28", days: int = 60, seed: int = 7) -> list[str]:
    """Write fo_*.csv, participant_*.csv, market_*.json and live_*.json; returns the trade dates."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(seed)
    dates = trading_days(end, days)
    universe = {**{s: v for s, v in STOCKS.items()}, **INDICES}
    spot = {s: float(v[0]) for s, v in universe.items()}
    base_k = {s: round(v[0] / v[1]) * v[1] for s, v in universe.items()}
    oi_state: dict[tuple, dict] = {}
    other_spot = dict(OTHER_FUT_INDICES)
    basis = {s: rng.uniform(0.002, 0.008) for s in [*INDICES, *OTHER_FUT_INDICES]}
    part = {c: {k: rng.randint(50000, 400000) for k in
                ("idx_fut_long", "idx_fut_short", "stk_fut_long", "stk_fut_short", "idx_ce_long", "idx_pe_long",
                 "idx_ce_short", "idx_pe_short", "stk_ce_long", "stk_pe_long", "stk_ce_short", "stk_pe_short")}
            for c in PARTICIPANTS}
    market_drift = 0.0
    live_last = None
    for day in dates:
        market_drift = 0.3 * market_drift + rng.gauss(0, 0.004)
        for s in spot:
            spot[s] *= 1 + market_drift + rng.gauss(0, 0.008) - 0.05 * math.log(spot[s] / universe[s][0])
        for s in other_spot:
            other_spot[s] *= 1 + market_drift + rng.gauss(0, 0.004)
        exps = expiries_for(day)
        rows = []
        for sym, (_, step, half, base) in universe.items():
            itype = "IDO" if sym in INDICES else "STO"
            for ei, exp in enumerate(exps):
                key = (sym, exp)
                new_series = key not in oi_state
                if new_series:
                    st = {}
                    for i in range(-half, half + 1):
                        k = base_k[sym] + i * step
                        w = math.exp(-abs(i) / 5) + 0.1
                        st[k] = [base * rng.uniform(0.5, 1.5) * w * (0.6 if ei else 1), base * rng.uniform(0.5, 1.5) * w * (0.6 if ei else 1)]
                    for _ in range(2):
                        st[base_k[sym] + rng.randint(1, half) * step][0] *= 3
                        st[base_k[sym] - rng.randint(1, half) * step][1] *= 3
                    oi_state[key] = st
                st = oi_state[key]
                prev = {k: list(v) for k, v in st.items()}
                for k, v in st.items():
                    v[0] *= 1 + rng.gauss(0, 0.08)
                    v[1] *= 1 + rng.gauss(0, 0.08)
                for k in rng.sample(sorted(st), 3):
                    st[k][rng.randint(0, 1)] *= 1 + rng.uniform(0.2, 0.6)
                T = max((date.fromisoformat(exp) - date.fromisoformat(day)).days, 0.5) / 365
                for k, v in st.items():
                    iv = 0.22 + 0.1 * abs(math.log(k / spot[sym])) + rng.gauss(0, 0.01)
                    for j, opt in enumerate(("CE", "PE")):
                        oi = int(v[j])
                        chg = oi if new_series else oi - int(prev[k][j])
                        px = _tick(bs.price(spot[sym], k, T, max(iv, 0.05), opt == "CE"))
                        atm = math.exp(-abs(k - spot[sym]) / (4 * step))
                        vol = int(oi * (0.15 + 0.9 * atm) * rng.uniform(0.6, 1.4))
                        rows.append([day, itype, sym, exp, k, opt, px, px, oi, chg, vol, round(spot[sym], 2)])
        for sym in [*INDICES, *OTHER_FUT_INDICES]:
            basis[sym] = max(0.0, basis[sym] + rng.gauss(0, 0.0008))
            sp = spot[sym] if sym in spot else other_spot[sym]
            rows.append([day, "IDF", sym, exps[0], 0, "", round(sp * (1 + basis[sym]), 2), round(sp * (1 + basis[sym]), 2), 1000000, 0, 500000, round(sp, 2)])
        fo_p, part_p, mkt_p = raw_paths(day, out)
        with open(fo_p, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(HEAD)
            w.writerows(rows)
        for c in PARTICIPANTS:
            for k in part[c]:
                part[c][k] = max(1000, part[c][k] + rng.randint(-15000, 15000))
        with open(part_p, "w", newline="") as fh:
            fh.write(f"Participant wise Open Interest (no. of contracts) in Equity Derivatives as on {date.fromisoformat(day):%b %d, %Y}\n")
            heads = ["Future Index Long", "Future Index Short", "Future Stock Long", "Future Stock Short",
                     "Option Index Call Long", "Option Index Put Long", "Option Index Call Short", "Option Index Put Short",
                     "Option Stock Call Long", "Option Stock Put Long", "Option Stock Call Short", "Option Stock Put Short"]
            keys = ["idx_fut_long", "idx_fut_short", "stk_fut_long", "stk_fut_short", "idx_ce_long", "idx_pe_long",
                    "idx_ce_short", "idx_pe_short", "stk_ce_long", "stk_pe_long", "stk_ce_short", "stk_pe_short"]
            fh.write("Client Type," + ",".join(heads) + ",Total Long Contracts,Total Short Contracts\n")
            for c in PARTICIPANTS:
                vals = [part[c][k] for k in keys]
                fh.write(f"{c}," + ",".join(map(str, vals)) + f",{sum(vals[0::2])},{sum(vals[1::2])}\n")
        mkt_p.write_text(json.dumps({
            "date": day, "vix": round(14 + 4 * abs(market_drift) * 100 + rng.uniform(0, 2), 2),
            "sectors": {s: round(market_drift * 100 + rng.gauss(0, 0.5), 2) for s in SECTORS},
        }))
        live_last = (day, exps[0])
    # live-chain JSON in the NSE option-chain API shape for the last day
    day, exp = live_last
    for sym in INDICES:
        rows = [r for r in rows_of(out, day) if r[2] == sym and r[3] == exp]
        by_k: dict[float, dict] = {}
        for r in rows:
            by_k.setdefault(r[4], {"strikePrice": r[4], "expiryDate": date.fromisoformat(exp).strftime("%d-%b-%Y")})[r[5]] = {
                "openInterest": r[8], "changeinOpenInterest": r[9], "totalTradedVolume": r[10],
                "lastPrice": r[6], "underlyingValue": r[11]}
        (out / f"live_{sym}.json").write_text(json.dumps({"records": {
            "timestamp": f"{date.fromisoformat(day):%d-%b-%Y} 15:30:00", "underlyingValue": rows[0][11],
            "data": [by_k[k] for k in sorted(by_k)]}}))
    return dates


def rows_of(out: Path, day: str):
    with open(raw_paths(day, out)[0]) as fh:
        rd = csv.reader(fh)
        next(rd)
        return [[r[0], r[1], r[2], r[3], float(r[4]), r[5], float(r[6]), float(r[7]), int(float(r[8])),
                 int(float(r[9])), int(float(r[10])), float(r[11])] for r in rd]
