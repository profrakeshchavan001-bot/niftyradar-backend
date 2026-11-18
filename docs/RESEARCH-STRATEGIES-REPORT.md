# Research-strategy backtest report

Generated 2026-11-18. Capital per strategy: Rs 1,00,000. Train = 2015-01-01..2022-12-31, test = 2023-01-01..today for daily-bar strategies (first 60%/last 40% of bars for the short intraday samples). Costs: realistic Indian brokerage/STT/exchange charges/GST/stamp duty/slippage (see research/strategies/costs.py), futures costs for S1/S9-style trades, crypto exchange fees for BTC. PASS requires net profit after costs on BOTH train and test AND >= 30 test trades; otherwise FAIL or LOW-DATA.

Data source: yfinance (daily history back to 2015 where listed; Nifty200-like universe is an approximation of 129 liquid large/mid caps -- the repo has no official Nifty 200 constituent list and nseindia.com was not reachable, see research/strategies/README.md). yfinance 30m: only 60 calendar days available (2026-08-21..2026-11-18); first 60% bars = train, last 40% = test

| Strategy | Market | Verdict | Variant | Data Source | Date Range | Train Net P&L (Rs) | Test Net P&L (Rs) | Test Trades | Win % (test) | Max DD (Rs, test) | Profit Factor (test) | Why it failed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | Nifty | FAIL | base | yfinance | 2015-01-02..2026-11-17 | -48190 | -22117 | 34 | 47.1 | 38451 | 0.657 | unprofitable after costs on both train and test |
| S1 | BankNifty | FAIL | vol-sizing | yfinance | 2015-01-01..2026-11-17 | -77057 | -24776 | 34 | 47.1 | 54733 | 0.703 | unprofitable after costs on both train and test |
| S1 | Gold | FAIL | base | yfinance | 2015-01-02..2026-11-17 | -22302 | 65908 | 34 | 70.6 | 28536 | 2.466 | unprofitable after costs on train period |
| S1 | Crude | FAIL | vol-sizing | yfinance | 2015-01-02..2026-11-17 | 5596 | -42363 | 34 | 52.9 | 99185 | 0.739 | unprofitable after costs on test period (overfit to train) |
| S1 | USDINR | PASS | base | yfinance | 2015-01-01..2026-11-17 | 13019 | 7280 | 34 | 58.8 | 3085 | 1.734 |  |
| S2 | BTC | PASS | vol-sizing | yfinance | 2015-01-01..2026-11-17 | 472860 | 73613 | 103 | 44.7 | 76199 | 1.256 |  |
| S3 | Nifty200-like (129 names) | FAIL | base | yfinance | 2015-01-01..today (per-symbol, see FETCH_LOG.txt) | 84560 | -9653 | 690 | 49.3 | 35350 | 0.892 | unprofitable after costs on test period (overfit to train) |
| S6 | Nifty200-like (129 names) | PASS | base | yfinance | 2015-01-01..today (per-symbol, see FETCH_LOG.txt) | 101993 | 41528 | 1260 | 54.5 | 21358 | 1.368 |  |
| S7 | Nifty | FAIL | base | yfinance | 2015-01-02..2026-11-17 | -47518 | -80660 | 954 | 40.7 | 82796 | 0.589 | unprofitable after costs on both train and test |
| S9 | F&O pairs (4 pairs) | FAIL | base | yfinance | 2015-01-01..today (per-symbol, see FETCH_LOG.txt) | 51326 | -1385 | 97 | 45.4 | 7983 | 0.942 | unprofitable after costs on test period (overfit to train) |
| S4 | Nifty | LOW-DATA | mood-filter | yfinance | 2026-08-21..2026-11-18 (60 calendar days, 30m/5m yfinance limit) | -578 | -1902 | 13 | 15.4 | 2328 | 0.462 | only 13 test trades (< 30 required) |
| S4 | BTC | LOW-DATA | mood-filter | yfinance | 2026-09-20..2026-11-18 (60 calendar days, 30m/5m yfinance limit) | -11084 | -7647 | 29 | 17.2 | 9542 | 0.593 | only 29 test trades (< 30 required) |
| S5 | Nifty | LOW-DATA | mood-filter+vol-sizing | yfinance | 2026-08-21..2026-11-18 (60 calendar days, 30m/5m yfinance limit) | -9156 | -1704 | 24 | 37.5 | 1915 | 0.493 | only 24 test trades (< 30 required) |
| S8 | Nifty | LOW-DATA | mood-filter+vol-sizing | yfinance | 2026-08-21..2026-11-18 (60 calendar days, 30m/5m yfinance limit) | -7409 | -2972 | 23 | 0.0 | 2972 | 0.0 | only 23 test trades (< 30 required) |
| S10 | F&O sample (4 of 60 stocks) | FAIL | mood-filter | yfinance | 60 calendar days (yfinance 5m limit); only 4/60 F&O stocks had 5-min history fetched, not a true top-20-by-volume rank | -5588 | -4398 | 78 | 23.1 | 5344 | 0.482 | unprofitable after costs on both train and test |

## Demo bots created

- **S1 (USDINR)**: new paper-trading bot added (see src/paper / paperbot).
- **S2 (BTC)**: new paper-trading bot added (see src/paper / paperbot).
- **S6 (Nifty200-like (129 names))**: new paper-trading bot added (see src/paper / paperbot).

## Honest limitations

- Nifty 200 constituents: no official list was reachable; a hand-built 129-name liquid large/mid-cap proxy is used for S3/S6/S9 instead.
- Intraday data (S4, S5, S8, S10): yfinance serves at most ~60 calendar days of 5-minute/30-minute history, so these are LOW-DATA by construction relative to the task's 30-test-trade PASS bar; this is a free-data-source limit, not a bug.
- S10: only 4 of the ~60 F&O stocks had 5-min history fetched (a sample, not a true daily top-20-by-first-5-min-volume ranking across the whole universe), due to the same 60-day intraday limit making a full-universe 5-min pull impractical on a free source.

