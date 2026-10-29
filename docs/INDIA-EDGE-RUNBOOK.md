# India Edge runbook (Windows PC, nightly)

Everything lives in `tools/india_edge/` and is plain Python (pandas, numpy, requests, pyarrow, pyyaml). It reads free NSE end-of-day files. Nothing here places real orders: the "bot" is a paper ledger. Output is statistics and paper results, not investment advice.

## What runs

| Layer | File | What it does |
|---|---|---|
| Data | `data/fetch.py` | Downloads cash bhavcopy (with delivery %), F&O bhavcopy and index closes into `data/{cash,fo,idx}/YYYY-MM-DD.parquet`. Incremental. |
| 1 | `run_scanner.py`, `layer1.py` | Scores the top F&O stocks (OI quadrant, delivery spike, RS, sector RS, unusual OI). Writes `out/top5_<date>.json/.md`. |
| 2 | `timing.py`, `session.py` | 15-minute OB/FVG pullback, BOS or engulfing trigger, ORB/VWAP side, trade windows 09:30-11:00 and 13:30-15:00 IST. |
| 3 | `vetoes.py` | Chop regime, IV percentile above 70, event within 2 days, expiry day, target beyond expected move, option spread above 2% of premium. |
| Paper bot | `paper_ledger.py`, `alerts.py` | Virtual ledger, 1-2% risk, max 2 positions, kill-switch, Watch/Ready/Go alerts. |
| Desk | `morning_desk.py`, `web/index.html` | `web/morning_desk.json` + a single-file page (lightweight-charts from a pinned CDN). |
| Backtest | `backtest/run.py` | Train 2015-2022 / test 2023-today with the execution model in its README section. |
| Review | `weekly_review.py`, `audit_lookahead.py` | Sunday stats, and a lookahead audit that exits 1 on any leak. |

## One-time setup

```powershell
cd tools\india_edge
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python data\fetch.py --from 2015-01-01 --to 2026-10-28
```

The first download is long (about 3 files per trading day). It is safe to stop and restart; stored days are skipped and failed days are logged and skipped.

## Environment variables

| Name | Needed | Meaning |
|---|---|---|
| `DATA_DIR` | no | Folder holding `cash/ fo/ idx/` day files. `nightly.py` defaults it to `tools\india_edge\data`. If you run other scripts by hand, set it, otherwise they use the synthetic fixtures. |
| `TELEGRAM_ENABLED` | no | Must be exactly `true` to send anything. Default: nothing is ever sent. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | only if enabled | Your bot credentials. Never commit them; set them in the Task Scheduler action or Windows user variables. |

## Optional real inputs (the free bhavcopy does not contain these)

| File | Used for | If missing |
|---|---|---|
| `DATA_DIR\intraday\<SYMBOL>\<YYYY-MM-DD>.csv` (`ts,open,high,low,close,volume`, 15-minute bars, IST bar start) | Layer 2 timing and the paper session | The paper session cannot settle that day (nothing is invented for real data). |
| `DATA_DIR\iv.parquet` (`date,symbol,iv,opt_spread_pct,opt_premium`) | IV percentile, expected move, spread veto | These vetoes show "unavailable" and do not veto (set `veto_on_missing_iv: true` in `config_exec.yaml` to be strict). |
| `DATA_DIR\events.csv` (`date,symbol,kind`; symbol `ALL` = market-wide) | Event veto | Event veto shows "no event in window". |

## Nightly job (10:30 pm IST)

`python nightly.py` does: fetch the last 10 days, write the Layer 1 top 5, settle yesterday's desk if its 15-minute bars exist, scan, write `web\morning_desk.json`.

Task Scheduler:

1. Create Task (not Basic). Name `IndiaEdge Nightly`. Tick "Run whether user is logged on or not".
2. Trigger: Daily (or Weekly Mon-Fri), `22:30:00`. The PC clock must be IST.
3. Action: Start a program. Program `C:\path\niftyradar-backend\tools\india_edge\run_nightly.bat`. Start in `C:\path\niftyradar-backend\tools\india_edge`.
4. Settings: "Run task as soon as possible after a scheduled start is missed".
5. Log: `tools\india_edge\logs\nightly.log`.

Sunday review (optional second task, Sunday 09:00): `.venv\Scripts\python weekly_review.py` writes `out\weekly_<date>.md`.

## File layout

```
tools/india_edge/
  config.yaml            Layer 1 weights (never edited by tools)
  config_exec.yaml       Layer 2/3 + paper settings
  data/                  fetch.py + downloaded parquet (git-ignored)
  tests/fixtures/        deterministic synthetic market, 60 symbols, 2015-2026
  out/                   top5_*.json/.md, paper.sqlite, paper_trades.csv, alerts_*.txt, weekly_*.md
  web/                   index.html + morning_desk.json  (deploy this folder)
  backtest/              harness and reports (backtest/out)
```

## Publish the desk (Netlify)

Drag the `tools\india_edge\web` folder onto app.netlify.com/drop, or run `netlify deploy --dir tools\india_edge\web --prod`. Re-deploy after each nightly run. The page only needs `index.html` and `morning_desk.json`. Opening `index.html` from disk will not load the JSON (browser rule); use the hosted copy or `python -m http.server` inside `web`.

## Try it without any data (synthetic fixtures)

```powershell
.venv\Scripts\python run_daily.py --replay 40      # paper-trades the last 40 synthetic sessions
.venv\Scripts\python weekly_review.py
.venv\Scripts\python audit_lookahead.py
.venv\Scripts\python -m unittest discover -s tests
```

The synthetic market is random with regimes and event gaps; it has no edge by design, so its paper P&L is not a result.

## Rules the paper bot follows

Entry at the next 15-minute bar's open after a trigger; stop beyond the OB/FVG zone; target 2R; risk 1% of capital (setting is clamped to 1-2%); at most 2 positions; no new entries after 2 stop-losses in a day or a daily loss of 3% of capital; every position squared off at the 15:15 bar's close. Same-bar stop and target counts as stop.

## Known limits

- The bhavcopy file formats are NSE's; if NSE changes a URL or column, `fetch.py` reports that day and continues.
- Pre-July-2024 F&O files use the older format (handled); cash files with delivery % for early years were not verified from the build environment.
- Strike suggestions use an approximate interval table. Check the live option chain.
- Prices are not adjusted for splits or bonuses.
- Nothing here has been run on real NSE data yet (the build sandbox cannot reach NSE).
