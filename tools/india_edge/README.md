# India Edge, Layer 1: Smart Money Selection (EOD)

Reads NSE end-of-day files (free), ranks the most liquid F&O stocks, writes a top-5 list.
Layer 1 only: no options strategy, no Layer 2/3. Statistics and screening, not advice.

## Setup (once, Windows PowerShell)

```powershell
cd tools\india_edge
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
```

## Run nightly

```powershell
.venv\Scripts\python run_scanner.py
```

This downloads any missing days (last 90 days, incremental), refreshes `universe.json` when the month changes, scores the latest trading day and writes the outputs. Useful flags: `--date 2026-10-28`, `--no-fetch` (stored data only), `--refresh-universe`.

First-time backfill (optional, bigger history): `.venv\Scripts\python data\fetch.py --from 2026-06-01 --to 2026-10-28`

Run the tests: `.venv\Scripts\python -m unittest discover -s tests`

## Windows Task Scheduler, weekdays 7:30 pm IST

`daily_pipeline.bat` runs download → scanner → `out/morning_desk.json` and logs to `logs/pipeline.log`.
Exact `schtasks` command, verification, manual jobs and data notes: [docs/INDIA-EDGE-RUNBOOK.md](docs/INDIA-EDGE-RUNBOOK.md).
Latest backtest: [docs/BACKTEST-REPORT-2026-10-30.md](docs/BACKTEST-REPORT-2026-10-30.md).

## Outputs

| Path | What |
|---|---|
| `out/top5_<date>.json` / `.md` | ranked picks with score, grade, setup, features |
| `out/latest.json` | copy of the newest run |
| `data/cash`, `data/fo`, `data/idx` | one parquet per day (cash+delivery, stock F&O, index closes) |
| `universe.json` | top 60 by 20-day avg option contracts, rebuilt each new month |

All the above are git-ignored.

## How it scores

Weights, thresholds and grade cut-offs are in `config.yaml`. Score = quadrant 30 + delivery 20 + RS 20 + sector RS 15 + unusual OI 15. RS points only count when they agree with the OI quadrant. Grade A >= 70, B 50-69, C < 50. Stocks with direction `none` or 20-day average traded value below `min_adv_cr` are excluded from the top 5.

Setup labels are heuristics: `index` = sector-led move with weak stock-specific RS; `trend` = fresh buildup; `pullback` = short covering / long unwinding.

Sector map: `sectors.json` (no sector map existed in the repo; edit freely, unmapped symbols become "Other"). Sector RS is the equal-weight 20-day return of universe members in that sector minus Nifty 50.

## Notes

- Data URLs are NSE archive files (`sec_bhavdata_full`, UDiFF `BhavCopy_NSE_FO`, `ind_close_all`). If NSE changes a format, `data/fetch.py` fails loudly per day and keeps the rest.
- Holidays: a 404 older than 4 days is remembered in `data/.missing.json`.
- `pyarrow` (parquet) and `pyyaml` (config) are added to the requirements next to pandas/numpy/requests.

## Backtest

```powershell
.venv\Scripts\python data\fetch.py --from 2015-01-01 --to 2026-10-28   # long run; restartable, skips stored days
.venv\Scripts\python backtest\run.py --train --test
```

Signals are produced as-of each day (data up to that close), top 5 of grade A/B, entry next open, stop 1.5x ATR(14), target 2R, exit at day-5 close, cost 0.1R, 1% risk. Train 2015-01-01 to 2022-12-31 (weights tuned on a coarse grid, best expectancy with at least 200 trades, saved to `config_tuned.yaml`); test 2023-01-01 to today with those weights untouched. `config.yaml` is never modified. Output: `backtest/out/report_<date>.md` (by grade, setup, direction) and `backtest/out/equity.csv`.

Caveats: same-day stop and target counts as stop; prices are not adjusted for splits/bonus (rare outliers); pre-July-2024 F&O files use NSE's older format (handled in `fetch.py`); a day whose files NSE does not serve is logged and skipped.

## Layers 2/3, paper bot, Morning Desk

See `docs/INDIA-EDGE-RUNBOOK.md` (repo root). Quick tour on the synthetic fixtures:

```powershell
.venv\Scripts\python run_daily.py --replay 40
.venv\Scripts\python weekly_review.py
.venv\Scripts\python audit_lookahead.py
```

Settings for Layer 2/3 and the paper bot are in `config_exec.yaml`. `DATA_DIR` switches every script from the fixtures to real bhavcopy.
