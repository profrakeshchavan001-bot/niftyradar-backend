# Hedged option selling + promoter buying -- research lane

Own, new folder. Does not import from or edit `research/strategies/`, `paperbot/`, `src/`,
`server.js`, or any SQL/registry file. Rs 0 budget, no fabricated numbers.

## What this contains

| File | Purpose |
|---|---|
| `nse_fno_fetcher.py` | Pulls NSE F&O bhavcopy (Nifty/Bank Nifty options, spot, India VIX), 2019-today, lot-size/expiry-day aware. |
| `promoter_fetcher.py` | Pulls NSE + BSE promoter/promoter-group insider-trading disclosures, 2015-today, plus daily prices for the same stocks. |
| `lot_sizes.py` | Historical NSE lot-size table for Nifty/Bank Nifty (every change 2019-today) and expiry-day-change dates (Thu->Tue for Bank Nifty withdrawal, Nifty weekly day moves). |
| `options_costs.py` | Rupee cost model for selling/buying index options: brokerage, STT (sell side, options), exchange transaction charges, GST, stamp duty, SEBI fee, bid-ask slippage. |
| `options_engine.py` | Iron condor / hedged short strangle / iron fly backtest engine: entry-day variants, exit rules (expiry / 50% capture / 2x stop), VIX + event-day filters. Always hedged (buys wings); refuses to build a naked leg. |
| `promoter_engine.py` | Promoter-buying backtest: buy next-day open after a qualifying disclosure, hold 60/120 sessions, vs Nifty 500, with costs. |
| `honest_split.py` | Train (first 60%) / test (last 40%) split, lookahead audit, PASS/FAIL/LOW-DATA verdict per the brief's rule. |
| `portfolio_view.py` | Combines whatever passes here with the 3 already-live research bots' daily return series and reports co-movement + combined worst drawdown on Rs 1,00,000 each. |

## Status tonight (2026-11-18, overnight run)

**BLOCKED at the data stage.** This sandbox's egress proxy refuses every market-data host tried
this session (`curl` to each gets a 403 at the proxy, before any site is reached):

- `www.nseindia.com`, `www1.nseindia.com`, `archives.nseindia.com` -- NSE bhavcopy + disclosures
- `www.bseindia.com` -- BSE disclosures
- `query1.finance.yahoo.com` (yfinance's backend) -- spot/VIX/stock-price fallback

This matches the same block recorded by earlier overnight sessions in this repo
(`research/strategies/data_loader.py` docstring, `docs/overnight/CC5.md`): "sandbox network
policy blocked every market-data host tried: Yahoo Finance, Binance, NSE, Stooq." Per this
session's own rules, I did not change any network/permission/environment setting to try to get
around it -- that block is final for tonight.

**What I built anyway:** the complete fetcher/engine/cost/report code, so the moment real data is
reachable (either NSE directly, or a cache this repo already has access to), one command produces
every table the brief asks for, with no code changes. I validated the engines' *mechanics*
(hedging always on, costs always applied, train/test split with no lookahead, PASS/FAIL logic)
against small labeled **fixture** option chains and disclosure records in `tests/` -- fixtures are
explicitly fake and are never reported as findings about the real market. See
`docs/OPTION-SELLING-AND-PROMOTER-REPORT.md` for the one-table verdict and exactly what is needed
from Rakesh to turn this into a real result.

## Running once data is reachable

```
python3 research/options_promoter/nse_fno_fetcher.py     # NSE F&O bhavcopy, spot, VIX -> data/options_promoter_cache/
python3 research/options_promoter/promoter_fetcher.py     # NSE+BSE disclosures + prices -> same cache dir
python3 -m research.options_promoter.options_engine       # Group 2 report
python3 -m research.options_promoter.promoter_engine       # Group 3 report
python3 -m research.options_promoter.portfolio_view        # Group 5 report
```

No demo bots were created (Group 6): the brief says demo bots only for variants that PASS, and
nothing could be tested tonight, so nothing qualifies. `options_engine.py`'s `build_demo_bot_spec()`
returns the config a future PASS would need (own capital tracker + Telegram alert format), so wiring
one up later is a config change, not new code.
