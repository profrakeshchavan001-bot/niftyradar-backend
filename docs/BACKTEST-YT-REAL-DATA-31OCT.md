# Real-data backtest of the 3 YouTube option structures - 31 Oct 2026

Research measurement only: not advice, no profit claim. Real NSE NIFTY option settle prices (2015-01 to 2026-10, 2919 sessions), real Nifty OHLC. Black-Scholes is used only to read a delta off a real price. Costs DOUBLED, train = entries to 2022-12-31, test = 2023+, walk-forward by calendar year, Rs per 1 lot (75). Stops are evaluated ONLY on real daily settles (intraday touches invisible; gap losses booked at that day's settle). Rules frozen, nothing tuned.

## Verdicts

| Strategy | Train trades / total Rs / maxDD | Test trades / total Rs / maxDD | WF total, +yrs | Worst loss / SL (test) | Margin est (median) | Verdict |
|---|---|---|---|---|---|---|
| condor | 73 / -2,581 / 55,843 | 39 / -14,713 / 89,408 | -17,293, 4/12 | -24,930 = 1.34x | 57,829 | **dies** |
| strangle_d18 | 96 / 93,409 / 101,552 | 46 / -11,840 / 89,779 | 81,569, 9/12 | -24,098 = 1.85x | 113,324 | **dies** |
| strangle_p100 | 96 / -15,618 / 162,739 | 45 / -108 / 105,015 | -15,725, 5/12 | -22,626 = 1.74x | 109,961 | **dies** |
| calendar | 155 / -322,217 / 321,834 | 108 / -227,138 / 236,753 | -549,355, 1/12 | -17,560 = 2.93x | 76,950 | **dies** |

All four variants fail the preset rule (test > 0, walk-forward > 0, at least half the years positive). Strangle d18 is positive in walk-forward (9 of 12 years) but negative in test, so it dies by the rule fixed upfront. Nothing was tuned to rescue anything.

## Modelled (earlier doc) vs real - why they differ

| Strategy | Modelled x2 cost train/test Rs | Real x1 cost train/test Rs | Real x2 cost train/test Rs |
|---|---|---|---|
| condor | 17,992 / 47,585 | 59,805 / 19,767 | -2,581 / -14,713 |
| strangle | 258,717 / 40,664 | 154,369 / 28,118 | 93,409 / -11,840 |
| calendar | -343,676 / -116,216 | -76,855 / -60,034 | -322,217 / -227,138 |

- The flat-IV Black-Scholes model had no skew and no bid/ask, so short-premium results looked better than real settles allow; real prices cut gross edge sharply.
- Costs matter: doubling costs turns small real positives (1x) into losses, esp. the calendar (4 legs, many adjustments).
- Bug found and fixed on the way: on expiry day the bhavcopy stamps the index settlement value in every strike's settle column; expiring legs are valued at intrinsic instead.
- Condor: 29 entries skipped because 30/16-delta wings fail the 'max loss <= 2x credit' reading of the 1:2 rule on real prices.

## Capital and regimes

Capital (margin max + worst-period drawdown, estimates, no SPAN file): {"condor": {"margin_median_inr": 57829.0, "margin_max_inr": 112349.0, "max_dd_inr_worst_period": 89408.0, "worst_trade_inr": -24930.0, "capital_to_cover_margin_plus_dd": 201757}, "strangle_d18": {"margin_median_inr": 113324.5, "margin_max_inr": 226409.0, "max_dd_inr_worst_period": 101552.0, "worst_trade_inr": -25867.0, "capital_to_cover_margin_plus_dd": 327961}, "strangle_p100": {"margin_median_inr": 109961.0, "margin_max_inr": 226409.0, "max_dd_inr_worst_period": 162739.0, "worst_trade_inr": -24293.0, "capital_to_cover_margin_plus_dd": 389148}, "calendar": {"margin_median_inr": 76950.0, "margin_max_inr": 117659.0, "max_dd_inr_worst_period": 321834.0, "worst_trade_inr": -17912.0, "capital_to_cover_margin_plus_dd": 439493}}

Regime split (thresholds from train): {"vix_median": 16.47, "abs_60d_return_median": 0.0605} - per-strategy detail in backtest/options_real_extra.json.

## Not finished (usage limit reached)

Sensitivity heatmaps were generated (docs/img if matplotlib ran; CSV in backtest/results/) but not interpreted here; Data-quality audit is in data/idxopt_audit.json (local, ignored). Forward harness paper_forward.py is written but NOT run or tested; no strategy survives so it logs NO_SURVIVORS unless run with --all.
