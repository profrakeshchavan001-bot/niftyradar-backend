# India Edge 3-Layer Backtest Report, 30 Oct 2026

Data: NSE bhavcopy 2015-01-01 to 2026-10-29 (2,918 days, cash + F&O + index). Train 2015-22, test 2023 to 29 Oct 2026. 0.1R cost per trade, next-open entry, 1.5 ATR stop, 2R target, 5-day exit. Every threshold was tuned on train only; test was run once, untouched. Statistics on historical data, not advice.

## Result: no tradable edge on the test period

| Variant (params fixed from train) | Train trades | Train net R | Test trades | Test net R | Test PF | Test win % |
|---|---|---|---|---|---|---|
| L1 only | 8,425 | −0.072 | 4,499 | −0.066 | 0.85 | 43.6 |
| L1 + L2 (candle + squeeze) | 1,085 | −0.058 | 505 | −0.097 | 0.79 | 42.2 |
| L1 + L3 (chop, expiry) | 5,864 | −0.085 | 3,162 | −0.097 | 0.78 | 42.9 |
| **L1 + L2 + L3 (tuned)** | 417 | **+0.057** | 231 | **−0.102** | 0.78 | 41.1 |
| tuned minus L2 candle | 2,393 | −0.019 | 1,294 | −0.130 | 0.73 | 41.1 |
| tuned minus squeeze | 1,417 | −0.063 | 726 | −0.116 | 0.75 | 42.4 |
| tuned minus chop | 905 | −0.037 | 421 | −0.081 | 0.82 | 42.8 |
| tuned minus expiry veto | 480 | +0.047 | 273 | −0.090 | 0.81 | 41.0 |
| tuned minus event veto | 417 | +0.057 | 231 | −0.102 | 0.78 | 41.1 |

Tuned filter set (chosen from a 160-point grid on train): candle pattern (engulfing/hammer/shooter) agrees with direction, volatility squeeze in the last 5 sessions, 20-day efficiency ratio ≥ 0.35, skip entry on or just before a monthly expiry. Test by year: 2024 −0.196R (60 trades), 2026 −0.263R (37 trades).

**Read:** the stack looked like an edge on train (+0.057R over 417 trades, PF 1.13) and reversed out of sample (−0.102R). That is overfitting to the train grid, not a signal. The ablation shows each filter helps on train and none holds on test. The event veto never changed a trade (no earnings/RBI dates exist in daily data), so it is untested.

## Scoring diagnosis (train, 8.4k+ candidate rows)

Correlation of each Layer 1 component with gross R is near zero (all within ±0.02): quadrant +0.015, delivery −0.003, RS +0.005, sector RS +0.018, unusual OI −0.005. Gross R by score quintile climbs only from −0.031 to +0.006. The score ranks weakly, the gross edge (about +0.03R) is smaller than the 0.1R cost, and the "grade A beats B" assumption fails (A was worse than B in the earlier Layer 1 run).

## Reliability audit

1. **Layer 2 is a daily proxy.** Real Layer 2 (15-minute OB/FVG, BOS/engulfing, ORB/VWAP, trade windows) needs intraday bars, which this run does not have. Here it is replaced by the signal-day candle shape. These results say nothing about the intraday timing logic. Its code is merged and unit-tested on synthetic fixtures only.
2. **Event veto is calendar-only.** Budget days and election results are hardcoded. Earnings, RBI and stock-specific events are absent. The 2-day event veto is therefore largely untested.
3. **Expiry days** come from F&O contract dates in the data and are exact. Entry on expiry day or the day after the signal being expiry are both skipped.
4. **Corporate actions:** the backtest reads raw prices; splits/bonuses can create false gaps and distort ATR on those days. The live loader adjusts for them (`robust.py`), the backtest does not. The effect on this result was not measured.
5. **Selection bias:** 160 configurations were tried on train; the best by net R is expected to be inflated. Train-test gap of 0.159R confirms it.
6. **Execution:** fills at the next open with no slippage beyond the 0.1R cost; same-bar stop and target resolves to stop; the universe (monthly top 60 by option contracts, ranked on prior data) uses no future data. A lookahead audit of Layer 1 passed earlier (`backtest/audit.py`); the new Layer 2/3 flags use only data to the signal day's close.
7. **Sample size:** 231 test trades (about 5 a month) and a 2026 slice of 37 trades are too few for confident conclusions in either direction.
8. **Intraday-only items not tested:** option IV percentile and bid-ask spread vetoes (no IV/quote history), paper-bot kill switches, Telegram alerts, option-chain S/R.

## Recommendations

