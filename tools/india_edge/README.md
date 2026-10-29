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

## Windows Task Scheduler, 10:30 pm IST

1. Open Task Scheduler, **Create Task** (not Basic Task). Name: `IndiaEdge Layer1`.
2. **Triggers** > New > Daily, start time `22:30:00`. (PC clock must be IST; if not, convert.) Optionally limit to Mon-Fri via Weekly.
3. **Actions** > New > Start a program:
   - Program: `C:\path\to\niftyradar-backend\tools\india_edge\.venv\Scripts\python.exe`
   - Arguments: `run_scanner.py`
   - Start in: `C:\path\to\niftyradar-backend\tools\india_edge`
4. **Settings**: tick "Run task as soon as possible after a scheduled start is missed".

Or one line from an admin prompt:

```powershell
schtasks /Create /TN "IndiaEdge Layer1" /SC DAILY /ST 22:30 /TR "cmd /c cd /d C:\path\to\niftyradar-backend\tools\india_edge && .venv\Scripts\python.exe run_scanner.py"
```

NSE usually publishes bhavcopy by about 7 pm IST, so 10:30 pm is safe.

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
