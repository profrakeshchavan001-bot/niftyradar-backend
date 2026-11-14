"""options_real_more helpers (summary, regime split, re-selecting walk-forward) and the BANKNIFTY spot builder
(real close first, put-call-parity fallback). Synthetic data in a temp folder; no network."""
import math
import sys
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "backtest"))
sys.path.insert(0, str(HERE.parent / "data"))
import build_banknifty_spot as B  # noqa: E402
import options_real as R  # noqa: E402
import options_real_more as M  # noqa: E402
from test_options_real import _fixture  # noqa: E402


def test_summ_handles_empty_and_win_rate():
    assert M.summ(pd.DataFrame({"net": []})) == {"trades": 0}
    s = M.summ(pd.DataFrame({"net": [10.0, -5.0, 20.0, 0.0]}))
    assert s == {"trades": 4, "total_inr": 25, "win_pct": 50.0}


def test_walk_forward_reselects_on_trailing_three_years_only():
    # grid cell 0 wins every past year but loses in the traded year; cell 1 is the opposite
    def cell(past, now):
        rows = [(pd.Timestamp(y, 6, 1), past) for y in range(2015, 2026)] + [(pd.Timestamp(2026, 6, 1), now)]
        return pd.DataFrame(rows, columns=["entry", "net"])
    cells = {("X", "condor", i): cell(*v) for i, v in enumerate([(10.0, -100.0), (1.0, 7.0), (0.0, 0.0), (0.0, 0.0)])}
    cells.update({("X", "strangle_d18", i): cell(1.0, 1.0) for i in range(5)})
    out = M.walk_forward("X", cells)["condor"]
    assert out["picked"]["2026"] == M.WF_GRIDS["condor"][0]  # chosen from 2023-2025 only, not from 2026
    assert out["years_net_inr"]["2026"] == -100
    assert out["n_years"] == 9


def _bank_fixture(tmp, close_days):
    days = _fixture(tmp, n=60)
    spot = pd.read_csv(tmp / "nifty" / "nifty50_ohlc.csv", parse_dates=["date"]).set_index("date").close
    for d in days:  # relabel the synthetic chain as BANKNIFTY (option files are per day)
        f = tmp / "idxopt" / f"{d:%Y-%m-%d}.parquet"
        x = pd.read_parquet(f)
        x["symbol"] = "BANKNIFTY"
        x.to_parquet(f, index=False)
    (tmp / "idx").mkdir()
    for d in days:
        if d in close_days:
            pd.DataFrame({"index_name": ["Nifty Bank"], "close": [float(spot[d])]}).to_parquet(
                tmp / "idx" / f"{d:%Y-%m-%d}.parquet", index=False)
    return days, spot


def test_spot_builder_uses_real_close_then_parity(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        days, spot = _bank_fixture(tmp, close_days=set())
        have = set(days[:30])
        for d in days[30:]:
            (tmp / "idx" / f"{d:%Y-%m-%d}.parquet").unlink(missing_ok=True)
        # rewrite: real closes only for the first 30 sessions
        for d in days[:30]:
            pd.DataFrame({"index_name": ["Nifty Bank"], "close": [float(spot[d])]}).to_parquet(
                tmp / "idx" / f"{d:%Y-%m-%d}.parquet", index=False)
        monkeypatch.setattr(B, "DATA_DIR", tmp)
        B.main()
        out = pd.read_csv(tmp / "nifty" / "banknifty_ohlc.csv", parse_dates=["date"]).set_index("date")
        assert len(out) == len(days)
        assert set(out.source[days[:30]]) == {"nse_archive"} and set(out.source[days[30:]]) == {"parity"}
        err = (out.close[days[30:]] / spot[days[30:]] - 1).abs()
        assert err.max() < 0.005  # parity spot within 0.5% of the true close on a clean synthetic chain


def test_parity_spot_returns_none_without_chain(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        (tmp / "idxopt").mkdir()
        d = pd.Timestamp("2020-01-02")
        pd.DataFrame({"symbol": ["NIFTY"], "kind": ["O"], "expiry": ["2020-01-30"], "strike": [1.0], "opt_type": ["C"],
                      "settle": [1.0], "oi": [1]}).to_parquet(tmp / "idxopt" / f"{d:%Y-%m-%d}.parquet", index=False)
        monkeypatch.setattr(B, "DATA_DIR", tmp)
        assert B.parity_spot(d) is None


def test_regime_split_buckets_and_expiry_week(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        days = _fixture(tmp, n=330)
        monkeypatch.setattr(R, "DATA_DIR", tmp)
        monkeypatch.setattr(M, "DATA_DIR", tmp)
        R.configure("NIFTY", 2.0)
        try:
            ex = []
            for d in days[:40]:
                ex.append(pd.read_parquet(tmp / "idxopt" / f"{d:%Y-%m-%d}.parquet", columns=["expiry"]))
            allx = pd.concat(ex).drop_duplicates()
            allx.to_parquet(tmp / "idxopt_nifty.parquet", index=False)
            vix = pd.Series(np.linspace(10, 30, len(days)), index=pd.DatetimeIndex(days))
            tr = pd.DataFrame({"strategy": "calendar", "net": np.arange(1.0, 7.0),
                               "entry": [days[i] for i in (50, 80, 120, 160, 200, 240)]})
            out = M.splits("NIFTY", tr, vix)
            assert len(out["vix_edges_train_terciles"]) == 2
            cal = out["calendar"]
            assert sum(v["trades"] for k, v in cal.items() if k.startswith("vix_")) == 6
            assert sum(v["trades"] for k, v in cal.items() if k in ("monthly_expiry_week", "other_weeks")) == 6
        finally:
            R.configure("NIFTY", 2.0)
