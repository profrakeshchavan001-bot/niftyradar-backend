# Do NiftyRadar's signals make money on past data? (CC4, 14 Nov 2026)

Research measurement on history, not advice, no profit claim. All money in Indian rupees. Every number comes from `tools/india_edge/backtest/run_signal_backtest.py` on the local NSE bhavcopy (cash, F&O, index, 2015-01 to 2026-10-30).

## Answer

**No edge found.** Out of 36 testable signal variants x 3 ways of trading them, only these passed the 'positive on both train and test' rule: L1 setup: index (opt_itm1). Each has a tiny P&L and a 95% interval for average R that includes zero; with this many variants tested, a few lucky passes are expected by chance, so none is treated as an edge. Everything else lost money on the test period.

## Summary (test period 2023-01 to 2026-10, Rs 1,00,000 start, 1.5% risk, max 2 open, costs 2x)

| Signal | Verdict stock / option (ATM) | Test-period Rs P&L stock / option (ATM) |
|---|---|---|
| L1 scanner picks (A+B, top 5/day) | NOT PROFITABLE / NOT PROFITABLE | -75,735 / -97,414 |
| L1 grade A only | NOT PROFITABLE / NOT PROFITABLE | -64,896 / -92,119 |
| L1 setup: trend | NOT PROFITABLE / NOT PROFITABLE | -77,228 / -97,295 |
| L1 setup: pullback | NOT PROFITABLE / NOT PROFITABLE | -49,864 / -48,025 |
| L1 setup: index | NOT PROFITABLE / NOT PROFITABLE | -2,636 / -7,430 |
| L1 longs only | NOT PROFITABLE / NOT PROFITABLE | -79,274 / -88,941 |
| L1 shorts only | NOT PROFITABLE / NOT PROFITABLE | -47,992 / -94,272 |
| L3 chop veto: picks KEPT | NOT PROFITABLE / NOT PROFITABLE | -73,488 / -95,936 |
| L3 chop veto: picks VETOED | NOT PROFITABLE / NOT PROFITABLE | -48,166 / -36,222 |
| Early detection: accumulation (Watch) | NOT PROFITABLE / NOT PROFITABLE | -65,609 / -88,856 |
| Early detection: trigger (Ready) | NOT PROFITABLE / NOT PROFITABLE | -66,144 / -82,818 |
| Early detection: confirmation (Go) | NOT PROFITABLE / NOT PROFITABLE | -59,619 / -72,978 |
| Signal Box derivatives: bullish flags -> long | NOT PROFITABLE / NOT PROFITABLE | -66,432 / -62,688 |
| Signal Box derivatives: bearish flags -> short | NOT PROFITABLE / NOT PROFITABLE | -55,666 / 278 |
| AOC chain screeners (Triple S/R, Power, Oi2Oi, Big Bull/Bear) | NOT PROFITABLE / NOT PROFITABLE | -68,936 / -96,186 |
| AOC strike shifts (SFB/SFT/STT/STB) | NOT PROFITABLE / NOT PROFITABLE | -65,938 / -75,082 |
|   Triple S/R support | NOT PROFITABLE / NOT PROFITABLE | -63,413 / -72,085 |
|   Triple S/R resistance | NOT PROFITABLE / NOT PROFITABLE | -48,049 / 23,688 |
|   Power stock bull | NOT PROFITABLE / NOT PROFITABLE | -27,365 / -9,192 |
|   Power stock bear | NOT PROFITABLE / NOT PROFITABLE | -38,263 / 71,983 |
|   Oi2Oi long (own stop/target) | NOT PROFITABLE / NOT PROFITABLE | -61,245 / -87,605 |
|   Oi2Oi short (own stop/target) | NOT PROFITABLE / NOT PROFITABLE | -51,161 / -43,817 |
|   Big Bull | NOT PROFITABLE / NOT PROFITABLE | -55,043 / -49,881 |
|   Big Bear | NOT PROFITABLE / NOT PROFITABLE | -61,678 / -77,729 |
|   SFB | NOT PROFITABLE / NOT PROFITABLE | -63,253 / -74,104 |
|   SFT | NOT PROFITABLE / NOT PROFITABLE | -66,443 / -91,987 |
|   STT | NOT PROFITABLE / NOT PROFITABLE | -59,735 / -65,585 |
|   STB | NOT PROFITABLE / NOT PROFITABLE | -64,129 / -85,214 |
| CC5 screener: strong trend | NOT PROFITABLE / NOT PROFITABLE | -57,942 / -54,768 |
| CC5 screener: pullback in uptrend | NOT PROFITABLE / NOT PROFITABLE | -38,311 / -43,864 |
| CC5 screener: volume breakout | NOT PROFITABLE / NOT PROFITABLE | -75,531 / -73,561 |
| CC5 screener: RS leaders | NOT PROFITABLE / NOT PROFITABLE | -63,941 / -73,970 |
| CC5 screener: near 52-week high | NOT PROFITABLE / NOT PROFITABLE | -62,039 / -79,051 |
| CC5 screener: delivery rising | NOT PROFITABLE / NOT PROFITABLE | -31,051 / -28,597 |
| CC5 screener: steady uptrend | NOT PROFITABLE / NOT PROFITABLE | -51,548 / -39,832 |
| CC5 screener: weakest scores (short) | NOT PROFITABLE / NOT PROFITABLE | -45,192 / -64,187 |
| L2 timing (OB/FVG pullback + BOS/engulfing, ORB, VWAP) | NOT TESTABLE (see below) | - |
| L3 vetoes: IV percentile, event calendar, option spread | NOT TESTABLE (see below) | - |
| Cause detector (Block G) | NOT TESTABLE (see below) | - |
| Option plan (Block D) | NOT TESTABLE (see below) | - |
| Reversal-price S/R touch, support/resistance breaks, tick scanner (Signal Box flags SR_*_TOUCH, *_BREAK) | NOT TESTABLE (see below) | - |
| Market overview score / MMI / FII pulse | NOT TESTABLE (see below) | - |
| R-factor | NOT TESTABLE (see below) | - |
| CC5 scores: quality / valuation | NOT TESTABLE (see below) | - |