1. Do not trade the stack. Use Morning Desk as a watchlist and paper-trade only.
2. Get real intraday 15m data (free source or the broker API's history) before judging Layer 2; rerun this harness with real timing.
3. Add earnings/RBI dates as an events file (`events.csv`, already supported by the loader) to test the event veto properly.
4. Fix the score: no component predicts gross R. Look for features with a gross edge well above 0.1R before adding more filters.

Files: `backtest/layers.py`, `backtest/results/layers-*/summary.json`, `config_layers.yaml`.

---

# Appendix: Layer 1-only backtest (earlier run)

| | Train 2015–2022 | Test 2023–Oct 2026 | 2024 only | 2026 only |
|---|---|---|---|---|
| Trades | 7,009 | 3,327 | 947 | 643 |
| Trades / month | 73 | 73 | 79 | 65 |
| Win rate | 44.8% | 43.0% | 44.6% | 42.3% |
| Expectancy (net of 0.1R cost) | −0.067R | −0.079R | −0.064R | −0.120R |
| Profit factor | 0.85 | 0.82 | 0.85 | 0.74 |
| Max drawdown | 503R | 280R | 107R | 81R |
| Best slice: "index" setup | +0.034R (304 trades) | **+0.089R (205 trades)** | −0.342R (37) | −0.047R (33) |
| Grade B | −0.056R | −0.028R | −0.018R | −0.039R |
| Grade A | −0.077R | −0.139R | −0.124R | −0.223R |

Calibrated weights and cut-offs, with the "Tuned" numbers above. Statistics on historical data, not advice.

## What was tested

- **Data:** NSE daily bhavcopies, 1 Jan 2015 to 29 Oct 2026, covering 2,919 trading days of cash + delivery, stock F&O and index closes. The download checks are in `data/manifest.json`.
- **Universe:** each month, the 60 F&O stocks with the most stock-option contracts over the previous 20 sessions. Ranking uses only the month before.
- **Signal:** the Layer 1 score (OI quadrant, delivery, RS vs Nifty, sector RS, unusual option OI) at the day's close. Each day, the top 5 grade A/B stocks are traded.
- **Trade:** buy or short at the next open. Stop is 1.5×ATR(14), target is 2R, and anything still open is closed at the 5th day's close. Each trade is charged 0.1R for costs.
- **Calibration:** done on 2015–2022 only. A grid search covered the five weights (10/20/30 each) and the A/B cut-offs. The pick was the best net expectancy with at least 200 trades. Result: weights quadrant 11, delivery 11, RS 11, sector RS 33, unusual OI 33; A ≥ 65, B ≥ 55 (were 70/50). The 2023–2026 data was never touched during tuning.
- **Lookahead audit (`backtest/audit.py`):** features, universe and entries were recomputed with all later rows removed at 8 cut dates, and matched exactly. A deliberately planted "tomorrow's close" leak was caught. **Passed.**

## What it means

1. **The strategy loses money as it stands.** About 43–45% of trades win, and before costs the average trade makes only +0.02 to +0.03R. The 0.1R cost per trade wipes that out. This holds in every window, including the unseen 2023–2026 period.
2. **Tuning did not help out of sample.** The tuned score is better on train (−0.067R vs −0.090R) but no better on test (−0.079R vs −0.078R). The train–test gap is small (0.013R), so there is no overfitting flag. There is also no real edge to overfit.
3. **The grades are upside down.** Grade A trades do worse than grade B in every window, and much worse since 2023. A higher score is not picking better trades.
4. **The only positive slice is the "index" setup:** a strong sector with a weak stock-specific move. It made +0.089R in test, but over only about 4 trades a month. It was negative in 2024 and 2026 taken alone.

## Recommendations

1. **Do not trade the Layer 1 top 5 as it stands.** Use it as a watchlist only until a version shows positive net expectancy on the 2023–2026 test period.
2. **Rework the scoring before tuning more weights.** Grade A doing worse than B points to a feature that pushes up the score but hurts trades. Start with the RS and quadrant components on "pullback" setups, which lose about −0.1R or more in every window. Then test removing pullbacks entirely.
3. **Look at exits and costs, not only selection.** The gross edge is about +0.03R per trade, so a cost of 0.1R is decisive. Test a longer hold or a wider target, fewer trades a day (top 2–3), and the "index" setup alone. Judge every change on the 2023–2026 window it was not tuned on.

Files: `backtest/results/20261030-045122/` (report.md, summary.json, trade lists, equity.csv, config_tuned.yaml). Re-run with `python backtest/calibrate.py`.
