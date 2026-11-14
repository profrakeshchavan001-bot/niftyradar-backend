import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from scores import data  # noqa: E402


def mk(closes: dict, volume=1e6, deliv=50.0, nifty=None, sectors=None, fund=None, fo=None, vix=None, high_pad=0.0,
       end="2026-10-28"):
    """Panels from {symbol: array of closes}. Open = prior close, high/low = close +/- high_pad."""
    n = len(next(iter(closes.values())))
    d = pd.bdate_range(end=end, periods=n)
    rows = []
    for s, arr in closes.items():
        arr = np.asarray(arr, float)
        v = np.full(n, volume) if np.isscalar(volume) else np.asarray(volume[s], float)
        rows.append(pd.DataFrame({"date": d, "symbol": s, "prev_close": np.r_[arr[0], arr[:-1]],
                                  "open": np.r_[arr[0], arr[:-1]], "high": arr * (1 + high_pad), "low": arr * (1 - high_pad),
                                  "close": arr, "volume": v, "deliv_pct": deliv if np.isscalar(deliv) else deliv[s]}))
    cash = pd.concat(rows, ignore_index=True)
    nf = np.full(n, 20000.0) if nifty is None else np.asarray(nifty, float)
    idx = pd.DataFrame({"date": d, "index_name": "Nifty 50", "close": nf})
    if vix is not None:
        idx = pd.concat([idx, pd.DataFrame({"date": d, "index_name": "India VIX", "close": vix})])
    sec = sectors or {s: "S" for s in closes}
    return data.Panels(cash, idx, sec, fo, fund)


def fixture_panels():
    return data.load()
