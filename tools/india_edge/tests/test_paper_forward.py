"""Forward-test harness: ledger rows with/without --all, idempotent re-runs (regression: DataFrame.asof attribute clash),
legacy ledgers without a symbol column, and the BANKNIFTY configuration. Synthetic chains in a temp folder; no network."""
import json
import sys
import tempfile
from pathlib import Path

import pandas as pd
import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "backtest"))
import options_real as R  # noqa: E402
import paper_forward as PF  # noqa: E402
from test_options_real import _fixture  # noqa: E402


@pytest.fixture()
def env(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        _fixture(tmp, n=140)
        monkeypatch.setattr(R, "DATA_DIR", tmp)
        monkeypatch.setattr(PF, "DATA_DIR", tmp)
        monkeypatch.setattr(PF, "LEDGER", tmp / "out" / "ledger.csv")
        stats = tmp / "stats.json"
        monkeypatch.setattr(PF, "STATS", {"NIFTY": stats, "BANKNIFTY": tmp / "none.json"})
        R.configure("NIFTY", 2.0)
        yield tmp, stats
        R.configure("NIFTY", 2.0)


def test_no_survivors_logs_single_marker_and_is_idempotent(env):
    tmp, stats = env
    stats.write_text(json.dumps({"strategies": {"condor": {"verdict": "dies"}}}), encoding="utf-8")
    PF.main(["--no-fetch"])
    PF.main(["--no-fetch"])  # second run used to crash: d.asof is a DataFrame method, not the column
    led = pd.read_csv(PF.LEDGER)
    assert list(led.kind) == ["NO_SURVIVORS"] and list(led.symbol) == ["NIFTY"]


def test_all_logs_every_strategy_with_its_verdict(env):
    tmp, stats = env
    stats.write_text(json.dumps({"strategies": {"condor": {"verdict": "dies"}}}), encoding="utf-8")
    PF.main(["--all", "--no-fetch"])
    led = pd.read_csv(PF.LEDGER)
    assert set(led.strategy) == set(R.DEFAULTS)
    assert set(led[led.strategy == "condor"].verdict) == {"dies"}
    assert set(led[led.strategy == "calendar"].verdict) == {"unknown"}
    assert led.kind.isin({"POSITION_OPEN", "HYPOTHETICAL_EXIT", "PLAN_ENTRY", "NO_SIGNAL"}).all()
    n = len(led)
    PF.main(["--all", "--no-fetch"])
    assert len(pd.read_csv(PF.LEDGER)) == n  # same asof + same rows -> nothing appended


def test_legacy_ledger_without_symbol_column_is_upgraded(env):
    tmp, stats = env
    PF.LEDGER.parent.mkdir(exist_ok=True)
    pd.DataFrame([{"logged_at": "x", "asof": "2019-01-01", "strategy": "-", "verdict": "-", "kind": "NO_SURVIVORS",
                   "detail": "old"}]).to_csv(PF.LEDGER, index=False)
    PF.main(["--no-fetch"])
    led = pd.read_csv(PF.LEDGER)
    assert len(led) == 2 and (led.symbol == "NIFTY").all()


def test_configure_switches_symbol_lot_and_costs():
    try:
        R.configure("BANKNIFTY", 1.0)
        assert (R.SYMBOL, R.LOT, R.oy.LOT, R.STRIKE_STEP, R.COST_MULT) == ("BANKNIFTY", 30, 30, 100.0, 1.0)
        assert R.cost(100.0, True) == pytest.approx(R.oy.txn_cost(100.0, True))
    finally:
        R.configure("NIFTY", 2.0)
    assert (R.SYMBOL, R.LOT, R.oy.LOT, R.COST_MULT) == ("NIFTY", 75, 75, 2.0)


def test_refresh_never_raises(monkeypatch):
    import fetch_idxopt
    monkeypatch.setattr(fetch_idxopt, "main", lambda argv=None: (_ for _ in ()).throw(SystemExit(2)))
    PF.refresh()
