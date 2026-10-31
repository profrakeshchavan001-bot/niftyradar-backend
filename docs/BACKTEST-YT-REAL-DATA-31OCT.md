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

## Sensitivity (TRAIN data only, nothing selected; heatmaps in docs/img/)

| Grid | Cells | Train-positive | Range (Rs/lot) | Reading |
|---|---|---|---|---|
| calendar (delta x DTE) | 12 | 0 | -516k to -295k | Negative everywhere: the structure loses regardless of parameters (4 legs x doubled costs). Robustly dead. |
| condor (short delta x wing delta) | 16 | 10 (5 of 9 with >=15 trades) | -30k to +150k | Profit sits mostly in the high short-delta corner (0.35); the frozen 0.30/0.16 cell (+35k) is mid-pack. Fragile, not a plateau. |
| condor (DTE x exit DTE) | 9 | 4 | -101k to +64k | Sign flips with the entry window (30-40 DTE loses at every exit setting, 50-60 DTE wins at all). Outcome depends on a window choice. |
| strangle d18 (delta x DTE) | 15 | 7 | -207k to +151k | Neighbouring cells swing from -174k to +151k; the 45-50 DTE row is mostly positive, the 30-35 and 55-60 rows mostly negative. Knife-edge, not a robust edge. |

Reading: only the calendar is consistently negative; the other three are parameter-fragile (adjacent cells disagree in sign), which is what noise or overfitting looks like. No cell was picked or tuned from this.

## Regime split (Nifty; thresholds from train: VIX median 16.47, |60d return| median 6.05%)

- Strangle d18: trending +152k train / +111k test (positive in both); range -58k train / -123k test (negative in both). High-VIX drove train (+116k) but turned negative in test (-52k, only 8 trades).
- Condor: signs flip between train and test in every regime (trending -38k then +80k; range +35k then -94k): no stable regime dependence.
- Strangle p100: same shape as d18 but weaker; low-VIX loses in both periods (-130k, -13k).
- Calendar: negative in every regime and period.
- Reading: short-strangle P&L follows trending vs range markets rather than a rule-level edge (range chop whipsaws the adjustments). These are post-hoc descriptions, not filters to trade.

## BANKNIFTY (same engine, same frozen Rs rules, lot 30, strike step 100, real settle prices)

Index close from the NSE index archive (2,706 sessions) and put-call-parity spot for 213 sessions (2015 and gaps). Lot fixed at 30 so notional is comparable to 1 Nifty lot; Rs thresholds not rescaled.

| Strategy | Cost | Train trades / Rs | Test trades / Rs | WF total, +yrs | Test worst/SL | Margin est (median) | Verdict |
|---|---|---|---|---|---|---|---|
| condor | 1x | 59 / 130,952 | 35 / 58,571 | 189,523, 7/12 | 1.08x | 58,419 | survives |
| condor | 2x | 59 / 100,960 | 35 / 40,040 | 141,000, 7/12 | 1.10x | 58,419 | survives |
| strangle_d18 | 1x | 90 / -64,138 | 45 / 197,182 | 133,046, 7/12 | 2.60x | 113,104 | survives |
| strangle_d18 | 2x | 90 / -101,733 | 45 / 177,526 | 75,795, 7/12 | 2.66x | 113,104 | survives |
| strangle_p100 | 1x | 95 / -56,956 | 45 / 88,159 | 31,202, 7/12 | 2.53x | 108,038 | survives |
| strangle_p100 | 2x | 95 / -90,999 | 45 / 76,192 | -14,806, 7/12 | 2.57x | 108,038 | dies |
| calendar | 1x | 200 / 106,472 | 73 / -52,944 | 53,529, 6/12 | 5.55x | 56,966 | dies |
| calendar | 2x | 200 / -67,696 | 73 / -119,808 | -187,505, 5/12 | 5.64x | 56,966 | dies |

Read before believing it:
- Two BANKNIFTY variants (condor, strangle d18) pass the preset rule at 2x costs. That is 2 of 8 variant-by-index tests; with this many looks a pass or two can happen by chance. A lead, not a finding.
- Strangle d18 is negative in train (-102k), positive in test (+178k), negative every year 2019-2022 (-37k, -27k, -10k, -48k) with gains concentrated in 2023-2026. Test worst loss is 2.66x the stop: stops do not hold on daily settles.
- A walk-forward that RE-SELECTS delta on the trailing 3 years loses -76k (4 of 9 years) for BANKNIFTY strangle d18, so that pass does not survive parameter re-selection. BANKNIFTY condor re-selected: +82k (5 of 9 years).
- BANKNIFTY data is noisier than Nifty (see audit): parity forward spread median 128 pts and 1,608 days with spread >100 (Nifty 21 pts, 451 days); 40 of 90 strangle d18 entries had no open print and used the settle.

## Further cuts (doubled costs, rules frozen)

Entry-VIX terciles use train edges (15.0 / 18.28); both indices use India VIX.

