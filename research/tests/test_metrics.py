from metrics import max_drawdown_inr, profit_factor, summarize, verdict, win_rate_pct


def _trades(pnls):
    return [{"pnl_inr": p} for p in pnls]


def test_win_rate_and_profit_factor():
    t = _trades([100, -50, 200, -100, 50])
    assert win_rate_pct(t) == 60.0
    assert profit_factor(t) == round((100 + 200 + 50) / (50 + 100), 3)


def test_max_drawdown():
    t = _trades([1000, -3000, 500, -200])
    dd = max_drawdown_inr(t, starting_capital=10_000)
    # equity: 10000 -> 11000 -> 8000 -> 8500 -> 8300; peak 11000, trough right after is 8000
    assert dd == 3000.0


def test_verdict_pass():
    train = summarize(_trades([100] * 10 + [-50] * 5))
    test = summarize(_trades([100] * 25 + [-50] * 10))  # 35 trades, net positive
    v, reason = verdict(train, test, min_test_trades=30)
    assert v == "PASS"
    assert reason == ""


def test_verdict_low_data_when_few_test_trades():
    train = summarize(_trades([100] * 10))
    test = summarize(_trades([100] * 5))
    v, reason = verdict(train, test, min_test_trades=30)
    assert v == "LOW-DATA"
    assert "5" in reason


def test_verdict_fail_when_test_unprofitable():
    train = summarize(_trades([100] * 40))
    test = summarize(_trades([-10] * 40))
    v, reason = verdict(train, test, min_test_trades=30)
    assert v == "FAIL"
    assert "test" in reason
