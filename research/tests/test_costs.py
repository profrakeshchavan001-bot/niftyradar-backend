import pytest

from costs import crypto_costs, equity_delivery_costs, equity_intraday_costs, futures_costs


def test_equity_delivery_stt_both_legs():
    c = equity_delivery_costs(100_000.0, 110_000.0, slippage_bps=0)
    assert c.stt == pytest.approx(100_000 * 0.001 + 110_000 * 0.001, abs=0.01)
    assert c.stamp_duty == pytest.approx(100_000 * 0.00015, abs=0.01)
    assert c.total > c.stt  # exchange/gst/fees add on top
    assert c.brokerage == 0.0


def test_equity_intraday_stt_sell_side_only():
    c = equity_intraday_costs(100_000.0, 105_000.0, slippage_bps=0)
    assert c.stt == pytest.approx(105_000 * 0.00025, abs=0.01)
    assert c.brokerage > 0


def test_futures_costs_cheaper_than_equity_delivery_on_same_turnover():
    buy, sell = 100_000.0, 105_000.0
    eq = equity_delivery_costs(buy, sell, slippage_bps=0)
    fut = futures_costs(buy, sell, slippage_bps=0)
    assert fut.total < eq.total


def test_crypto_costs_no_indian_taxes():
    c = crypto_costs(100_000.0, 105_000.0, fee_pct=0.1, slippage_bps=0)
    assert c.stt == 0.0
    assert c.gst == 0.0
    assert c.stamp_duty == 0.0
    assert c.brokerage == pytest.approx((100_000 + 105_000) * 0.001, abs=0.01)


def test_costs_scale_with_turnover():
    small = equity_delivery_costs(10_000.0, 10_500.0)
    big = equity_delivery_costs(100_000.0, 105_000.0)
    assert big.total > small.total
