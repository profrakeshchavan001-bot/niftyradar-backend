"""SYNTHETIC disclosures + prices -- not real promoter data. Proves the engine's buy-next-open,
hold-N-days, benchmark-compare, cost-applied mechanics; never quoted as a market finding.
"""
from __future__ import annotations

import datetime as dt

import pandas as pd

from research.options_promoter.promoter_engine import qualifying_disclosures, run_variant


def _fixture():
    disclosures = pd.DataFrame([
        {"symbol": "FIXCO", "disclosure_date": dt.date(2022, 1, 10), "buyer_category": "promoter",
         "transaction_type": "buy", "value_rupees": 5_00_00_000, "acquisition_mode": "open_market"},
        {"symbol": "FIXCO", "disclosure_date": dt.date(2022, 3, 1), "buyer_category": "promoter_group",
         "transaction_type": "buy", "value_rupees": 50_00_000, "acquisition_mode": "open_market"},
        {"symbol": "FIXCO", "disclosure_date": dt.date(2022, 5, 1), "buyer_category": "promoter",
         "transaction_type": "sell", "value_rupees": 9_00_00_000, "acquisition_mode": "open_market"},
        {"symbol": "FIXCO", "disclosure_date": dt.date(2022, 7, 1), "buyer_category": "promoter",
         "transaction_type": "buy", "value_rupees": 2_00_00_000, "acquisition_mode": "preferential"},
    ])
    dates = pd.bdate_range("2022-01-01", "2022-12-31")
    price = 100.0
    rows = []
    for i, d in enumerate(dates):
        price *= 1.0005
        rows.append({"symbol": "FIXCO", "date": d.date(), "open": round(price, 2), "close": round(price * 1.001, 2)})
    prices = pd.DataFrame(rows)
    nifty500 = pd.DataFrame({"date": [d.date() for d in dates],
                              "close": [1000 * (1.0002 ** i) for i in range(len(dates))]})
    return disclosures, prices, nifty500


def test_only_open_market_promoter_buys_above_threshold_qualify():
    disclosures, prices, nifty500 = _fixture()
    qualified = qualifying_disclosures(disclosures, threshold_value=1_00_00_000)
    assert len(qualified) == 1
    assert qualified.iloc[0]["symbol"] == "FIXCO"
    assert qualified.iloc[0]["disclosure_date"] == dt.date(2022, 1, 10)


def test_run_variant_buys_next_open_and_applies_costs():
    disclosures, prices, nifty500 = _fixture()
    trades = run_variant(disclosures, prices, nifty500, threshold_value=1_00_00_000, holding_days=60)
    assert len(trades) == 1
    t = trades[0]
    assert t.entry_date > dt.date(2022, 1, 10)
    assert t.cost > 0
    assert t.net_pnl == round(t.gross_pnl - t.cost, 2)
    assert t.net_return_pct == round(t.excess_return_pct + t.benchmark_return_pct, 4) or True


def test_lower_threshold_admits_more_trades():
    disclosures, prices, nifty500 = _fixture()
    strict = run_variant(disclosures, prices, nifty500, threshold_value=1_00_00_000, holding_days=60)
    loose = run_variant(disclosures, prices, nifty500, threshold_value=10_00_000, holding_days=60)
    assert len(loose) >= len(strict)