| Strategy | Index | VIX low / mid / high (Rs) | Monthly expiry week entries | Re-selecting walk-forward |
|---|---|---|---|---|
| strangle d18 | NIFTY | -55,599 / +99,397 / +37,771 | none (45-50 DTE entries) | +92,071, 6 of 9 yrs |
| strangle d18 | BANKNIFTY | +88,360 / -21,995 / +9,429 | none | -76,448, 4 of 9 yrs |
| condor | NIFTY | -53,390 / +32,361 / +3,736 | none | -13,984, 5 of 9 yrs |
| condor | BANKNIFTY | +38,389 / +14,921 / +87,690 | none | +81,528, 5 of 9 yrs |
| calendar | NIFTY | -255,503 / -195,602 / -98,250 | -146,229 (64 tr) vs -403,126 other (199 tr) | n/a |
| calendar | BANKNIFTY | -181,764 / +9,483 / -15,224 | -83,908 vs -103,597 other | n/a |

- VIX buckets disagree between the indices (NIFTY strangle likes mid VIX, BANKNIFTY strangle likes low VIX): no portable VIX filter.
- Expiry week: 40-50 DTE structures never enter in the expiry week; only the calendar (10-12 DTE weekly short) does, and it loses in and out of that week.
- Walk-forward with re-selection (best of 5 deltas for the strangle, 4 short deltas for the condor on trailing 3 years of entries, traded the next year, 2018-2026): mixed and unstable, in line with the sensitivity grids.
- Margin sanity (strangle d18, SPAN-like scan: spot -/+3% and -/+6%, vol +/-4 pts on the two short legs, plus 2% exposure): median scan figure Rs 42k (NIFTY, 142 entries) and Rs 40k (BANKNIFTY, 135) versus the modelled Rs 113k, so the model is about 2.5-2.7x higher and was above the scan on every entry. Capital figures above are conservative. Caveat: the scan is a crude proxy; no real SPAN file.

## Data audit summary (data/idxopt_audit.json, local)

- 2,919 daily files 2015-01-01 to 2026-10-30, no missing calendar-day files; NIFTY 6.21M rows (min 1,265/day), BANKNIFTY 3.53M rows (min 232/day).
- Non-positive settle rows: NIFTY 218k, BANKNIFTY 51k (not used: the engine keeps only contracts with settle >= 1 and OI > 0).
- Put-call parity forward spread median: NIFTY 20.7 pts (451 days >100), BANKNIFTY 128 pts (1,608 days >100): BANKNIFTY chains are noisier.
- Audit field stale_close_vs_settle_pct: 72.6 (NIFTY) and 68.0 (BANKNIFTY); the engine prices on the settle column throughout, never the close.
- Expiry weekdays: Thursday dominates (NIFTY 387 / BANKNIFTY 405 expiries); Tuesday, Wednesday and Monday expiries also appear (NIFTY 71/18/9, BANKNIFTY 24/78/3). Expiry-day settle columns hold the index settlement value and are replaced by intrinsic (fixed earlier).
- BANKNIFTY spot: 2,706 sessions from the NSE index archive plus 213 from put-call parity (flagged `parity` in data/nifty/banknifty_ohlc.csv); no open/high/low.

## Forward test (paper only)

`paper_forward.py` replays the frozen rules, then logs the open position, any hypothetical exit on the latest session and the planned next-session entry to `out/cc8_paper_ledger.csv` (symbol, strategy, verdict, kind, detail). It never places orders.

- Tested end to end on real data (asof 2026-10-30): default run logs NO_SURVIVORS for NIFTY; `--all` logs all four strategies labelled with their verdict; `--symbol BANKNIFTY` logs its two surviving variants. Re-runs append nothing new.
- Bug fixed: the dedupe key used `d.asof`, a DataFrame method, so the second run on a stored ledger crashed. Also hardened: NSE refresh failures and argparse exits never stop the logger; the bat file creates `logs\`; legacy ledgers without the symbol column are upgraded.
- `--all` replays the full history per strategy and takes about 5 minutes; the default run takes seconds when nothing survives.
- Tests: `tools/india_edge/tests/test_paper_forward.py` (5 tests).

Register the daily job once (19:45 IST; the PC must be on; runs as the current user):

```
schtasks /Create /F /SC DAILY /ST 19:45 /TN "NiftyRadar-CC8-PaperForward" /TR "\"C:\Users\user\Desktop\niftyradar-backend\tools\india_edge\run_paper_forward.bat\""
```

Check: `schtasks /Query /TN "NiftyRadar-CC8-PaperForward"`. Run now: `schtasks /Run /TN "NiftyRadar-CC8-PaperForward"`. Log: `tools\india_edge\logs\paper_forward.log`. Remove: `schtasks /Delete /TN "NiftyRadar-CC8-PaperForward" /F`.

## Bottom line

Nifty: all four variants die under the preset rule. BANKNIFTY: condor and strangle d18 pass at 2x costs but with weak evidence (parameter-fragile, strangle fails re-selection, gains concentrated after 2023, noisier data, stops overshooting 2.6x). Not advice and not a profit claim; the next step is to let the paper log run forward.
