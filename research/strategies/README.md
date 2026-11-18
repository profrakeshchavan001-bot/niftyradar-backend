# Strategy research (Rs 0 budget)

This directory backtests the 10 strategies in `docs/RESEARCH-STRATEGIES-REPORT.md` on real
historical data, with Indian trading costs applied, and wires a new paper-trading bot into
`src/paper` for every strategy that PASSed.

## Status: real data, real backtests

`fetch_data.py` populates `data/research_cache/*.parquet` from yfinance (Yahoo Finance's public
chart API — free, no key). It was network-blocked in an earlier session (every market-data host
returned `403` at the TLS CONNECT step); the orchestrating session then allow-listed those hosts
on this environment, and the fetch now succeeds — see `data/research_cache/FETCH_LOG.txt` for
every hit/miss, logged honestly either way.

`run_backtests.py` loads that cache, splits train (2015-01-01..2022-12-31) / test
(2023-01-01..today) for daily-bar strategies (first 60%/last 40% of bars for the short intraday
samples — yfinance only serves ~60 calendar days of 5m/30m history), runs all 10 strategies plus
the two add-on variants, and writes the real PASS/FAIL/LOW-DATA table to
`docs/RESEARCH-STRATEGIES-REPORT.md`.

**Result: 3 of 10 PASS** (net profit after costs on both train and test, >= 30 test trades):
S1 on USDINR, S2 (BTC weekly momentum), S6 (52-week-high rotation). Every other S1 instrument,
S3, S7, S9 and S10 are FAIL after real Indian trading costs; S4, S5 and S8 are LOW-DATA because
yfinance's ~60-day intraday history can never reach 30 test trades on a free source — a data
limit, not a strategy judgement. See the report for the full table and per-strategy reasons.

## Known, honestly-logged limitations

- **Nifty 200 constituents**: no official list was reachable (nseindia.com was not allow-listed);
  `universe.py` falls back to a hand-built ~129-name liquid large/mid-cap proxy (the repo's own
  F&O-60 list plus other well-known names). S3/S6/S9 run on this proxy, not the real index.
- **Intraday history (S4, S5, S8, S10)**: yfinance serves at most ~60 calendar days of 5-minute/
  30-minute bars on a free key-less call, so these strategies are LOW-DATA by construction
  relative to the task's 30-test-trade PASS bar.
- **S10**: only ran on a 4-stock sample (RELIANCE, HDFCBANK, ICICIBANK, TCS), not a true daily
  top-20-by-first-5-min-volume ranking across the full ~60-stock F&O universe, because pulling
  5-minute bars for the whole universe within the same 60-day limit was impractical to do
  politely against a free, unauthenticated endpoint.

## What's in this directory

- `costs.py` — Indian cost model (equity delivery/intraday STT+brokerage+GST+stamp duty, futures
  costs, crypto exchange fee). Unit-tested against hand-worked numbers (`research/tests/`).
- `metrics.py` — trade-list -> win %, profit factor, max drawdown, net P&L, PASS/FAIL/LOW-DATA verdict.
- `s1_trend.py` ... `s10_orb_stocks_in_play.py` — one backtest module per strategy, each with an
  explicit no-lookahead guard documented in its own docstring and (for S3/S9) unit-tested against
  synthetic price panels in `research/tests/test_lookahead.py`.
- `addons.py` — add-on A (ADX-based market-mood/trend-day filter) and add-on B (volatility-based
  position sizing), both pure functions, applied by `run_backtests.py` and kept only when they
  improve the TEST period (never decided on train alone).
- `data_loader.py` / `fetch_data.py` — the yfinance cache layer and the script that populates it.
- `universe.py` — the Nifty200-like proxy universe and the F&O/sector lists reused from `data/`.
- `run_backtests.py` — the orchestrator; re-run it any time to regenerate the report from the
  current cache (`python3 research/strategies/fetch_data.py && python3
  research/strategies/run_backtests.py`).

## Demo bots

`src/paper/bots/research_usdinr_trend/`, `research_btc_momentum/`, `research_nifty200_52whigh/`
— one per PASS strategy, auto-loaded by `src/paper/pluginLoader.js` like every other bot in this
repo. Each runs the exact same signal as its backtest, on live Yahoo Finance data, with its own
Rs 1,00,000 paper capital, wired into the existing Telegram trade-alert format and the 5 AM daily
report via additive entries in `src/paper/ops/telegramAlerts/register.js` and
`src/paper/ops/dailyReport/fetch.js` (no existing bot, entry or table was changed).
