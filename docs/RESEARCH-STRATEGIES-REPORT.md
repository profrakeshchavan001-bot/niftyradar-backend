# Strategy research: 10-strategy backtest (Rs 0 budget)

**Bottom line: every strategy below is `BLOCKED`, not `PASS`/`FAIL`, because this sandboxed
session had no network access to any market-data source at all.** No backtest numbers were
fabricated or simulated to fill the table — per the task's own instruction, a blocked data
fetch is logged honestly instead. **Zero demo/paper-trading bots were created**, since creating
one for a strategy that was never actually verified on real prices would be worse than creating
none.

The code for all 10 strategies, the Indian cost model, the honest train/test methodology, the
no-lookahead guards, and the two add-on variants is fully implemented and unit-tested under
`research/strategies/` — see that directory's `README.md`. It is ready to produce real
PASS/FAIL/LOW-DATA verdicts the moment this (or a future) session has network access to
yfinance, Binance, or NSE; nothing else needs to change, just:
```
python3 research/strategies/fetch_data.py && python3 research/strategies/run_backtests.py
```

## Why this happened (evidence, not assumption)

Checked in order, each confirmed blocked both through `yfinance`/Python and with plain `curl`
(so it isn't a library bug):

| Source | Host | Result |
|---|---|---|
| Yahoo Finance (yfinance backend) | `query1.finance.yahoo.com`, `query2.finance.yahoo.com` | `403` at the TLS CONNECT step — sandbox egress proxy refusal (`gateway answered 403 to CONNECT (policy denial or other refusal)`), confirmed via `curl -sS "$HTTPS_PROXY/__agentproxy/status"` |
| Binance public API (same source the existing crypto paper bot uses, `paperbot/sources.js`) | `api.binance.com` | same `403` |
| NSE | `www.nseindia.com` | same `403` |
| Stooq (free fallback) | `stooq.com` | same `403` |

`pip install yfinance scipy statsmodels` all succeeded (PyPI is reachable), which rules out
"missing dependency" — this is specifically a market-data network block. The repo's own `data/`
directory has no cached OHLC history (only `nse-fno-top60.json` and `nse-sectors.json`, which are
symbol lists, not prices), and `tools/india_edge/data/*.py` are fetch scripts, not cached data,
so there was nothing usable to fall back to either. Full attempt log, one line per symbol tried:
`data/research_cache/FETCH_LOG.txt`.

An attempt to widen the sandbox's network allowlist was deliberately **not** made: that change
requires a live human approval prompt, and this session was explicitly told to run end-to-end
with no one watching — blocking indefinitely on an approval that might never arrive was judged
riskier than reporting the gap honestly and moving on, per the task's own fallback instruction
("fall back to what's already in the repo, and log the gap plainly").

## Results table

| Strategy | Verdict | Data Source | Date Range | Train Net P&L (Rs) | Test Net P&L (Rs) | Test Trades | Why-it-failed |
|---|---|---|---|---|---|---|---|
| S1 Trend following (Nifty/BankNifty/Gold/Crude/USDINR, 12m signal, 1m hold) | BLOCKED | yfinance (`^NSEI`,`^NSEBANK`,`GC=F`,`CL=F`,`USDINR=X`) — unreachable | 2015-01-01..today | n/a | n/a | n/a | No market data source reachable in this sandbox (all 403'd) |
| S2 BTC weekly momentum | BLOCKED | yfinance `BTC-USD` — unreachable | 2015-01-01..today | n/a | n/a | n/a | No market data source reachable |
| S3 Nifty 200 momentum (12-1, Nifty regime filter) | BLOCKED | yfinance Nifty200-like universe — unreachable | 2015-01-01..today | n/a | n/a | n/a | No market data source reachable; also no real Nifty200 constituent list in-repo (used an ~90-name approximation, see `research/strategies/universe.py`) |
| S4 Noise-band breakout (Nifty, BTC, 30-min) | BLOCKED/LOW-DATA | yfinance 30-min bars — unreachable | would be ~60 days only (yfinance 30m limit) | n/a | n/a | n/a | No data reachable; even if it were, yfinance's ~60-day 30m window would likely give too few trades to be more than LOW-DATA |
| S5 First-30min-to-last-30min (Nifty) | BLOCKED/LOW-DATA | yfinance 30-min bars — unreachable | ~60 days only | n/a | n/a | n/a | Same as S4 |
| S6 52-week high (Nifty 200, monthly) | BLOCKED | yfinance daily — unreachable | 2015-01-01..today | n/a | n/a | n/a | No market data source reachable |
| S7 Overnight (Nifty close→open) | BLOCKED | yfinance `^NSEI` daily — unreachable | 2015-01-01..today | n/a | n/a | n/a | No market data source reachable |
| S8 Last-30min momentum (Nifty) | BLOCKED/LOW-DATA | yfinance 30-min bars — unreachable | ~60 days only | n/a | n/a | n/a | Same as S4/S5 |
| S9 Pairs trading (sector F&O pairs, train-only cointegration) | BLOCKED | yfinance daily, sector pairs from `data/nse-sectors.json` — unreachable | 2015-01-01..today | n/a | n/a | n/a | No market data source reachable |
| S10 5-min ORB on stocks-in-play | BLOCKED/LOW-DATA | yfinance 5-min bars — unreachable | would be ~60 days only (yfinance 5m limit) | n/a | n/a | n/a | Same as S4, plus 5m history is even shorter than 30m |

**Add-on variants A (mood filter) and B (vol sizing):** implemented in `research/strategies/addons.py`
(ADX trend/chop classifier, constant-Rs-risk position sizing) but not run on anything, for the
same reason — there is no base-strategy result to try to improve on.

## Intraday data limitation (stated honestly, as required)

Even with network access, yfinance serves roughly **60 calendar days** of history for ≤30-minute
bars and up to **~730 days** for 60-minute bars. That means S4, S5, S8 and S10 (all built on
30-min or 5-min bars) could **never** have reached the task's "test period ≥30 trades" PASS bar
on daily-equivalent history the way S1/S3/S6/S7/S9 could — they were always going to be, at best,
`LOW-DATA` verdicts with the honest train/test split being "first 60% / last 40% of whatever ~60
days of bars yfinance returns," not the 2015-2022/2023-today split used for the daily strategies.
This is documented in each strategy's module docstring and in `run_backtests.py`'s split logic;
it was true before the network block was discovered and remains true independent of it.

## Demo/paper-trading bots

**None created.** The task is explicit: "If no PASS strategies survive, create zero bots and say
so clearly in the report — do not force a bot for a failing strategy." No strategy reached PASS
(none could even be run), so no new file under `src/paper` or `paperbot/` was added, and no
existing bot, cron registration (`paperbot/index.js`'s `cron.schedule(...)` calls), or report
aggregation was touched.

For reference, if a future run with real data produces a PASS, the extension points already
identified in this codebase are: a new file in `paperbot/` following the existing bot's
capital/P&L/Telegram-alert pattern (see `docs/PAPER-BOT.md` and `paperbot/bot.js`), a new
`cron.schedule(...)` line added in `paperbot/index.js` (never replacing an existing one), and the
daily report job (`job('morning brief', reporter.morningBrief)` at 04:45 IST, the closest existing
equivalent to a "5 AM report") would need a new call into the new bot's own summary function,
again additive only.

## What was and wasn't done

- Done for real: Indian cost model (equity delivery/intraday, futures, crypto — `research/strategies/costs.py`),
  metrics (`metrics.py`), all 10 strategy backtest functions (`s1_trend.py` .. `s10_orb_stocks_in_play.py`),
  the train-only pairs cointegration selector (`s9_pairs_trading.py`), the S3 skip-month ranking
  (`s3_nifty200_momentum.py`), the two add-on variants (`addons.py`), and 13 passing unit tests
  covering cost-calculation correctness and no-lookahead behavior on synthetic fixtures
  (`research/tests/`, run with `python3 -m pytest research/tests -q`).
- Not done, and why: actually running any of the above on real prices (network blocked), and
  therefore any demo bot (no PASS to justify one), and therefore any change to the 5 AM report
  aggregation (nothing to add to it).
