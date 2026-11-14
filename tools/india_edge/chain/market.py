"""Market overview score, FII+Pro pulse, MMI and the LTP calculator."""
from __future__ import annotations

from . import bs, sr
from .model import Chain

SIGNALS = ("pe_share_nifty", "pe_share_banknifty", "pcr_nifty", "pcr_banknifty",
           "premium_nifty", "premium_5_indices", "sectors", "breadth")


def _vote(value: float, hi: float, lo: float, strict: bool = False) -> int:
    if (value > hi) if strict else (value >= hi):
        return 1
    if (value < lo) if strict else (value <= lo):
        return -1
    return 0


def basis_change(today: dict, prev: dict, symbol: str):
    """Futures premium (fut - spot) today minus yesterday for one index; None when data is missing."""
    a, b = today.get(symbol), prev.get(symbol)
    if not a or not b:
        return None
    return (a["fut"] - a["spot"]) - (b["fut"] - b["spot"])


def overview_signals(nifty: Chain, banknifty: Chain, fut_today: dict, fut_prev: dict,
                     sector_pct: dict, advancers_pct: float) -> dict:
    """The eight +1/0/-1 signals."""
    sig = {}
    for name, ch in (("nifty", nifty), ("banknifty", banknifty)):
        sig[f"pe_share_{name}"] = _vote(sr.fresh_writing_share(ch)["pe_share"], 60, 40)
        sig[f"pcr_{name}"] = _vote(sr.pcr_bar(ch)["pcr"], 1.2, 0.8, strict=True)
    d = basis_change(fut_today, fut_prev, "NIFTY")
    sig["premium_nifty"] = 0 if d is None else (1 if d > 0 else -1 if d < 0 else 0)
    ds = [basis_change(fut_today, fut_prev, s) for s in ("NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50")]
    ds = [x for x in ds if x is not None]
    up, dn = sum(x > 0 for x in ds), sum(x < 0 for x in ds)
    sig["premium_5_indices"] = 1 if up >= 4 else -1 if dn >= 4 else 0
    green = sum(v > 0 for v in sector_pct.values())
    red = sum(v < 0 for v in sector_pct.values())
    sig["sectors"] = 1 if green >= 9 else -1 if red >= 9 else 0
    sig["breadth"] = _vote(advancers_pct, 55, 45)
    return sig


def overview_label(score: float) -> str:
    if score >= 75:
        return "Strong Bull"
    if score >= 60:
        return "Bull"
    if score >= 40:
        return "Neutral"
    if score > 25:
        return "Bear"
    return "Strong Bear"


def overview_score(signals: dict) -> dict:
    net = sum(signals.get(k, 0) for k in SIGNALS)
    score = (net + 8) / 16.0 * 100.0
    return {"net": net, "score": round(score, 2), "label": overview_label(score), "signals": dict(signals)}


def fii_pulse(today: dict, prev: dict) -> dict:
    """FII + Pro combined net position change vs yesterday. Index futures up = bull, index calls up = bull,
    index puts up = bear, stock futures up = bull. One +1/0/-1 point each."""
    def net(d: dict, long_k: str, short_k: str) -> float:
        return sum(d.get(c, {}).get(long_k, 0) - d.get(c, {}).get(short_k, 0) for c in ("FII", "Pro"))

    def delta(a: str, b: str) -> float:
        return net(today, a, b) - net(prev, a, b)

    def sgn(x):
        return (x > 0) - (x < 0)

    pts = {
        "index_futures": sgn(delta("idx_fut_long", "idx_fut_short")),
        "index_calls": sgn(delta("idx_ce_long", "idx_ce_short")),
        "index_puts": -sgn(delta("idx_pe_long", "idx_pe_short")),
        "stock_futures": sgn(delta("stk_fut_long", "stk_fut_short")),
    }
    total = sum(pts.values())
    return {"points": pts, "total": total, "bias": "bull" if total >= 2 else "bear" if total <= -2 else "neutral"}


def mmi(pcr: float, pe_share: float, advancers_pct: float, sectors_green: int, n_sectors: int,
        overview: float, pulse_total: int) -> dict:
    """Own 0-100 sentiment index: mean of six components scaled to 0-1 (PCR 0.5..1.5, PE share, advancers,
    sector breadth, overview score, FII+Pro pulse -4..+4). <30 fear, <50 cautious, <70 optimistic, else euphoria."""
    clip = lambda x: min(max(x, 0.0), 1.0)  # noqa: E731
    parts = [clip(pcr - 0.5), clip(pe_share / 100.0), clip(advancers_pct / 100.0),
             sectors_green / n_sectors if n_sectors else 0.5, clip(overview / 100.0), (pulse_total + 4) / 8.0]
    v = 100.0 * sum(parts) / len(parts)
    zone = "fear" if v < 30 else "cautious" if v < 50 else "optimistic" if v < 70 else "euphoria"
    return {"mmi": round(v, 2), "zone": zone}


def ltp_calc(chain: Chain, strike: float, call: bool, support: float, resistance: float,
             iv: float | None = None, days_ahead: float = 1.0) -> dict | None:
    """Option LTP at the target and at the stop from a delta + gamma - theta approximation.
    width = R - S; target = full width, stop = half width, measured from spot (calls up, puts down)."""
    row = chain.row(strike)
    ltp = (row.ce_ltp if call else row.pe_ltp) if row else 0.0
    if ltp <= 0:
        return None
    iv = iv or bs.implied_vol(ltp, chain.spot, strike, chain.years, call)
    if not iv:
        return None
    g = bs.greeks(chain.spot, strike, chain.years, iv, call)
    width = resistance - support
    sign = 1 if call else -1

    def at(ds: float) -> float:
        return max(0.05, ltp + g["delta"] * ds + 0.5 * g["gamma"] * ds * ds - g["theta"] * days_ahead)

    return {"ltp": ltp, "width": width, "target_spot": chain.spot + sign * width, "stop_spot": chain.spot - sign * width / 2,
            "ltp_at_target": at(sign * width), "ltp_at_stop": at(-sign * width / 2), "iv": iv, **g}
