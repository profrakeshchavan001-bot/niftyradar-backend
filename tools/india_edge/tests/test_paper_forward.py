"""Forward-test harness: survivors-only logging, --all research mode, idempotent re-runs (regression: DataFrame.asof attribute
clash), legacy ledgers, daily summary file, BANKNIFTY configuration. Synthetic chains in a temp folder; no network."""
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

WEEKLY2T = {"weekly": True, "entry_tdays": 2, "exit_dte": -1, "unstable_dte": -1}


@pytest.fixture()
def env(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        _fixture(tmp, n=140)
        monkeypatch.setattr(R, "DATA_DIR", tmp)
        monkeypatch.setattr(PF, "DATA_DIR", tmp)
        monkeypatch.setattr(PF, "LEDGER", tmp / "out" / "ledger.csv")
        monkeypatch.setattr(PF, "SUMMARY_DIR", tmp / "out")
        monkeypatch.setattr(PF, "SURVIVORS", tmp / "survivors.json")
        monkeypatch.setattr(PF, "STATS", {"NIFTY": tmp / "stats.json", "BANKNIFTY": tmp / "none.json"})
        R.configure("NIFTY", 2.0)
        yield tmp
        R.configure("NIFTY", 2.0)


def _surv(tmp, items):
    (tmp / "survivors.json").write_text(json.dumps({"survivors": items}), encoding="utf-8")


def test_no_survivors_logs_marker_summary_and_is_idempotent(env):
    _surv(env, [])
    PF.main(["--no-fetch"])
    PF.main(["--no-fetch"])  # second run used to crash: d.asof is a DataFrame method, not the column
    led = pd.read_csv(PF.LEDGER)
    assert list(led.kind) == ["NO_SURVIVORS"]
    assert "NO_SURVIVORS" in (env / "out" / "cc8_daily_summary_latest.txt").read_text(encoding="utf-8")


def test_missing_survivors_file_means_none(env):
    assert PF.load_survivors(env / "absent.json") == []
    PF.main(["--no-fetch"])
    assert list(pd.read_csv(PF.LEDGER).kind) == ["NO_SURVIVORS"]


def test_only_listed_survivors_are_logged_and_summary_written(env):
    _surv(env, [{"label": "2-trading-day strangle d18", "symbol": "NIFTY", "structure": "strangle_d18", "params": WEEKLY2T}])
    PF.main(["--no-fetch"])
    led = pd.read_csv(PF.LEDGER)
    assert set(led.strategy) == {"strangle_d18"} and set(led.variant) == {"2-trading-day strangle d18"}
    assert set(led.verdict) == {"survivor"} and "NO_SURVIVORS" not in set(led.kind)
    assert led.kind.isin({"POSITION_OPEN", "HYPOTHETICAL_EXIT", "PLAN_ENTRY", "NO_SIGNAL"}).all()
    txt = (env / "out" / "cc8_daily_summary_latest.txt").read_text(encoding="utf-8")
    assert "PAPER ONLY" in txt and "NIFTY 2-trading-day strangle d18" in txt
    assert any(p.name.startswith("cc8_daily_summary_2") for p in (env / "out").iterdir())
    n = len(led)
    PF.main(["--no-fetch"])
    assert len(pd.read_csv(PF.LEDGER)) == n  # same asof + same rows -> nothing appended


def test_symbol_filter_skips_other_index(env):
    _surv(env, [{"label": "monthly condor", "symbol": "BANKNIFTY", "structure": "condor", "params": {}}])
    PF.main(["--no-fetch", "--symbol", "NIFTY"])
    assert list(pd.read_csv(PF.LEDGER).kind) == ["NO_SURVIVORS"]


def test_all_logs_every_monthly_structure_with_its_verdict(env):
    (env / "stats.json").write_text(json.dumps({"strategies": {"condor": {"verdict": "dies"}}}), encoding="utf-8")
    _surv(env, [])
    PF.main(["--all", "--symbol", "NIFTY", "--no-fetch"])
    led = pd.read_csv(PF.LEDGER)
    assert set(led.strategy) == set(R.DEFAULTS)
    assert set(led[led.strategy == "condor"].verdict) == {"dies"}
    assert set(led[led.strategy == "calendar"].verdict) == {"unknown"}


def test_legacy_ledger_without_symbol_and_variant_is_upgraded(env):
    _surv(env, [])
    PF.LEDGER.parent.mkdir(exist_ok=True)
    pd.DataFrame([{"logged_at": "x", "asof": "2019-01-01", "strategy": "-", "verdict": "-", "kind": "NO_SURVIVORS",
                   "detail": "old"}]).to_csv(PF.LEDGER, index=False)
    PF.main(["--no-fetch"])
    led = pd.read_csv(PF.LEDGER)
    assert len(led) == 2 and led.symbol[0] == "NIFTY" and list(led.columns) == PF.COLS


def test_summary_text_lists_open_exit_and_plan(tmp_path):
    asof = pd.Timestamp("2026-10-30")
    s = [{"label": "NIFTY x", "asof": asof, "closed": 3, "closed_net": 1234,
          "open": [{"entered": "2026-10-27", "expiry": "2026-10-29", "open_pnl_inr": -50}],
          "exits": [{"exit": "2026-10-30", "reason": "EXPIRY", "net": 700}],
          "plan": {"indicative_net_credit_inr": 4000, "margin_est_inr": 170000}}]
    t = PF.write_summary(s, asof, "now", tmp_path)
    assert "open P&L Rs -50" in t and "EXPIRY net Rs 700" in t and "PLAN next session" in t
    assert (tmp_path / "cc8_daily_summary_2026-10-30.txt").exists()


def test_survivors_file_in_repo_is_valid():
    items = json.loads(PF.SURVIVORS.read_text(encoding="utf-8"))["survivors"]
    assert items and all({"label", "symbol", "structure"} <= set(i) for i in items)
    assert all(i["symbol"] in PF.STATS and i["structure"] in R.DEFAULTS for i in items)


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