Rs P&L is the result of an independent Rs 1,00,000 account per period (equity compounds, so a losing signal can lose at most about Rs 1,00,000). Verdict rule: PROFITABLE = positive Rs P&L in BOTH train (entries 2015-2022) and test (entries 2023-now) with at least 30 trades in each; fewer = TOO FEW TRADES; otherwise NOT PROFITABLE.

## 1. Every signal NiftyRadar produces, and where it lives

| Signal | Code | Tested? |
|---|---|---|
| L1 scanner picks (A+B, top 5/day) | tools/india_edge/layer1.py, score.py, features.py, backtest/engine.py | yes |
| L1 grade A only | same | yes |
| L1 setup: trend | same | yes |
| L1 setup: pullback | same | yes |
| L1 setup: index | same | yes |
| L1 longs only | same | yes |
| L1 shorts only | same | yes |
| L3 chop veto: picks KEPT | tools/india_edge/vetoes.py (chop_veto) | yes |
| L3 chop veto: picks VETOED | same | yes |
| Early detection: accumulation (Watch) | tools/india_edge/early.py | yes |
| Early detection: trigger (Ready) | same | yes |
| Early detection: confirmation (Go) | same | yes |
| Signal Box derivatives: bullish flags -> long | tools/india_edge/chain/signalbox.py | yes |
| Signal Box derivatives: bearish flags -> short | same | yes |
| AOC chain screeners (Triple S/R, Power, Oi2Oi, Big Bull/Bear) | tools/india_edge/chain/screeners.py | yes |
| AOC strike shifts (SFB/SFT/STT/STB) | tools/india_edge/chain/shifts.py | yes |
| Triple S/R support | chain/screeners.py triple_sr | yes |
| Triple S/R resistance | chain/screeners.py triple_sr | yes |
| Power stock bull | chain/screeners.py power_stock | yes |
| Power stock bear | chain/screeners.py power_stock | yes |
| Oi2Oi long (own stop/target) | chain/screeners.py oi2oi | yes |
| Oi2Oi short (own stop/target) | chain/screeners.py oi2oi | yes |
| Big Bull | chain/screeners.py trap_signal | yes |
| Big Bear | chain/screeners.py trap_signal | yes |
| SFB | chain/shifts.py | yes |
| SFT | chain/shifts.py | yes |
| STT | chain/shifts.py | yes |
| STB | chain/shifts.py | yes |
| CC5 screener: strong trend | tools/india_edge/scores/screeners.py | yes |
| CC5 screener: pullback in uptrend | same | yes |
| CC5 screener: volume breakout | same | yes |
| CC5 screener: RS leaders | same | yes |
| CC5 screener: near 52-week high | same | yes |
| CC5 screener: delivery rising | same | yes |
| CC5 screener: steady uptrend | same | yes |
| CC5 screener: weakest scores (short) | same | yes |
| L2 timing (OB/FVG pullback + BOS/engulfing, ORB, VWAP) | tools/india_edge/timing.py, session.py | no: needs 15-minute bars. Only EOD bhavcopy exists locally (intraday.py just synthesises bars), so a point-in-time rebuild is impossible. |
| L3 vetoes: IV percentile, event calendar, option spread | tools/india_edge/vetoes.py | no: no IV history, events.csv or bid/ask quotes are stored locally. Only the chop (efficiency ratio) veto is rebuilt. |
| Cause detector (Block G) | tools/india_edge/cause.py | no: a label explaining a move, with no entry/stop/target of its own; it is not a trade signal. |
| Option plan (Block D) | tools/india_edge/options_plan.py | no: this is the option-buy execution itself; it is exactly what column 'option' tests for every signal. |
| Reversal-price S/R touch, support/resistance breaks, tick scanner (Signal Box flags SR_*_TOUCH, *_BREAK) | tools/india_edge/chain/reversal.py, screeners.py SrStocksScanner | no: triggered by live ticks touching a solved reversal level; EOD data cannot say when or whether a touch happened. |
| Market overview score / MMI / FII pulse | tools/india_edge/chain/market.py | no: needs participant-wise OI and index chains by strike; the local data has neither for stocks' direction call. Not rebuilt. |
| R-factor | (not found) | no: no code with that name exists in any merged PR. |
| CC5 scores: quality / valuation | tools/india_edge/scores/engine.py | no: fundamentals are an as-of-today snapshot, so a historical test would look ahead. Excluded (the scores validator excludes them too). |

