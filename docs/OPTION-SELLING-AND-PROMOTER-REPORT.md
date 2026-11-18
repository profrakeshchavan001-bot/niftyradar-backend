# Hedged option selling + promoter buying -- overnight report (2026-11-18)

Statistics on historical data, not advice. Rs 0 budget. No real orders anywhere. No existing
bot, filter, alert or table was touched -- everything new is under `research/options_promoter/`.

## Bottom line

**BLOCKED before any backtest could run.** This session's egress proxy refuses every
market-data host needed for Group 1 (NSE F&O bhavcopy, NSE/BSE promoter disclosures, Yahoo
Finance as a price fallback) -- confirmed by hand tonight (`curl` gets a 403 at the proxy for
`nseindia.com`, `bseindia.com`, and `query1.finance.yahoo.com`), and matches the same block
earlier CC windows recorded in this repo. Per this session's rules I did not change any
network/permission/environment setting to get around it. Nothing downstream of Group 1 (Groups
2-7's *numbers*) can be honest without real data, so no PASS/FAIL verdict below is a market
finding -- every row is either BLOCKED or a mechanics check on labeled fixture data.

| # | Item | Verdict | Reason |
|---|---|---|---|
| 1a | NSE F&O bhavcopy (Nifty/BankNifty options, spot, VIX), 2019-today | **BLOCKED** | Proxy refuses `archives.nseindia.com`, `www.nseindia.com` (403 before reaching NSE). Fetcher code ready: `nse_fno_fetcher.py`. |
| 1b | NSE+BSE promoter disclosures + prices, 2015-today | **BLOCKED** | Proxy refuses `www.nseindia.com`, `www.bseindia.com`. Fetcher code ready: `promoter_fetcher.py`. |
| 2.1-2.3 | Iron condor / hedged strangle / iron fly, all entry/exit/filter variants, Nifty | **BLOCKED** | No option chain to backtest on; engine (`options_engine.py`) built and mechanics-tested on a synthetic fixture only (hedging always on, costs always applied, VIX/event filters work, 3 exit rules all resolve by expiry). |
| 2 (Mar 2020 / 4 Jun 2024 special runs) | -- | **BLOCKED** | Same reason; no real data for those specific days either. |
| 3 | Promoter buying, threshold sweep on train, 60/120-day hold vs Nifty 500 | **BLOCKED** | No disclosures or prices; engine (`promoter_engine.py`) mechanics-tested on synthetic fixture (correct filtering, next-open entry, cost model, benchmark compare). |
| 4 | Honest train/test split + lookahead audit, both ideas | **LOW-DATA** | `honest_split.py` built and unit-tested (date-range split, 30-test-trade minimum, worst-week-vs-6-month-avg rule) -- has nothing real to judge tonight. |
| 5 | Portfolio view (passed items + 3 live research bots) | **LOW-DATA** | `portfolio_view.py` built (correlation matrix, combined drawdown) -- nothing passed Group 2/3, and the 3 live bots' own return series weren't pulled in (out of lane, and moot without Group 2/3 results). |
| 6 | Demo (paper) bots for PASS variants | **SKIPPED (by design)** | Brief says demo bots only for variants that PASS; nothing could be tested, so nothing qualifies. `options_engine.build_demo_bot_spec()` has the config ready for whenever one does. |
| EXTRA | Bank Nifty repeat of Group 2; data-integrity audit | **BLOCKED / not reached** | Same data block; audit of new code's own lookahead safety is covered by the unit tests above. |

## What is needed from Rakesh

- **NSE/BSE/Yahoo network access for this environment** (or a pre-downloaded bhavcopy/VIX/
  disclosure dataset dropped into `data/options_promoter_cache/` in the same shape the fetchers
  expect -- see `research/options_promoter/README.md` for the exact columns). Without one of
  these two, Groups 1-6 cannot produce a single real number.
- Once data lands: `python3 research/options_promoter/nse_fno_fetcher.py && python3
  research/options_promoter/promoter_fetcher.py`, then the engines, with zero code changes.
- A Dhan access token (`DHAN_ACCESS_TOKEN`) only if/when a variant later PASSES and a demo bot
  gets built -- not needed for tonight's backtest work.

## What tonight actually produced (new files only, nothing existing touched)

- Full backtest engines for both ideas, always-hedged by construction (no code path builds a
  naked option structure), with a realistic rupee cost model (brokerage, STT, exchange charges,
  GST, stamp duty, bid-ask slippage) and a historical Nifty/Bank Nifty lot-size table.
- The exact PASS/FAIL/LOW-DATA rule from the brief (net positive on both train and test, >= 30
  test trades, worst week can't wipe out 6 months of average profit), as shared, tested code.
- 19 unit tests, all green, run against small labeled synthetic fixtures only -- every fixture
  docstring says plainly it is not real data and its numbers are not findings.
