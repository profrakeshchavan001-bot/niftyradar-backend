import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from india_edge.chain.model import Chain, Strike  # noqa: E402


def chain(spot, ce=None, pe=None, ce_chg=None, pe_chg=None, ce_vol=None, pe_vol=None, strikes=None,
          date="2026-10-01", expiry="2026-10-29", symbol="TEST"):
    """Hand-made chain; dict args are strike -> value."""
    ks = sorted(set(strikes or []) | set((ce or {})) | set((pe or {})) | set(ce_chg or {}) | set(pe_chg or {}) | set(ce_vol or {}) | set(pe_vol or {}))
    g = lambda d, k: (d or {}).get(k, 0)  # noqa: E731
    return Chain(symbol, date, expiry, spot, [
        Strike(k, g(ce, k), g(ce_vol, k), g(ce_chg, k), 0.0, g(pe, k), g(pe_vol, k), g(pe_chg, k), 0.0) for k in ks])
