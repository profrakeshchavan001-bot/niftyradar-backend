"""Real-data options engine: implied-vol/delta round trip, doubled costs, strike choice and no-lookahead (truncation).
Fixtures are synthetic chains written to a temp folder (test scaffolding only; the engine itself never prices with BS)."""
import math
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backtest"))
import options_real as R  # noqa: E402
import options_yt as oy  # noqa: E402


def _fixture(tmp: Path, n=330, seed=5):
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2019-01-01", periods=n)
    spot = 11000 * np.exp(np.cumsum(rng.normal(0.0003, 0.008, n)))
    (tmp / "idxopt").mkdir(parents=True)
    (tmp / "nifty").mkdir()
    pd.DataFrame({"date": days, "open": spot, "high": spot * 1.003, "low": spot * 0.997, "close": spot}).to_csv(
        tmp / "nifty" / "nifty50_ohlc.csv", index=False)
    exps = []
    for p in pd.period_range(days[0], days[-1] + pd.Timedelta(days=120), freq="M"):
        e = p.to_timestamp(how="end").normalize()
        while e.weekday() != 3:
            e -= pd.Timedelta(days=1)
        exps.append(e)
    for d, s in zip(days, spot):
        rows = []
        for e in exps:
            T = (e - d).days
            if T < 0 or T > 100:
                continue
            for k in np.arange(round(s / 50) * 50 - 1500, round(s / 50) * 50 + 1550, 50.0):
                for cp in "CP":
                    px = oy.bs(s, k, max(T, 0) / 365, 0.15, cp)
                    rows.append((d, "NIFTY", "O", e.strftime("%Y-%m-%d"), k, cp, px, px, px, px, px, 100, 1000, 0, s))
        pd.DataFrame(rows, columns=["date", "symbol", "kind", "expiry", "strike", "opt_type", "open", "high", "low",
                                    "close", "settle", "volume", "oi", "chg_oi", "underlying"]).to_parquet(
            tmp / "idxopt" / f"{d:%Y-%m-%d}.parquet", index=False)
    return list(days)


def test_iv_delta_round_trip():
    S, K, T, s = 20000.0, 20500.0, 0.12, 0.17
    px = oy.bs(S, K, T, s, "C")
    iv, dl = R.iv_delta(np.array([px]), S, np.array([K]), T, np.array([True]))
    assert abs(iv[0] - s) < 1e-3 and abs(dl[0] - oy.delta_abs(S, K, T, s, "C")) < 1e-3


def test_costs_are_doubled():
    assert math.isclose(R.cost(100.0, True), 2 * oy.txn_cost(100.0, True))


def test_truncation_does_not_change_earlier_trades():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        days = _fixture(tmp)
        R.DATA_DIR = tmp
        R.spot_table.cache_clear()
        cut = days[240]
        for name in ("condor", "strangle_d18", "calendar"):
            full, *_ = R.run(name, days)
            part, *_ = R.run(name, [d for d in days if d <= cut])
            a = [(t["entry"], t["exit"], t["net"]) for t in full if t["exit"] < cut]
            b = [(t["entry"], t["exit"], t["net"]) for t in part if t["exit"] < cut]
            assert a == b and a, name
        R.spot_table.cache_clear()


def test_entry_uses_previous_session_chain_only():
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        days = _fixture(tmp)
        R.DATA_DIR = tmp
        R.spot_table.cache_clear()
        trades, *_ = R.run("strangle_d18", days[:200])
        first = trades[0]
        prev = R.Day(days[days.index(first["entry"]) - 1])
        assert first["entry"] > prev.date and abs(first["spot_entry"] - prev.S_close) < 1e-6
        R.spot_table.cache_clear()
