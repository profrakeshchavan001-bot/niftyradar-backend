# Strategy research (Rs 0 budget)

This directory backtests the 10 strategies in `docs/RESEARCH-STRATEGIES-REPORT.md` on real
historical data, with Indian trading costs applied, and (for any strategy that PASSes) wires a
new paper-trading bot into `src/paper` / `paperbot`.

## Status: data fetch is network-blocked in this sandbox

`fetch_data.py` is the one script meant to populate `data/research_cache/` from yfinance
(falling back to whatever is already cached in this repo). In the session that produced this
code, **every outbound host it needs was refused by the sandbox's egress proxy**, confirmed with
plain `curl` (not just the Python client), and logged verbatim to
`data/research_cache/FETCH_LOG.txt`:

- `query1.finance.yahoo.com` / `query2.finance.yahoo.com` (yfinance's backend) -> `403` at the
  TLS CONNECT step (`gateway answered 403 to CONNECT (policy denial or other refusal)`)
- `api.binance.com` (BTC, used by the existing paper bot) -> same `403`
- `www.nseindia.com`, `stooq.com` -> same `403`

`pip install yfinance/scipy/statsmodels` worked fine (PyPI is allowed), so this is specifically a
market-data network block, not a missing dependency. The repo itself has no cached OHLC history
under `data/` (only `nse-fno-top60.json` and `nse-sectors.json`, which are symbol lists, not
prices) and `tools/india_edge/data/*` are fetchers, not cached data, so there was nothing to fall
back to either.

**Per the task's own instruction ("do not fabricate or simulate prices"), no backtest numbers were
invented.** Every strategy below is reported as `BLOCKED` with that reason, not `PASS`/`FAIL`, and
**no demo bots were created**, because creating a bot for an unverified strategy would be worse
than creating none.

## What is real here

- `costs.py` — the Indian cost model (equity delivery/intraday STT+brokerage+GST+stamp duty,
  futures costs, crypto exchange fee) is implemented for real and unit-tested against hand-worked
  numbers in `research/tests/test_costs.py`.
- `metrics.py` — trade-list -> win %, profit factor, max drawdown, net P&L. Unit-tested.
- `s3_nifty200_momentum.py`'s month-skip and `pairs.py`'s train-only cointegration selection are
  implemented with explicit no-lookahead guards and unit-tested with synthetic price panels
  (`research/tests/test_lookahead.py`) — these tests check the *logic* (no future bar is ever
  read before its own date; pair selection never touches test-period prices), not strategy
  profitability, since no real prices are available.
- `s1_trend.py` ... `s10_orb_stocks_in_play.py` are complete, runnable backtest functions. They
  take a standard OHLC `DataFrame` (date-indexed, `open/high/low/close/volume`) per symbol and
  will run end-to-end the moment `fetch_data.py` can actually reach a data source — nothing else
  needs to change. `run_backtests.py` is the orchestrator that would produce the train/test table
  in the report.
- `addons.py` has the mood filter (ADX-based trend/chop day classifier) and volatility position
  sizing, both pure functions, ready to apply once there is data to test them on.

## Re-running once network access exists

```
python3 research/strategies/fetch_data.py   # populates data/research_cache/*.parquet
python3 research/strategies/run_backtests.py  # prints the train/test table, updates the report
```
