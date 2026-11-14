"""Reversal price from option premiums.

For strike K (step d) support level = underlying price where CE(K) premium == PE(K-d) premium;
resistance level = price where CE(K+d) == PE(K). gap = CE - PE; a gap-zero cross is a level break.
Premiums are re-priced with Black-Scholes using per-strike IV backed out of the traded premiums
(India VIX as fallback), so the level solve and the delta projection both work from one chain.
"""
from __future__ import annotations

from . import bs
from .model import Chain


def _iv(chain: Chain, strike: float, call: bool, vix: float) -> float:
    r = chain.row(strike)
    ltp = (r.ce_ltp if call else r.pe_ltp) if r else 0.0
    iv = bs.implied_vol(ltp, chain.spot, strike, chain.years, call)
    return iv if iv else max(vix, 1.0) / 100.0


def _pair(chain: Chain, ce_k: float, pe_k: float, vix: float):
    ce_iv, pe_iv = _iv(chain, ce_k, True, vix), _iv(chain, pe_k, False, vix)
    T = chain.years

    def gap_at(S: float) -> float:
        return bs.price(S, ce_k, T, ce_iv, True) - bs.price(S, pe_k, T, pe_iv, False)

    return gap_at, ce_iv, pe_iv


def _solve(gap_at, spot: float):
    """gap_at is increasing in S (call up, put down): bisection on a +-30% bracket."""
    lo, hi = spot * 0.7, spot * 1.3
    if gap_at(lo) > 0 or gap_at(hi) < 0:
        return None
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if gap_at(mid) < 0:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def level(chain: Chain, ce_k: float, pe_k: float, vix: float = 15.0) -> dict | None:
    """Reversal level for the (CE strike, PE strike) pair; None if a premium or strike is missing."""
    rc, rp = chain.row(ce_k), chain.row(pe_k)
    if not rc or not rp or rc.ce_ltp <= 0 or rp.pe_ltp <= 0:
        return None
    gap_at, ce_iv, pe_iv = _pair(chain, ce_k, pe_k, vix)
    gap = rc.ce_ltp - rp.pe_ltp                     # market gap at today's spot
    T = chain.years
    d_ce = bs.greeks(chain.spot, ce_k, T, ce_iv, True)["delta"]
    d_pe = bs.greeks(chain.spot, pe_k, T, pe_iv, False)["delta"]
    slope = d_ce + abs(d_pe)                        # d(gap)/dS: call delta plus magnitude of put delta
    proj = chain.spot - gap / slope if slope > 0 else None
    return {"ce_strike": ce_k, "pe_strike": pe_k, "gap": round(gap, 4), "level": _solve(gap_at, chain.spot),
            "projection": proj, "delta_ce": d_ce, "delta_pe": d_pe}


def support_level(chain: Chain, k: float, vix: float = 15.0):
    return level(chain, k, k - chain.step, vix)          # CE(K) == PE(K-d)


def resistance_level(chain: Chain, k: float, vix: float = 15.0):
    return level(chain, k + chain.step, k, vix)          # CE(K+d) == PE(K)


def gap_cross(prev_gap: float | None, gap: float | None) -> str | None:
    """'down' when CE-PE flips + -> - (price fell through the level), 'up' for - -> +."""
    if prev_gap is None or gap is None or prev_gap == 0 or gap == 0:
        return None
    if prev_gap > 0 > gap:
        return "down"
    if prev_gap < 0 < gap:
        return "up"
    return None
