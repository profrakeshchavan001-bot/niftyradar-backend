"""Screeners. Statistics on chain data only, never advice. Assumptions are logged in docs/DECISIONS-CC12.md."""
from __future__ import annotations

from .model import Chain
from . import sr as _sr

TOUCH_TOL = 0.0005        # 0.05 %
COOLDOWN_S = 600          # 10 minutes
OI2OI_ENTRY_TOL = 0.005   # price within 0.5 % of the max-PE/CE OI strike
OI2OI_MIN_SL = 0.003      # stop must be at least 0.3 % away ("2nd strike far")
POWER_RATIO = 2.5         # fresh PE adds >= 2.5x CE adds (and mirror)
TRAP_WINDOW = ("09:30", "14:30")


# ---- S/R Stocks: price touching the reversal level -------------------------------------------
class SrStocksScanner:
    """Feed ticks (ts seconds, price). One alert per (symbol, side) per cooldown; count = repeat badge."""

    def __init__(self, tol: float = TOUCH_TOL, cooldown_s: int = COOLDOWN_S):
        self.tol, self.cooldown_s = tol, cooldown_s
        self._last: dict = {}
        self._count: dict = {}

    def on_tick(self, symbol: str, ts: float, price: float, reversal_s, reversal_r) -> list[dict]:
        out = []
        for side, lvl in (("support", reversal_s), ("resistance", reversal_r)):
            if not lvl or abs(price - lvl) / lvl > self.tol:
                continue
            key = (symbol, side)
            if key in self._last and ts - self._last[key] < self.cooldown_s:
                continue
            self._last[key] = ts
            self._count[key] = self._count.get(key, 0) + 1
            n = self._count[key]
            out.append({"symbol": symbol, "side": side, "level": lvl, "price": price,
                        "count": n, "badge": f"x{n}" if n > 1 else "", "ts": ts})
        return out


# ---- Triple S/R ------------------------------------------------------------------------------
def triple_sr(chain: Chain) -> dict:
    """Same strike has max OI + max volume + max OI-change on the PE side (support) or CE side (resistance)."""
    s = _sr.support_resistance(chain)
    out = {"support": None, "resistance": None}
    for side, key in (("support", "support"), ("resistance", "resistance")):
        k = s[key]
        if k["oi"] is not None and k["oi"] == k["vol"] == k["chg"]:
            out[side] = k["oi"]
    return out


# ---- Power Stocks ----------------------------------------------------------------------------
def power_stock(chain: Chain) -> str | None:
    """'bull': one-sided fresh PE writing (PE adds >= 2.5x CE adds, the support strike is also the top
    PE OI-change strike with a positive change, PCR >= 1). 'bear' mirrors it on the CE side."""
    f = _sr.fresh_writing_share(chain)
    pcr = _sr.pcr_bar(chain)["pcr"]
    s = _sr.support_resistance(chain)
    if f["pe_add"] > 0 and f["pe_add"] >= POWER_RATIO * f["ce_add"] and pcr >= 1.0 \
            and s["primary_support"] is not None and s["primary_support"] == s["support"]["chg"]:
        return "bull"
    if f["ce_add"] > 0 and f["ce_add"] >= POWER_RATIO * f["pe_add"] and 0 < pcr <= 1.0 \
            and s["primary_resistance"] is not None and s["primary_resistance"] == s["resistance"]["chg"]:
        return "bear"
    return None


# ---- Oi2Oi -----------------------------------------------------------------------------------
def _second(chain: Chain, side: str, first: float):
    """Second-highest OI strike on the same side, beyond `first` (below for PE, above for CE)."""
    if side == "pe":
        cand = [r for r in chain.rows if r.strike < first and r.pe_oi > 0]
        return max(cand, key=lambda r: r.pe_oi).strike if cand else None
    cand = [r for r in chain.rows if r.strike > first and r.ce_oi > 0]
    return max(cand, key=lambda r: r.ce_oi).strike if cand else None


def oi2oi(chain: Chain) -> dict | None:
    """Long: price at the max-PE-OI strike, max-CE-OI strike far above (room), 2nd PE strike far below
    (stop). Skipped when room < SL. Short mirrors with CE/PE swapped."""
    s = _sr.support_resistance(chain)
    spot = chain.spot
    sup, res = s["primary_support"], s["primary_resistance"]
    if sup is not None and res is not None and abs(spot - sup) / spot <= OI2OI_ENTRY_TOL:
        sl_k = _second(chain, "pe", sup)
        sl = spot - sl_k if sl_k is not None else chain.step
        room = res - spot
        if sl / spot >= OI2OI_MIN_SL and room >= sl:
            return {"side": "long", "entry": spot, "room": room, "sl": sl, "target": res, "stop": spot - sl}
    if sup is not None and res is not None and abs(spot - res) / spot <= OI2OI_ENTRY_TOL:
        sl_k = _second(chain, "ce", res)
        sl = sl_k - spot if sl_k is not None else chain.step
        room = spot - sup
        if sl / spot >= OI2OI_MIN_SL and room >= sl:
            return {"side": "short", "entry": spot, "room": room, "sl": sl, "target": sup, "stop": spot + sl}
    return None


# ---- Big Bull / Big Bear ---------------------------------------------------------------------
def trap_signal(chain: Chain) -> list[str]:
    """Big Bull: max ITM call OI (strike < spot) exceeds the max call OI at/above spot -> trapped writers.
    Big Bear: max ITM put OI (strike > spot) exceeds the max put OI at/below spot."""
    out = []
    itm_ce = max((r.ce_oi for r in chain.rows if r.strike < chain.spot), default=0)
    otm_ce = max((r.ce_oi for r in chain.rows if r.strike >= chain.spot), default=0)
    itm_pe = max((r.pe_oi for r in chain.rows if r.strike > chain.spot), default=0)
    otm_pe = max((r.pe_oi for r in chain.rows if r.strike <= chain.spot), default=0)
    if itm_ce > otm_ce > 0:
        out.append("BIG_BULL")
    if itm_pe > otm_pe > 0:
        out.append("BIG_BEAR")
    return out


class TrapScanner:
    """Intraday gate for Big Bull/Bear: only 09:30-14:30, once per side per symbol per day."""

    def __init__(self, window=TRAP_WINDOW):
        self.window = window
        self._fired: set = set()

    def scan(self, chain: Chain, hhmm: str) -> list[str]:
        if not (self.window[0] <= hhmm <= self.window[1]):
            return []
        out = []
        for sig in trap_signal(chain):
            key = (chain.date, chain.symbol, sig)
            if key not in self._fired:
                self._fired.add(key)
                out.append(sig)
        return out
