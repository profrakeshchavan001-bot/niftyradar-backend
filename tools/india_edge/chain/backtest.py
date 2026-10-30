"""Label each day's flags with the next session's outcome so base rates can be computed.

hit  = next close moved the flag's way (up for bullish flags, down for bearish)
held = next close stayed on the right side of the level (>= support for bullish, <= resistance for bearish)
"""
from __future__ import annotations

from collections import defaultdict

from .signalbox import BEAR_FLAGS, BULL_FLAGS


def label_day(records: list[dict], next_spots: dict) -> list[dict]:
    out = []
    for r in records:
        nxt = next_spots.get(r["symbol"])
        if not nxt or not r["spot"]:
            continue
        ret = (nxt / r["spot"] - 1) * 100
        for f in r["flags"]:
            if f in BULL_FLAGS:
                held = r["support"] is not None and nxt >= r["support"]
                out.append({"date": r["date"], "symbol": r["symbol"], "flag": f, "dir": "bull", "ret_pct": ret, "hit": ret > 0, "held": held})
            elif f in BEAR_FLAGS:
                held = r["resistance"] is not None and nxt <= r["resistance"]
                out.append({"date": r["date"], "symbol": r["symbol"], "flag": f, "dir": "bear", "ret_pct": -ret, "hit": ret < 0, "held": held})
    return out


def base_rates(labels: list[dict]) -> dict:
    """flag -> {n, hit_pct, held_pct, avg_ret_pct}; e.g. 'TRIPLE_SR_SUPPORT'.hit_pct = Triple S/R support bounce %."""
    acc = defaultdict(list)
    for lab in labels:
        acc[lab["flag"]].append(lab)
    out = {}
    for flag, rows in sorted(acc.items()):
        n = len(rows)
        out[flag] = {"n": n, "hit_pct": round(100 * sum(r["hit"] for r in rows) / n, 2),
                     "held_pct": round(100 * sum(r["held"] for r in rows) / n, 2),
                     "avg_ret_pct": round(sum(r["ret_pct"] for r in rows) / n, 3)}
    return out
