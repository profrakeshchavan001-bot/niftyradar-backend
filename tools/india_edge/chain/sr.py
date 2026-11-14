"""Chain support/resistance, colour tags and the PCR bar.

Support looks at PE strikes at or below spot; resistance at CE strikes at or above spot (ties go to the
strike nearest spot). Only strikes with a positive value qualify.
"""
from __future__ import annotations

from .model import Chain

METRICS = ("oi", "vol", "chg")


def _side(chain: Chain, side: str):
    if side == "pe":
        return [r for r in chain.rows if r.strike <= chain.spot]
    return [r for r in chain.rows if r.strike >= chain.spot]


def _val(r, side: str, metric: str) -> float:
    return getattr(r, f"{side}_{metric}")


def pick(chain: Chain, side: str, metric: str):
    """Strike with the highest metric on that side (None if nothing positive)."""
    cand = [r for r in _side(chain, side) if _val(r, side, metric) > 0]
    if not cand:
        return None
    best = max(cand, key=lambda r: (_val(r, side, metric), -abs(r.strike - chain.spot)))
    return best.strike


def support_resistance(chain: Chain) -> dict:
    """{"support": {oi, vol, chg}, "resistance": {oi, vol, chg}} strikes, plus primary = by OI."""
    sup = {m: pick(chain, "pe", m) for m in METRICS}
    res = {m: pick(chain, "ce", m) for m in METRICS}
    return {"support": sup, "resistance": res, "primary_support": sup["oi"], "primary_resistance": res["oi"]}


def colour_tags(chain: Chain, side: str, metric: str = "oi") -> dict:
    """strike -> tag. CE side: top=red; PE side: top=green; 2nd = yellow; >=75% of the top = light_yellow."""
    rows = [r for r in _side(chain, side) if _val(r, side, metric) > 0]
    rows.sort(key=lambda r: (-_val(r, side, metric), abs(r.strike - chain.spot)))
    tags: dict[float, str] = {}
    if not rows:
        return tags
    top = _val(rows[0], side, metric)
    for i, r in enumerate(rows):
        if i == 0:
            tags[r.strike] = "red" if side == "ce" else "green"
        elif i == 1:
            tags[r.strike] = "yellow"
        elif _val(r, side, metric) >= 0.75 * top:
            tags[r.strike] = "light_yellow"
    return tags


def pcr_bar(chain: Chain) -> dict:
    ce = sum(r.ce_oi for r in chain.rows)
    pe = sum(r.pe_oi for r in chain.rows)
    pcr = pe / ce if ce else 0.0
    colour = "green" if pcr > 1.2 else "red" if pcr < 0.8 else "grey"
    return {"pcr": round(pcr, 4), "colour": colour, "pe_share": round(pe / (pe + ce), 4) if pe + ce else 0.0}


def fresh_writing_share(chain: Chain) -> dict:
    """Share of positive OI additions that came from PE (pe_share) and the raw sums."""
    pe = sum(max(r.pe_chg, 0) for r in chain.rows)
    ce = sum(max(r.ce_chg, 0) for r in chain.rows)
    return {"pe_add": pe, "ce_add": ce, "pe_share": 100.0 * pe / (pe + ce) if pe + ce else 50.0}
