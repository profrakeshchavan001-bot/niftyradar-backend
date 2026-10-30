# NEEDS-RAKESH-CC8: missing data and assumptions (options backtest)

## Missing data (blocks a real-price test)

- **Nifty index option EOD prices (bhavcopy `OPTIDX`)**: the fetched `data/fo` has only stock rows (STO/STF). Without them every price is Black-Scholes at flat VIX. Need: NSE F&O bhavcopy with index options (strike, expiry, close, OI) 2015-2026, free from NSE archives.
- **Nifty index open/high/low**: only the close exists. Open is proxied from NIFTYBEES (noisy). Need: Nifty 50 daily OHLC (free NSE index history).
- **Per-strike IV / skew history**: none; flat VIX used.
- **Historical Nifty lot sizes and expiry-day changes**: fixed lot 75 and synthetic expiries used; real weeklies only exist from 2019.
- **Intraday data**: none, so SL/TP touches inside a day are not seen.
- **Your capital figure** for strategy 2 (1/3 deployment) and strategy 3: results are per 1 lot; tell me the capital if you want lots and return-on-capital.

## Interpretation calls I made (please confirm or correct)

- Strangle strike: 18 delta (not the ~Rs100 premium variant). First adjustment at Rs1,400 loss. Later adjustments only at 4,000 / 8,000 / 12,000.
- Strangle '7 DTE unstable' = gross P&L < 0 at that close, exit at mark ('cost-to-cost' cannot be targeted on EOD data).
- Strangle entries (45-50 DTE) overlap the prior cycle, so concurrent 1-lot positions are allowed (one per expiry).
- Condor 'risk:reward not worse than 1:2' = max loss <= 2 x net credit.
- Calendar: long-leg premium = short + Rs13.5; short expiry = weekly 10-12 days out, long = next monthly at least 7 days later; 'straddle' = short strikes within one strike step.
- Full cost and proxy list is in the assumptions section of docs/BACKTEST-YT-STRATEGIES-31OCT.md.
