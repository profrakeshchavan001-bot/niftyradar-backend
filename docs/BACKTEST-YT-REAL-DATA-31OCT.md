# Real-data backtest of the 3 YouTube option structures - 31 Oct 2026

Research measurement only: not advice, no profit claim. Real NSE NIFTY option settle prices (2015-01 to 2026-10, 2919 sessions), real Nifty OHLC. Black-Scholes is used only to read a delta off a real price. Costs DOUBLED, train = entries to 2022-12-31, test = 2023+, walk-forward by calendar year, Rs per 1 lot (75). Stops are evaluated ONLY on real daily settles (intraday touches invisible; gap losses booked at that day's settle). Rules frozen, nothing tuned.

## Verdict (plain words, 31 Oct 2026; research measurement, not advice, no profit claim)

**Survivors (passed on real settle prices, 2x costs, across a pre-registered grid; none is proven):**
- NIFTY weekly short strangle entered 2 calendar days before expiry (18-delta): passes in all 7 parameter sets (3 other deltas, 3 other stops), positive in both halves (2015-21 +82k, 2022-26 +190k per lot) and in 7 of 7 years 2019-2025. Caveats: stops almost never act (355 of 371 trades run to expiry), worst trade -36k, max drawdown 87k, and the rule has NO entries in 2026 (see Study 2).
- BANKNIFTY monthly condor: passes in 6 of 7 sets (the 7th had only 25 trades) and is positive in both halves in all 6 (fit 2015-21 +117k, 2022-26 +155k for the chosen set). Caveats: only 94 trades, 48 months skipped by the 1:2 rule, stops at 1.5x/2x are effectively "no stop".

**Dead:**
- All four NIFTY monthly structures (earlier section).
- NIFTY expiry-day-only (0 DTE) strangle: train negative in all 7 sets, passes only in 2 of 7; NIFTY 0 DTE and 2 DTE condor: 0 of 14 sets pass.
- Calendar on both indices; BANKNIFTY strangle p100 (passes in 3 of 7 sets only because of the stop level, train negative in every set).

**Only works after 2022 (cannot be called a survivor):** BANKNIFTY strangle d18 passes 4 of 7 sets but the 2015-21 half is negative in all 7, so nothing was confirmed out of sample; it is a regime result.

**Needs real SPAN margin before any capital decision:** every survivor. The margin used here is an estimate (about 2.5x a crude SPAN-like scan, so likely conservative) and no SPAN file exists in the data. Also unverified: intraday stop touches (daily settles only), fill quality at the open, and live behaviour; the paper-forward log is the next test.

Not tested: a 2-trading-day entry (needed after Nifty expiries moved to Tuesday in Q4 2025), BANKNIFTY weeklies (no BANKNIFTY weekly study run), real lot-size history, SPAN, intraday data.


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

## Study 2: robustness grid, weekly Nifty, out-of-sample (costs 2x, real settles only, nothing re-chosen per year)

Grid fixed in advance, one parameter changed at a time: 3 other deltas (or premiums) and 3 other stop levels per structure. Strangle deltas 0.12/0.24/0.30 (base 0.18), premiums 70/140/200 (base 100), stop Rs 8k/18k/26k (base 13k, take-profit unchanged); condor short deltas 0.20/0.25/0.35 (base 0.30), stop 0.5x/1.5x/2x credit (base 1x). A set PASSES when the preset rule holds (train and test >= 20 trades, test > 0, walk-forward total > 0, at least half the years positive) AND at least 5 of the 8 years 2019-2026 are positive. Out-of-sample: pick the set with the best net on entries before 2022 (>= 15 trades), read its 2022-26 result unchanged. Base-rule results reproduce the earlier BANKNIFTY/NIFTY runs exactly. Full per-year and per-regime detail (VIX terciles, monthly expiry week) per set is in `backtest/options_real_study2.json`.

| Family (index / entry / structure) | Sets passing | Base: train / test Rs | Set chosen on 2015-21 | Its net 2015-21 / 2022-26 Rs | Sets positive in both halves |
|---|---|---|---|---|---|
| BANKNIFTY/monthly/strangle_d18 | 4/7 | -101,733 / 177,526 | sl=8000 | -8,855 / 113,180 | 0/7 |
| BANKNIFTY/monthly/strangle_p100 | 3/7 | -90,999 / 76,192 | premium=140 | -15,300 / 52,418 | 0/7 |
| BANKNIFTY/monthly/condor | 6/7 | 100,960 / 40,040 | sl_mult=1.5 | 117,435 / 155,445 | 6/6 |
| NIFTY/weekly0/strangle_d18 | 2/7 | -43,889 / 93,041 | delta=0.3 | -38,390 / 95,217 | 0/7 |
| NIFTY/weekly0/condor | 0/7 | -102,529 / -76,238 | short_delta=0.2 | 2,344 / -29,872 | 0/7 |
| NIFTY/weekly2/strangle_d18 | 7/7 | 92,243 / 179,523 | sl=8000 | 88,492 / 191,668 | 7/7 |
| NIFTY/weekly2/condor | 0/7 | -145,764 / -1,855 | short_delta=0.2 | -40,767 / -54,331 | 0/7 |

How entries are defined: monthly = 40-50 DTE (condor) or 45-50 DTE (strangle) as before; weekly0 = enter at the open of the expiry day, settle the same day at the index settlement (exit reason EXPIRY0; stops cannot act); weekly2 = enter at the open 2 calendar days before a listed expiry, hold to expiry (no 15-DTE or 7-DTE exits).

Reading, per family:
- NIFTY weekly2 strangle: all 7 sets pass and are positive in both halves. Parameters hardly matter because 355 of 371 trades run to expiry; the result is one mechanism (selling 2-day premium), not seven independent confirmations. 2019-2025 each positive; 2015-2018 entries are the old monthly expiries only. Tail: worst trade -36k (base) to -46k (delta 0.30), max drawdown 87k, 12 of 371 trades lose more than 1.1x the stop because stops see only daily settles.
- Data gap for weekly2: Nifty weekly expiries moved to Tuesday in Q4 2025 (checked in the expiry list: 12 of 14 Q4-2025 expiries are Tuesdays), so no entry exists 2 calendar days before expiry (it would be a Sunday). The rule has zero 2026 trades; its last entry is 2025-08-26. A 2-trading-day variant (Friday entry) was NOT run.
- NIFTY weekly0 strangle: train negative in every set, positive test; 2 of 7 pass (deltas 0.24, 0.30). Stop levels change nothing because the position never survives a night. The pass is a post-2022 effect: fit half -43k, 2022-26 +93k for the base rule.
- Condor, weekly0 and weekly2: 0 of 14 sets pass; negative nearly every year.
- BANKNIFTY strangle d18 and p100: positive 2022-26 in 6 of 7 sets each but the 2015-21 half is negative in all 7 (d18) and all 7 (p100): the grid never found an edge in the fit half, so the out-of-sample "result" is not a confirmation.
- BANKNIFTY condor: positive in both halves in all 6 eligible sets; chosen set (stop 1.5x) +117k then +155k. Base rule alone: +107k then +34k.
- Multiple looks: 49 runs in this study on top of 8 earlier BANKNIFTY/NIFTY tests; the base rules were seen on the full period before this split, so only the grid selection is out of sample, not the base rule.

## Bottom line

Nifty: all four variants die under the preset rule. BANKNIFTY: condor and strangle d18 pass at 2x costs but with weak evidence (parameter-fragile, strangle fails re-selection, gains concentrated after 2023, noisier data, stops overshooting 2.6x). Not advice and not a profit claim; the next step is to let the paper log run forward.
