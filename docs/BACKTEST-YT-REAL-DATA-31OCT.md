# Real-data backtest of the 3 YouTube option structures - 31 Oct 2026

Research measurement only: not advice, no profit claim. Real NSE NIFTY option settle prices (2015-01 to 2026-10, 2919 sessions), real Nifty OHLC. Black-Scholes is used only to read a delta off a real price. Costs DOUBLED, train = entries to 2022-12-31, test = 2023+, walk-forward by calendar year, Rs per 1 lot (75). Stops are evaluated ONLY on real daily settles (intraday touches invisible; gap losses booked at that day's settle). Rules frozen, nothing tuned.

## Paper-forward job: exact register command (NOT registered yet; run once, 19:45 IST, PC must be on)

```
schtasks /Create /F /SC DAILY /ST 19:45 /TN "NiftyRadar-CC8-PaperForward" /TR "\"C:\Users\user\Desktop\niftyradar-backend\tools\india_edge\run_paper_forward.bat\""
```

Check: `schtasks /Query /TN "NiftyRadar-CC8-PaperForward"`. Run now: `schtasks /Run /TN "NiftyRadar-CC8-PaperForward"`. Remove: `schtasks /Delete /TN "NiftyRadar-CC8-PaperForward" /F`. Logs only the variants in `tools/india_edge/backtest/survivors.json`; writes `tools\india_edge\out\cc8_daily_summary_latest.txt` and `logs\paper_forward.log`.

## Verdict (31 Oct 2026; research measurement on history, doubled costs, real settle prices; not advice, no profit claim)

1. SURVIVOR: the Nifty strangle entered 2 trading days before expiry (18-delta, both options sold) earned +344k per lot over 451 trades (2015 to Oct 2026), positive in 7 of 7 years 2019-2025.
2. It passes the Benjamini-Hochberg correction (q = 0.026) and beat all 15 random-entry draws (best draw 299k); it does NOT pass the stricter Holm correction (adjusted p = 0.25).
3. Since the Tuesday-expiry change (2025-09-02) it has 61 trades and +109k: the sample is too small (about 14 months) to say anything on its own.
4. Its tail: worst trade -56k, worst day -52k (12 Mar 2020, index -8.3%), max drawdown 93k; stop levels do not change that because only daily settles are visible.
5. SAMPLE TOO SMALL: BANKNIFTY monthly condor, 94 trades, +141k, but the 95% interval is -76k to +355k, so it is not distinguishable from zero; it fails Benjamini-Hochberg and 4 of 15 random-entry draws did better. It is not in the forward log.
6. DEAD: all four Nifty monthly structures, both calendars, both Nifty condors (weekly) and BANKNIFTY strangle p100.
7. ONLY AFTER 2022, not confirmed: BANKNIFTY strangle d18 (negative in 2015-21 in all 7 parameter sets) and the Nifty expiry-day-only strangle (no set positive in both halves); neither passes Benjamini-Hochberg.
8. MULTIPLE TESTING: 113 parameter sets were looked at; no survivor passes Holm; 15 of 29 pass Benjamini-Hochberg but they are variants of the same two ideas, so read it as two candidates, not fifteen.
9. NEEDS REAL SPAN MARGIN: every survivor (the margin figure is only an estimate; no SPAN file exists); also unverified: intraday moves, fills at the open, real lot sizes, the NSE holiday calendar.
10. The forward paper log runs only the Nifty 2-trading-day strangle and does not place orders.

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

`paper_forward.py` replays the frozen rules and, for ONLY the variants listed in `tools/india_edge/backtest/survivors.json` (today: the Nifty 2-trading-day strangle), logs the open position, any hypothetical exit on the latest session and the planned next-session entry to `out/cc8_paper_ledger.csv` (symbol, variant, strategy, verdict, kind, detail), and writes a one-screen `out/cc8_daily_summary_latest.txt`. It never places orders. The register command is at the top of this document.

- Real-data run (asof 2026-10-30): 1 open position (entered 2026-10-30, expiry 2026-11-03), no entry planned for the next session; `--all` still logs the four monthly structures labelled with their verdict; an empty survivors list logs NO_SURVIVORS. Re-runs append nothing new.
- Bugs fixed so far: dedupe key used `d.asof` (a DataFrame method) and crashed the second run; the newest expiry past the last stored session was invisible; NSE refresh failures never stop the logger; legacy ledgers are upgraded.
- Next-session dates assume no NSE holiday (calendar not in the data), so the plan line is indicative.
- Tests: `tests/test_paper_forward.py` (10), `tests/test_study3.py` (11).

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
- Data gap for weekly2: Nifty weekly expiries moved to Tuesday in Q4 2025 (checked in the expiry list: 12 of 14 Q4-2025 expiries are Tuesdays), so no entry exists 2 calendar days before expiry (it would be a Sunday). The rule has zero 2026 trades; its last entry is 2025-08-26. A 2-trading-day variant was run afterwards (Study 3).
- NIFTY weekly0 strangle: train negative in every set, positive test; 2 of 7 pass (deltas 0.24, 0.30). Stop levels change nothing because the position never survives a night. The pass is a post-2022 effect: fit half -43k, 2022-26 +93k for the base rule.
- Condor, weekly0 and weekly2: 0 of 14 sets pass; negative nearly every year.
- BANKNIFTY strangle d18 and p100: positive 2022-26 in 6 of 7 sets each but the 2015-21 half is negative in all 7 (d18) and all 7 (p100): the grid never found an edge in the fit half, so the out-of-sample "result" is not a confirmation.
- BANKNIFTY condor: positive in both halves in all 6 eligible sets; chosen set (stop 1.5x) +117k then +155k. Base rule alone: +107k then +34k.
- Multiple looks: 49 runs in this study on top of 8 earlier BANKNIFTY/NIFTY tests; the base rules were seen on the full period before this split, so only the grid selection is out of sample, not the base rule.

## Study 3: 2-trading-day Nifty strangle, multiple testing, random-entry null, stress days, condor interval (costs 2x, real settles)

Method: entry at the open of the session that is exactly 2 SESSIONS before a listed expiry (real expiry list, so Friday entries for Tuesday expiries), hold to expiry, no 7-DTE exit. Same 7 parameter sets as Study 2 (3 other deltas, 3 other stops). First Tuesday weekly expiry in the data: 2025-09-02. Raw output: `backtest/options_real_study3.json`.

### 1) Before and after the expiry-day change (base rule)

| Period | Trades | Total Rs per lot | Avg per trade | Win % | Worst trade | Max drawdown |
|---|---|---|---|---|---|---|
| 2015-18 (only monthly expiries listed) | 48 | -10,572 | -220 | 72.9 | -9,819 | 28,782 |
| 2019-01 to Aug 2025 (Thursday weeklies) | 342 | +246,431 | +721 | 74.0 | -55,972 | 93,444 |
| After 2025-09-02 (Tuesday weeklies) | 61 | +108,529 | +1,779 | 78.7 | -28,266 | 41,321 |
| All | 451 | +344,389 | +764 | - | -55,972 | 93,444 |

All 7 sets pass the preset rule (totals +276k to +427k). The earlier calendar-day version had no 2026 entries; this one does. The "after" window is 14 months, 2 calendar years: too short to be evidence by itself.

### 2) Multiple-testing correction

- Hypotheses counted: 61 full-period configurations with kept trades (4 Nifty monthly, 1 BANKNIFTY calendar, 49 from Study 2, 7 from this study) plus 52 train-only sensitivity cells from Study 1 treated as p = 1 (looked at, trades not kept) = 113.
- p-value: one-sided, H0 = mean net per trade <= 0, centred block bootstrap (blocks of 5 trades, 5,000 draws). Of the 29 variants that passed Study 2/3, 19 have raw p < 0.05.
- Holm (family-wise, 5%): 0 of 29 survivors pass. Benjamini-Hochberg (false-discovery 5%): 15 of 29 pass. With only the 61 tested (no padding) Holm still passes none (best adjusted p = 0.084).

| Survivor (base rule) | Raw p | Holm-adjusted | BH q | 2022+ only raw p |
|---|---|---|---|---|
| NIFTY 2-trading-day strangle | 0.0024 | 0.254 | 0.026 (pass) | 0.0024 |
| NIFTY 2-calendar-day strangle (Study 2) | 0.0032 | 0.320 | 0.026 (pass) | 0.0072 |
| BANKNIFTY monthly condor | 0.081 | 1.0 | 0.438 (fail) | 0.304 |

BH passes by family: Nifty 2-trading-day strangle 6 of 7 sets (delta 0.30 fails, q 0.059), Nifty 2-calendar-day 6 of 7, BANKNIFTY condor 3 of 6 (stops 1.5x and 2x and short delta 0.25; NOT the base rule), BANKNIFTY strangles 0 of 7, expiry-day strangle 0 of 2. The BANKNIFTY condor sets that pass are the ones whose stops almost never act, so they are post-hoc variants of an unstopped condor.

### 3) Random-entry timing null (15 draws each)

Same structure, same exits and parameters; only the fill day is drawn at random per expiry (Nifty strangle: 1-7 calendar days before expiry; BANKNIFTY condor: 25-60 days before expiry). It tests whether the chosen entry timing matters, not whether selling premium works.

| Survivor | Actual total Rs | Random-entry mean (min to max) | Draws at or above actual |
|---|---|---|---|
| NIFTY 2-trading-day strangle | 344,389 | 33,592 (-122,213 to 299,440) | 0 of 15 |
| BANKNIFTY monthly condor | 141,000 | 106,245 (-216 to 174,222) | 4 of 15 |

With 15 draws the smallest resolvable p is about 1/16.

### 4) Stress days and stops (per lot, daily mark-to-market from real settles)

| | Total | Max drawdown | Worst trade | Worst day |
|---|---|---|---|---|
| Nifty strangle, stop Rs 13k (base) | 344,389 | 93,444 | -55,972 | -51,794 |
| Nifty strangle, no stop | 347,354 | 93,143 | -55,972 | -51,794 |
| Nifty strangle, stop Rs 8k | 335,220 | 93,444 | -55,972 | -51,794 |
| BANKNIFTY condor, stop 1.0x credit (base) | 141,000 | 77,976 | -30,770 | -23,888 |
| BANKNIFTY condor, no stop | 290,285 | 40,178 | -29,004 | -33,914 |
| BANKNIFTY condor, stop 0.5x | 139,464 | 55,847 | -25,536 | -23,888 |

Nifty strangle, 10 worst days (date, loss, index move): 2020-03-12 -51,794 (-8.3%); 2024-06-04 -47,149 (-5.9%, election result); 2022-02-24 -40,378 (-4.8%); 2024-10-03 -31,383 (-2.1%); 2025-04-17 -28,368 (+1.8%); 2026-05-12 -22,061 (-1.8%); 2022-05-19 -20,228 (-2.7%); 2020-04-30 -18,916 (+3.2%); 2020-04-07 -18,747 (+8.8%); 2024-01-17 -16,291 (-2.1%). Other named days: 2020-03-13, 03-16 and 03-23, and 2016-06-24 and 2016-11-09 show 0 because no position was open (entries are 2 sessions before expiry; 2016 had only monthly expiries). Stops make no difference to the worst day: it is booked at that day's settle either way.

BANKNIFTY condor, 10 worst days: 2021-09-13 -23,888 (-0.6%); 2021-12-20 -21,543 (-3.3%); 2026-06-11 -19,574 (+0.1%); 2021-12-09 -17,846; 2021-12-15 -17,180; 2025-05-16 -16,812; 2026-06-15 -16,365; 2023-03-15 -15,455; 2022-04-04 -15,210 (+4.0%); 2022-02-16 -14,517. Several of these are days with a small index move, which points to noisy BANKNIFTY settle prices rather than market shocks (not investigated further). On 2020-03-12 the condor shows +8,032, which I have not verified. The stop at 1.0x credit halves the condor's total (141k vs 290k without) and does not reduce the worst trade.

### 5) BANKNIFTY condor: is 94 trades distinguishable from zero?

| Sample | Trades | Total Rs per lot | 95% interval (trades resampled) | Chance total <= 0 | 95% interval (whole years resampled) | Chance total <= 0 |
|---|---|---|---|---|---|---|
| 2015-26 | 94 | +141,000 | -76,141 to +354,883 | 9.8% | -6,094 to +294,143 | 3.2% |
| 2022-26 | 44 | +34,224 | -134,755 to +195,933 | 33.1% | -43,813 to +152,486 | 30.2% |
| Without the 5 best trades | 89 | +43,114 | -158,042 to +235,333 | 32.2% | -89,540 to +181,017 | 27.1% |

In plain words: the condor's result is not distinguishable from zero. Resampling trades, a zero-profit rule would produce a total this good about 1 time in 10; resampling years, 1 time in 30, but the second view rests on only 12 years and is fragile. It is positive overall because of a few large winners (without the best 5 it is +43k with a wide interval), and its 2022-26 half alone is not distinguishable from zero.

### 6) What is missing

NSE holiday calendar (next-session dates in the forward log assume no holidays); intraday prices (stops and touches); SPAN margin file; historical lot sizes; BANKNIFTY weekly structures (not run); a 2-trading-day BANKNIFTY test (not run).

### 7) Bugs found and fixed in this round

The first version of the "N sessions before expiry" entry could not see an expiry later than the last stored session, so the newest cycle (entry 2026-10-30, expiry 2026-11-03) was missing from the paper log; fixed (weekdays are counted past the end of the data) with a test. Two test expectations were also wrong and corrected.


## Bottom line

See the Verdict at the top. In one line: one candidate (Nifty 2-trading-day strangle) survives the multiple-testing and random-entry checks that were run, the BANKNIFTY condor is not distinguishable from zero, everything else is dead or regime-only, and none of it is validated against real SPAN margin or live fills. Not advice and not a profit claim; the next step is to let the paper log run forward.
