# Nifty options-structure backtest (3 rule sets) - 31 Oct 2026

Research measurement on **modelled** option prices. Not a recommendation, not a profit claim. Rules are exactly as briefed and were not tuned; the survivor test was fixed before the first run.

- Data: Nifty 50 close + India VIX, 2015-11-10 to 2026-10-30 (VIX history starts 2015-11-10). Train = oldest 60% of dates (to 2022-06-10), test = newest 40%. Trades belong to the period of their entry date.
- Unit: Rs per 1 lot (75), net of costs. Drawdown is on daily mark-to-market equity of the closed+open book, reset at the start of each period.
- Survivor rule (fixed upfront): test net > 0 AND walk-forward total > 0 AND at least half of walk-forward windows positive.

## Results

| Strategy | Period | Trades | Win % | Avg Rs | Avg R | Total Rs | Max DD Rs | Worst loss Rs | Worst / SL |
|---|---|---|---|---|---|---|---|---|---|
| 1. Iron condor (30d shorts, ~16d wings) | train | 80 | 63.7 | 1,183 | 0.091 | 94,602 | 35,052 | -13,308 | 0.75x |
| 1. Iron condor (30d shorts, ~16d wings) | test | 51 | 60.8 | 1,608 | 0.066 | 81,984 | 48,058 | -21,856 | 1.17x |
| 2. Short strangle (18d, SL/TP 13k) | train | 80 | 67.5 | 3,119 | 0.24 | 249,512 | 96,745 | -22,629 | 1.74x |
| 2. Short strangle (18d, SL/TP 13k) | test | 52 | 61.5 | 2,525 | 0.194 | 131,308 | 77,649 | -29,065 | 2.24x |
| 3. Balanced calendar (20d, SL 6k / TP 5k) | train | 172 | 56.4 | -226 | -0.038 | -38,802 | 70,369 | -18,288 | 3.05x |
| 3. Balanced calendar (20d, SL 6k / TP 5k) | test | 126 | 65.1 | 300 | 0.05 | 37,743 | 51,458 | -30,867 | 5.14x |

R = net Rs / planned loss (condor: its own credit; strangle 13,000; calendar 6,000). Worst/SL above 1x means the loss was booked at the actual open/close mark, beyond the stop level.

## Walk-forward (frozen rules, calendar-year windows 2018 onward, Rs per lot)

| Strategy | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | Total | Positive windows | Survivor |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1. Iron condor (30d shorts, ~16d wings) | 25,193 | 6,660 | 8,364 | 11,411 | 11,133 | 7,101 | 12,517 | 43,594 | 23,084 | 149,057 | 9/9 | yes |
| 2. Short strangle (18d, SL/TP 13k) | 40,264 | 50,570 | 35,817 | 3,187 | 45,395 | 41,323 | -32,535 | 108,182 | -41,084 | 251,119 | 7/9 | yes |
| 3. Balanced calendar (20d, SL 6k / TP 5k) | 7,233 | 10,560 | -14,056 | 28,992 | -47,189 | 16,911 | 4,303 | 13,532 | 17,506 | 37,792 | 7/9 | yes |

The rules carry no fitted parameters, so walk-forward here is a frozen-rule year-by-year consistency check, not a re-fit loop. 2015-2017 is burn-in.

## Exit reasons and diagnostics

- 1. Iron condor (30d shorts, ~16d wings): exits {'15DTE': 86, 'TP50': 39, 'TP50@open': 4, 'SL100': 2}; avg adjustments/trade 0.0; skipped entries 0; open at data end 1; trades losing >1.1x their SL 3; costs train/test Rs 67,198 / 43,811.
- 2. Short strangle (18d, SL/TP 13k): exits {'TP': 46, 'EXPIRY': 35, 'SL': 27, '7DTE_UNSTABLE': 17, 'TP@open': 5, 'SL@open': 2}; avg adjustments/trade 1.03; skipped entries 0; open at data end 0; trades losing >1.1x their SL 27; costs train/test Rs 41,637 / 39,802.
- 3. Balanced calendar (20d, SL 6k / TP 5k): exits {'PRE_EXPIRY': 198, 'TP': 72, 'SL': 23, 'SL@open': 3, 'TP@open': 2}; avg adjustments/trade 1.73; skipped entries 0; open at data end 1; trades losing >1.1x their SL 30; costs train/test Rs 267,547 / 191,285.

## What the numbers do and do not say

