"""Black-Scholes price, greeks and implied vol (no scipy). Theta is returned as positive decay per day."""
from __future__ import annotations

import math

RATE = 0.07


def _cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _d(S, K, T, r, v):
    d1 = (math.log(S / K) + (r + 0.5 * v * v) * T) / (v * math.sqrt(T))
    return d1, d1 - v * math.sqrt(T)


def price(S, K, T, v, call=True, r=RATE) -> float:
    if T <= 0 or v <= 0:
        return max(S - K, 0.0) if call else max(K - S, 0.0)
    d1, d2 = _d(S, K, T, r, v)
    disc = K * math.exp(-r * T)
    return S * _cdf(d1) - disc * _cdf(d2) if call else disc * _cdf(-d2) - S * _cdf(-d1)


def greeks(S, K, T, v, call=True, r=RATE) -> dict:
    """delta, gamma, theta (decay per calendar day, positive number), vega per 1.00 vol."""
    if T <= 0 or v <= 0:
        itm = (S > K) if call else (S < K)
        return {"delta": (1.0 if call else -1.0) if itm else 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    d1, d2 = _d(S, K, T, r, v)
    sq = math.sqrt(T)
    disc = K * math.exp(-r * T)
    common = -S * _pdf(d1) * v / (2 * sq)
    th = common - r * disc * _cdf(d2) if call else common + r * disc * _cdf(-d2)
    return {
        "delta": _cdf(d1) if call else _cdf(d1) - 1.0,
        "gamma": _pdf(d1) / (S * v * sq),
        "theta": -th / 365.0,
        "vega": S * _pdf(d1) * sq,
    }


def implied_vol(premium, S, K, T, call=True, r=RATE):
    """Bisection IV; None when the premium is at/below intrinsic or the inputs are unusable."""
    if premium is None or premium <= 0 or T <= 0 or S <= 0 or K <= 0:
        return None
    lo, hi = 1e-3, 4.0
    if premium <= price(S, K, T, lo, call, r) + 1e-9 or premium >= price(S, K, T, hi, call, r):
        return None
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if price(S, K, T, mid, call, r) < premium:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)
