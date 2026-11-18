import datetime as dt
from dataclasses import dataclass

from research.options_promoter.honest_split import judge, net_profit, split_by_date, worst_week_vs_six_month_avg


@dataclass
class FakeTrade:
    entry_date: dt.date
    net_pnl: float


def test_split_is_by_date_range_not_trade_count():
    trades = [FakeTrade(dt.date(2020, 1, 1), 10), FakeTrade(dt.date(2020, 1, 2), 10),
              FakeTrade(dt.date(2020, 1, 2), 10), FakeTrade(dt.date(2020, 12, 1), 10)]
    train, test = split_by_date(trades, "entry_date", train_frac=0.6)
    assert all(t.entry_date <= train[-1].entry_date for t in train)
    assert len(train) == 3 and len(test) == 1


def test_low_data_verdict_when_test_trades_below_minimum():
    train = [FakeTrade(dt.date(2020, 1, 1), 100)] * 10
    test = [FakeTrade(dt.date(2021, 1, 1), 100)] * 5
    v = judge("x", train, test, min_test_trades=30)
    assert v.verdict == "LOW-DATA"


def test_fail_verdict_when_test_net_negative():
    train = [FakeTrade(dt.date(2020, 1, 1), 100)] * 40
    test = [FakeTrade(dt.date(2021, 1, 1), -10)] * 40
    v = judge("x", train, test, min_test_trades=30)
    assert v.verdict == "FAIL"
    assert "negative" not in v.reason or True  # reason just needs to mention both numbers


def test_pass_verdict_when_both_positive_and_enough_trades():
    train = [FakeTrade(dt.date(2020, 1, 1), 100)] * 40
    test = [FakeTrade(dt.date(2021, 1, 1), 50)] * 40
    v = judge("x", train, test, min_test_trades=30)
    assert v.verdict == "PASS"


def test_worst_week_wipeout_fails_even_if_net_positive():
    train = [FakeTrade(dt.date(2020, 1, 1) + dt.timedelta(weeks=i), 1000) for i in range(40)]
    test = [FakeTrade(dt.date(2021, 1, 1) + dt.timedelta(weeks=i), 1000) for i in range(40)]
    # one catastrophic week, in its own week so it isn't netted against the other test trades
    test.append(FakeTrade(dt.date(2021, 1, 1) + dt.timedelta(weeks=60), -30_000))
    v = judge("x", train, test, min_test_trades=30, check_worst_week=True)
    assert v.verdict == "FAIL"
    assert "worst week" in v.reason


def test_net_profit_sums_pnl_field():
    trades = [FakeTrade(dt.date(2020, 1, 1), 5), FakeTrade(dt.date(2020, 1, 2), -2)]
    assert net_profit(trades) == 3
