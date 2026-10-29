# India Edge Layer 1: Backtest Report, 30 Oct 2026

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