- All three pass the preset survivor test on **modelled** prices. That is not evidence the same would hold on real quotes: flat-IV Black-Scholes has no skew, no bid/ask width beyond the flat slippage, and values every strike at the VIX level.
- Gross-to-net: costs are a large share of the calendar's result (see costs column); its net is small relative to costs and sensitive to the slippage assumption.
- Stops are evaluated at the open proxy and the close only. Fast intraday moves are invisible, so losses beyond the stop level (Worst/SL column) are booked at the mark where they were observed; real intraday behaviour could be better or worse.
- Strangle and calendar worst single losses are well beyond their stated SL (2x and 5x on test); the stated stop does not cap loss on EOD data.
- Result sensitivity to the open-price proxy is high (an earlier unfiltered-proxy run flipped signs for strangle and calendar), which is why the proxy rules are listed below.

## Assumptions used

- No Nifty index option prices exist in data/fo (only STO/STF stock rows). All option prices are Black-Scholes with flat IV = India VIX/100 (no skew, no term structure), r=0.065, q=0.012, strikes in steps of 50.
- Nifty open is unavailable; proxy = prev Nifty close x (NIFTYBEES open / NIFTYBEES prev_close). The ETF open is noisy (median |gap| 0.42% vs index), so a print is used only if |gap|<=3% and (|gap|<=0.2% or it has the same sign as the day's index move and is no bigger than |move|+0.2%); otherwise open = prev close (no open-gap information). This validation uses the same-day close to reject bad prints, never to pick trades. Real gaps that reverse intraday are therefore under-represented; counts of rejected prints reported.
- Entries fill at the next-day open proxy using the prior-day VIX (decision at close, fill next open); open marks use the previous close's time-to-expiry (no overnight theta credited at the open). Exits and adjustments are checked at the close mark; SL/TP are also checked at the open proxy and, if breached there, fill at that open mark, never at the SL level. Intraday excursions are invisible, so intraday stop-outs are missed.
- Fixed lot = 75 for all years (real lot changed 75/50/25/75/65). Rs figures are per 1 lot.
- Expiries are synthetic: monthly = last Thursday (last Tuesday from Sep 2025), weekly = every Thursday/Tuesday, rolled back to the previous trading day on holidays. Real Nifty weeklies did not exist before 2019.
- Costs per leg per transaction: brokerage Rs20, exchange 0.0503%, GST 18% on brokerage+exchange, SEBI 0.00001%, STT 0.10% on premium of short-opening and long-closing transactions (flat, conservative before Oct 2024), stamp 0.003% on long-opening and short-closing transactions, slippage Rs1.0/unit/leg/transaction. Worthless (<Rs0.05) exits carry no cost.
- Strangle strike: 18 delta (middle of the 16-20 option; the ~Rs100-premium alternative is not run). Strangle first adjustment trigger: Rs1,400 loss (middle of 1,300-1,500). Calendar long-leg premium add-on: Rs13.5 (middle of 12-15).
- Strangle 7-DTE rule: at the first close with DTE<=7, exit if gross P&L < 0 (unstable); else hold to expiry settlement with SL/TP still active. 'Cost-to-cost' cannot be targeted on EOD data, so exit is at the mark.
- Strangle further adjustments (same close-profitable-leg / re-short-at-matching-premium move) happen once each when the loss first reaches 4,000 / 8,000 / 12,000 after the straddle stage; the 1,400-type adjustment is not repeated.
- Condor: 30-delta shorts, 16-delta wings (15 and 17 tried only if the 1:2 check fails), 'risk:reward not worse than 1:2' read as max loss <= 2 x net credit; entries failing the check are skipped and counted.
- Calendar straddle test: short strikes within one strike step. Adjustment counter is per calendar month.
- Walk-forward: rules have no fitted parameters, so walk-forward is frozen-rule evaluation on consecutive calendar-year windows 2018 onward (2015-2017 is burn-in). Trades belong to the window of their entry date.
- Survivor test (fixed before running): test-period net > 0 AND walk-forward total > 0 AND >= half of WF windows positive.

ETF-open prints rejected by the validation filter: 1253 days (open = prev close on those days).

Files: `tools/india_edge/backtest/options_yt.py` (engine), `tests/test_options_yt.py`, `backtest/edge_stats.json` (`options_yt` key; `survivors` lists entries prefixed `options_yt:`), trades CSV at `backtest/results/options_yt_trades.csv` (git-ignored).