## 2. Method (point in time, nothing tuned)

- **No lookahead.** A signal dated D uses data up to D's close only. The trade enters at the D+1 open. Features use only prior days (`shift(1)` baselines, audited by `audit_lookahead.py`); the F&O universe for a month is ranked on the previous month; prices are back-adjusted for splits/bonuses from NSE's own prev_close.
- **(a) Stock leg.** Entry D+1 open; stop 1.5 x ATR(14) at D; target 2R; exit at the 5th day's close (10th for the CC5 screeners, whose own horizon is 10 sessions; Oi2Oi uses its own stop and target strike). Same-day stop and target: stop first. Gaps fill at the open.
- **(b) Option leg.** Buy a call (long) or put (short), ATM or 1 strike ITM, expiry in 10-15 days if one exists, else the first expiry at least 10 days out (20 for the 10-day screeners). Entry = the option's real D+1 **open** (skipped if it did not trade). Exit follows the underlying's stop/target/time rule. **The option intraday path is approximate (EOD data only):** time exit = real EOD close; gap through the level = real open; intraday touch = Black-Scholes price at the level with vol implied from that day's EOD close. Lot sizes are ignored (fractional units), which flatters small accounts.
- **Capital.** Rs 1,00,000; risk 1.5% of equity per trade; at most 2 open positions (higher-ranked signal first); stock position capped at 50% of equity, option premium at 25%. Train = entries to 2022-12-31, test = entries from 2023-01-01, each an independent Rs 1,00,000 run. At most 5 signals per day are offered (Layer 1's own top_n).
- **Costs at 2x normal.** Stock leg costed as stock futures (brokerage 0.03%, STT 0.02% sell, exchange, stamp, GST, plus slippage 5% of ATR per side), doubled. Option leg: Rs 20 per order, STT 0.1% on the sell premium, exchange 0.035%, stamp, GST, plus 1% of premium slippage per side, doubled.
- **Statistics.** win % and profit factor over trades; avg R = net P&L / amount risked; 'gross R' is before costs (shows whether there is any edge before the toll); max drawdown in Rs on the closed-trade curve; 95% bootstrap interval of avg R in the JSON.

## 3. Full results (test period columns unless marked)

Columns: trades train / trades test / win % (test) / avg R net (test) / avg R gross (test) / profit factor (test) / Rs P&L train / Rs P&L test / max drawdown Rs (test) / verdict.

### (a) Underlying stock

| Signal | tr n | te n | win % | avg R | gross R | PF | Rs train | Rs test | max DD | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| L1 scanner picks (A+B, top 5/day) | 819 | 443 | 35.9 | -0.206 | -0.041 | 0.55 | -88,788 | -75,735 | 80,995 | NOT PROFITABLE |
| L1 grade A only | 718 | 344 | 37.8 | -0.196 | -0.031 | 0.55 | -65,667 | -64,896 | 65,377 | NOT PROFITABLE |
| L1 setup: trend | 815 | 443 | 35.9 | -0.215 | -0.051 | 0.54 | -86,202 | -77,228 | 82,488 | NOT PROFITABLE |
| L1 setup: pullback | 441 | 226 | 36.3 | -0.196 | -0.028 | 0.62 | -68,523 | -49,864 | 58,192 | NOT PROFITABLE |
| L1 setup: index | 98 | 64 | 53.1 | -0.022 | 0.155 | 0.93 | 11,766 | -2,636 | 7,322 | NOT PROFITABLE |
| L1 longs only | 753 | 415 | 38.8 | -0.241 | -0.076 | 0.52 | -88,427 | -79,274 | 82,068 | NOT PROFITABLE |
| L1 shorts only | 729 | 388 | 41.5 | -0.105 | 0.062 | 0.7 | -74,772 | -47,992 | 62,431 | NOT PROFITABLE |
| L3 chop veto: picks KEPT | 806 | 442 | 37.6 | -0.193 | -0.028 | 0.57 | -86,127 | -73,488 | 81,666 | NOT PROFITABLE |
| L3 chop veto: picks VETOED | 673 | 339 | 44.5 | -0.115 | 0.056 | 0.76 | -81,448 | -48,166 | 51,333 | NOT PROFITABLE |
| Early detection: accumulation (Watch) | 833 | 408 | 41.4 | -0.17 | -0.0 | 0.56 | -91,872 | -65,609 | 66,096 | NOT PROFITABLE |
| Early detection: trigger (Ready) | 717 | 349 | 36.1 | -0.2 | -0.03 | 0.59 | -87,877 | -66,144 | 68,716 | NOT PROFITABLE |
| Early detection: confirmation (Go) | 565 | 298 | 36.9 | -0.197 | -0.026 | 0.58 | -72,814 | -59,619 | 64,554 | NOT PROFITABLE |
| Signal Box derivatives: bullish flags -> long | 900 | 448 | 38.8 | -0.154 | 0.016 | 0.67 | -90,630 | -66,432 | 68,132 | NOT PROFITABLE |
| Signal Box derivatives: bearish flags -> short | 883 | 425 | 35.1 | -0.116 | 0.052 | 0.67 | -74,432 | -55,666 | 63,192 | NOT PROFITABLE |
| AOC chain screeners (Triple S/R, Power, Oi2Oi, Big Bull/Bear) | 885 | 426 | 39.9 | -0.177 | -0.006 | 0.58 | -85,295 | -68,936 | 69,652 | NOT PROFITABLE |
| AOC strike shifts (SFB/SFT/STT/STB) | 887 | 438 | 40.0 | -0.158 | 0.013 | 0.66 | -81,066 | -65,938 | 69,824 | NOT PROFITABLE |
|   Triple S/R support | 890 | 437 | 40.5 | -0.146 | 0.023 | 0.66 | -90,126 | -63,413 | 64,327 | NOT PROFITABLE |
|   Triple S/R resistance | 913 | 426 | 37.3 | -0.088 | 0.083 | 0.76 | -91,688 | -48,049 | 54,591 | NOT PROFITABLE |
|   Power stock bull | 328 | 86 | 43.0 | -0.222 | -0.052 | 0.61 | -54,333 | -27,365 | 36,061 | NOT PROFITABLE |
|   Power stock bear | 882 | 421 | 39.7 | -0.062 | 0.11 | 0.8 | -69,187 | -38,263 | 59,412 | NOT PROFITABLE |
|   Oi2Oi long (own stop/target) | 818 | 405 | 38.8 | -0.149 | 0.033 | 0.68 | -94,419 | -61,245 | 71,991 | NOT PROFITABLE |
|   Oi2Oi short (own stop/target) | 768 | 382 | 39.3 | -0.115 | 0.065 | 0.68 | -78,448 | -51,161 | 53,882 | NOT PROFITABLE |
|   Big Bull | 878 | 418 | 42.6 | -0.12 | 0.053 | 0.72 | -85,954 | -55,043 | 55,960 | NOT PROFITABLE |
|   Big Bear | 888 | 431 | 36.7 | -0.137 | 0.034 | 0.66 | -75,036 | -61,678 | 71,515 | NOT PROFITABLE |
|   SFB | 914 | 443 | 38.8 | -0.143 | 0.028 | 0.68 | -93,193 | -63,253 | 63,527 | NOT PROFITABLE |
|   SFT | 886 | 434 | 37.3 | -0.161 | 0.007 | 0.63 | -84,339 | -66,443 | 69,550 | NOT PROFITABLE |
|   STT | 780 | 389 | 41.6 | -0.149 | 0.023 | 0.67 | -88,513 | -59,735 | 60,376 | NOT PROFITABLE |
|   STB | 718 | 374 | 37.4 | -0.176 | -0.008 | 0.59 | -75,008 | -64,129 | 73,471 | NOT PROFITABLE |
| CC5 screener: strong trend | 544 | 289 | 39.1 | -0.187 | -0.015 | 0.7 | -81,888 | -57,942 | 59,462 | NOT PROFITABLE |
| CC5 screener: pullback in uptrend | 452 | 232 | 40.1 | -0.128 | 0.04 | 0.76 | -75,043 | -38,311 | 48,571 | NOT PROFITABLE |
| CC5 screener: volume breakout | 576 | 296 | 31.4 | -0.304 | -0.133 | 0.57 | -84,264 | -75,531 | 76,031 | NOT PROFITABLE |
| CC5 screener: RS leaders | 556 | 251 | 39.4 | -0.25 | -0.077 | 0.62 | -71,588 | -63,941 | 66,585 | NOT PROFITABLE |
| CC5 screener: near 52-week high | 503 | 251 | 37.8 | -0.246 | -0.076 | 0.59 | -78,524 | -62,039 | 62,625 | NOT PROFITABLE |
| CC5 screener: delivery rising | 553 | 274 | 43.4 | -0.078 | 0.097 | 0.87 | -76,024 | -31,051 | 64,066 | NOT PROFITABLE |
| CC5 screener: steady uptrend | 542 | 274 | 43.4 | -0.156 | 0.02 | 0.72 | -87,208 | -51,548 | 58,005 | NOT PROFITABLE |
| CC5 screener: weakest scores (short) | 496 | 249 | 41.8 | -0.151 | 0.018 | 0.65 | -70,745 | -45,192 | 53,672 | NOT PROFITABLE |

### (b) Option buy, ATM

| Signal | tr n | te n | win % | avg R | gross R | PF | Rs train | Rs test | max DD | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| L1 scanner picks (A+B, top 5/day) | 736 | 442 | 25.1 | -0.526 | -0.105 | 0.48 | -99,955 | -97,414 | 108,978 | NOT PROFITABLE |
| L1 grade A only | 711 | 349 | 25.2 | -0.469 | -0.161 | 0.43 | -75,729 | -92,119 | 92,119 | NOT PROFITABLE |
| L1 setup: trend | 786 | 440 | 24.8 | -0.522 | -0.096 | 0.48 | -100,045 | -97,295 | 108,859 | NOT PROFITABLE |
| L1 setup: pullback | 408 | 223 | 32.7 | -0.18 | -0.014 | 0.72 | -85,129 | -48,025 | 63,133 | NOT PROFITABLE |
| L1 setup: index | 92 | 64 | 40.6 | -0.069 | 0.09 | 0.85 | -1,284 | -7,430 | 13,342 | NOT PROFITABLE |
| L1 longs only | 490 | 414 | 29.2 | -0.339 | -0.07 | 0.55 | -99,979 | -88,941 | 94,698 | NOT PROFITABLE |
| L1 shorts only | 712 | 388 | 27.3 | -0.465 | -0.097 | 0.44 | -99,969 | -94,272 | 110,182 | NOT PROFITABLE |
| L3 chop veto: picks KEPT | 674 | 443 | 28.4 | -0.463 | -0.101 | 0.5 | -99,967 | -95,936 | 105,055 | NOT PROFITABLE |
| L3 chop veto: picks VETOED | 655 | 338 | 34.6 | -0.068 | 0.098 | 0.85 | -91,789 | -36,222 | 50,835 | NOT PROFITABLE |
| Early detection: accumulation (Watch) | 747 | 408 | 29.7 | -0.347 | -0.066 | 0.47 | -99,962 | -88,856 | 88,864 | NOT PROFITABLE |
| Early detection: trigger (Ready) | 702 | 349 | 27.8 | -0.322 | -0.096 | 0.59 | -98,696 | -82,818 | 89,829 | NOT PROFITABLE |
| Early detection: confirmation (Go) | 548 | 296 | 27.7 | -0.282 | -0.081 | 0.61 | -83,561 | -72,978 | 81,802 | NOT PROFITABLE |
| Signal Box derivatives: bullish flags -> long | 454 | 450 | 32.7 | -0.129 | 0.048 | 0.8 | -100,122 | -62,688 | 86,227 | NOT PROFITABLE |
| Signal Box derivatives: bearish flags -> short | 879 | 429 | 28.4 | 0.275 | 0.515 | 1.0 | -93,539 | 278 | 90,324 | NOT PROFITABLE |
| AOC chain screeners (Triple S/R, Power, Oi2Oi, Big Bull/Bear) | 766 | 424 | 26.4 | -0.495 | -0.116 | 0.44 | -99,963 | -96,186 | 97,243 | NOT PROFITABLE |
| AOC strike shifts (SFB/SFT/STT/STB) | 653 | 438 | 32.0 | -0.193 | -0.0 | 0.74 | -100,080 | -75,082 | 84,053 | NOT PROFITABLE |
|   Triple S/R support | 474 | 436 | 34.9 | -0.18 | 0.025 | 0.71 | -100,088 | -72,085 | 73,441 | NOT PROFITABLE |
|   Triple S/R resistance | 864 | 426 | 29.3 | 0.305 | 0.512 | 1.07 | -99,960 | 23,688 | 87,082 | NOT PROFITABLE |
|   Power stock bull | 310 | 87 | 37.9 | -0.059 | 0.089 | 0.88 | -60,951 | -9,192 | 22,385 | NOT PROFITABLE |
|   Power stock bear | 871 | 418 | 31.6 | 0.369 | 0.571 | 1.21 | -91,598 | 71,983 | 82,713 | NOT PROFITABLE |
|   Oi2Oi long (own stop/target) | 469 | 404 | 30.7 | -0.326 | -0.079 | 0.62 | -100,039 | -87,605 | 97,779 | NOT PROFITABLE |
|   Oi2Oi short (own stop/target) | 633 | 380 | 34.2 | -0.015 | 0.2 | 0.84 | -100,060 | -43,817 | 71,674 | NOT PROFITABLE |
|   Big Bull | 873 | 418 | 35.4 | -0.097 | 0.07 | 0.82 | 290,702 | -49,881 | 55,137 | NOT PROFITABLE |
|   Big Bear | 875 | 426 | 27.9 | -0.161 | 0.087 | 0.63 | -51,968 | -77,729 | 88,757 | NOT PROFITABLE |
|   SFB | 470 | 441 | 33.3 | -0.19 | 0.001 | 0.72 | -100,014 | -74,104 | 74,318 | NOT PROFITABLE |
|   SFT | 793 | 431 | 30.2 | -0.37 | -0.063 | 0.56 | -99,979 | -91,987 | 93,684 | NOT PROFITABLE |
|   STT | 650 | 390 | 32.6 | -0.169 | 0.016 | 0.73 | -99,970 | -65,585 | 66,591 | NOT PROFITABLE |
|   STB | 706 | 373 | 29.2 | -0.325 | -0.071 | 0.57 | -88,301 | -85,214 | 97,288 | NOT PROFITABLE |
| CC5 screener: strong trend | 493 | 290 | 32.1 | -0.16 | 0.011 | 0.8 | -77,759 | -54,768 | 70,303 | NOT PROFITABLE |
| CC5 screener: pullback in uptrend | 397 | 218 | 36.2 | -0.158 | -0.003 | 0.79 | -62,418 | -43,864 | 77,623 | NOT PROFITABLE |
| CC5 screener: volume breakout | 538 | 297 | 29.3 | -0.279 | -0.089 | 0.71 | -77,947 | -73,561 | 85,455 | NOT PROFITABLE |
| CC5 screener: RS leaders | 494 | 259 | 29.0 | -0.329 | -0.122 | 0.59 | -61,765 | -73,970 | 75,226 | NOT PROFITABLE |
| CC5 screener: near 52-week high | 456 | 245 | 27.3 | -0.407 | -0.187 | 0.52 | -77,625 | -79,051 | 79,832 | NOT PROFITABLE |
| CC5 screener: delivery rising | 493 | 262 | 35.9 | -0.066 | 0.093 | 0.9 | -85,253 | -28,597 | 67,984 | NOT PROFITABLE |
| CC5 screener: steady uptrend | 473 | 260 | 35.4 | -0.108 | 0.068 | 0.83 | -71,472 | -39,832 | 50,102 | NOT PROFITABLE |
| CC5 screener: weakest scores (short) | 426 | 242 | 35.1 | -0.26 | -0.037 | 0.61 | -99,861 | -64,187 | 75,439 | NOT PROFITABLE |

### (b) Option buy, 1 strike ITM

| Signal | tr n | te n | win % | avg R | gross R | PF | Rs train | Rs test | max DD | verdict |
|---|---|---|---|---|---|---|---|---|---|---|
| L1 scanner picks (A+B, top 5/day) | 609 | 444 | 30.0 | -0.297 | -0.049 | 0.6 | -100,004 | -87,760 | 98,915 | NOT PROFITABLE |
| L1 grade A only | 671 | 341 | 26.7 | -0.419 | -0.132 | 0.44 | -100,055 | -89,108 | 89,108 | NOT PROFITABLE |
| L1 setup: trend | 649 | 444 | 29.3 | -0.312 | -0.058 | 0.6 | -100,029 | -88,952 | 100,107 | NOT PROFITABLE |
| L1 setup: pullback | 402 | 222 | 34.7 | -0.153 | 0.011 | 0.75 | -82,221 | -42,695 | 59,075 | NOT PROFITABLE |
| L1 setup: index | 88 | 64 | 48.4 | 0.022 | 0.184 | 1.02 | 455 | 917 | 10,195 | PROFITABLE |
| L1 longs only | 497 | 417 | 31.9 | -0.289 | -0.045 | 0.58 | -100,083 | -85,029 | 89,958 | NOT PROFITABLE |
| L1 shorts only | 652 | 390 | 32.3 | -0.276 | -0.024 | 0.58 | -100,010 | -82,501 | 100,586 | NOT PROFITABLE |
| L3 chop veto: picks KEPT | 792 | 440 | 30.7 | -0.33 | -0.061 | 0.56 | -94,220 | -89,779 | 98,983 | NOT PROFITABLE |
| L3 chop veto: picks VETOED | 642 | 337 | 37.7 | -0.026 | 0.137 | 0.92 | -98,873 | -20,719 | 52,612 | NOT PROFITABLE |
| Early detection: accumulation (Watch) | 819 | 409 | 34.2 | -0.235 | -0.008 | 0.57 | -99,446 | -77,649 | 77,649 | NOT PROFITABLE |
| Early detection: trigger (Ready) | 577 | 347 | 30.3 | -0.272 | -0.065 | 0.63 | -99,910 | -77,385 | 86,843 | NOT PROFITABLE |
| Early detection: confirmation (Go) | 532 | 295 | 29.5 | -0.286 | -0.079 | 0.58 | -93,580 | -73,325 | 82,291 | NOT PROFITABLE |
| Signal Box derivatives: bullish flags -> long | 454 | 449 | 34.5 | -0.125 | 0.058 | 0.79 | -100,076 | -61,334 | 72,662 | NOT PROFITABLE |
| Signal Box derivatives: bearish flags -> short | 705 | 424 | 31.4 | -0.127 | 0.118 | 0.67 | -100,044 | -68,827 | 82,754 | NOT PROFITABLE |
| AOC chain screeners (Triple S/R, Power, Oi2Oi, Big Bull/Bear) | 604 | 420 | 34.5 | -0.25 | -0.022 | 0.62 | -100,018 | -81,002 | 81,835 | NOT PROFITABLE |
| AOC strike shifts (SFB/SFT/STT/STB) | 545 | 436 | 35.1 | -0.165 | 0.019 | 0.76 | -100,031 | -69,209 | 85,250 | NOT PROFITABLE |
|   Triple S/R support | 470 | 435 | 36.1 | -0.203 | 0.018 | 0.67 | -100,064 | -75,631 | 76,707 | NOT PROFITABLE |
|   Triple S/R resistance | 672 | 425 | 29.9 | -0.095 | 0.111 | 0.76 | -100,016 | -62,370 | 71,602 | NOT PROFITABLE |
|   Power stock bull | 297 | 87 | 39.1 | -0.029 | 0.122 | 0.92 | -51,144 | -5,676 | 21,264 | NOT PROFITABLE |
|   Power stock bear | 768 | 417 | 33.3 | 0.128 | 0.305 | 1.02 | -100,024 | 8,656 | 69,532 | NOT PROFITABLE |
|   Oi2Oi long (own stop/target) | 502 | 402 | 32.1 | -0.25 | -0.034 | 0.68 | -99,995 | -79,863 | 92,745 | NOT PROFITABLE |
|   Oi2Oi short (own stop/target) | 557 | 381 | 33.3 | -0.032 | 0.195 | 0.83 | -99,990 | -42,685 | 69,148 | NOT PROFITABLE |
|   Big Bull | 479 | 419 | 37.2 | -0.073 | 0.09 | 0.85 | -100,029 | -41,679 | 56,452 | NOT PROFITABLE |
|   Big Bear | 667 | 432 | 30.6 | -0.143 | 0.093 | 0.67 | -100,016 | -72,956 | 84,641 | NOT PROFITABLE |
|   SFB | 494 | 443 | 32.3 | -0.205 | 0.0 | 0.7 | -100,082 | -76,573 | 76,794 | NOT PROFITABLE |
|   SFT | 624 | 433 | 31.6 | -0.237 | -0.002 | 0.65 | -99,973 | -80,815 | 84,427 | NOT PROFITABLE |
|   STT | 433 | 389 | 35.5 | -0.177 | 0.016 | 0.7 | -99,999 | -66,863 | 67,995 | NOT PROFITABLE |
|   STB | 695 | 372 | 32.0 | -0.265 | -0.031 | 0.61 | -97,075 | -79,070 | 94,214 | NOT PROFITABLE |
| CC5 screener: strong trend | 476 | 281 | 34.2 | -0.14 | 0.033 | 0.8 | -55,022 | -48,857 | 61,908 | NOT PROFITABLE |
| CC5 screener: pullback in uptrend | 376 | 220 | 35.5 | -0.123 | 0.035 | 0.83 | -72,191 | -37,478 | 66,681 | NOT PROFITABLE |
| CC5 screener: volume breakout | 518 | 294 | 29.3 | -0.239 | -0.047 | 0.73 | -71,560 | -68,325 | 79,758 | NOT PROFITABLE |
| CC5 screener: RS leaders | 484 | 257 | 31.5 | -0.295 | -0.09 | 0.63 | -87,562 | -69,818 | 71,017 | NOT PROFITABLE |
| CC5 screener: near 52-week high | 437 | 243 | 34.2 | -0.186 | -0.007 | 0.73 | -78,430 | -52,638 | 67,101 | NOT PROFITABLE |
| CC5 screener: delivery rising | 478 | 265 | 35.8 | -0.093 | 0.066 | 0.88 | -63,942 | -35,718 | 96,327 | NOT PROFITABLE |
| CC5 screener: steady uptrend | 459 | 255 | 36.1 | -0.089 | 0.086 | 0.85 | -66,341 | -33,979 | 49,341 | NOT PROFITABLE |
| CC5 screener: weakest scores (short) | 424 | 238 | 30.3 | -0.383 | -0.116 | 0.49 | -94,775 | -76,408 | 82,873 | NOT PROFITABLE |

## 4. Honest caveats and decisions (never-stop defaults)

- **Layer 1 loses mainly before costs are even charged.** Gross average R is about zero for the whole scanner, so costs, not bad luck, make the net negative. See the 'gross R' column.
- **Scope cuts forced by this PC (7.9 GB RAM, mostly in use).** (1) Early detection is scanned on the 120 stocks that spent the most days in the point-in-time top-60 F&O universe (not all 241 ever-members). (2) For the chain, early and CC5 groups at most the 2 best-ranked signals per day are offered (only 2 positions can ever be open); Layer 1 keeps its own top 5. (3) Only the nearest-expiry chain is used for the chain flags.
- **Survivorship.** The universe is the stocks that appear in the local F&O files each month; delisted names that left the files are gone. This flatters results, and they are still negative.
- **Multiple testing.** Dozens of variants were tested. A single PROFITABLE flag among them with a wide interval is expected by chance and is not evidence.
- **Cost model decision.** A first run charged long stock trades delivery-equity costs (STT 0.1% both sides) and gave Layer 1 a loss of about Rs 99,000 / 84,000 (train / test). I then costed the stock leg as stock futures, since every signal lives in the F&O universe; results stayed NOT PROFITABLE. Only the futures-style costs are in the tables; the delivery-cost run is described here for the record.
- **Layer 2 and the intraday part of Layer 3 cannot be tested** with EOD data. Supplying 15-minute bars to `data/intraday/<SYMBOL>/<DATE>.csv` (see `intraday.py`) would let them be rebuilt.
- **Windows file lock fix.** While merging, SQLite files in the paper-ledger tests were left open on Windows; the ledger now has `close()` and tests close it.
- **PR housekeeping.** Merged: #2, #11 (CC8), #3, #4, #6, #5 (python chain, needed to test the chain signals) and #10 (CC5 scores v2). Closed: #7 (superseded by #10), #8 (duplicate chain engine plus sample-data UI touching server.js), #9 (stale integration branch; its content is merged via the others).
- **Antivirus.** Windows flagged `tools/india_edge/scores/install_task.ps1` (a scheduled-task installer) as unwanted software; it is in the repo but unreadable on this PC, so I worked in a separate worktree without it.

## 5. Reproduce

```
set DATA_DIR=C:\Users\user\Desktop\niftyradar-backend\tools\india_edge\data
python tools/india_edge/data/build_stockopt_ohlc.py --workers 3
python tools/india_edge/backtest/run_signal_backtest.py --groups layer1 --out tools/india_edge/backtest/results/sig_layer1.json
python tools/india_edge/backtest/run_signal_backtest.py --groups chain --out tools/india_edge/backtest/results/sig_chain.json
python tools/india_edge/backtest/run_signal_backtest.py --groups early --out tools/india_edge/backtest/results/sig_early.json
python tools/india_edge/backtest/run_signal_backtest.py --groups scores --out tools/india_edge/backtest/results/sig_scores.json
python tools/india_edge/backtest/make_signal_doc.py
```
