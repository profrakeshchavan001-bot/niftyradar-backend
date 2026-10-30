# India Edge runbook (Windows PC, nightly)

Everything lives in `tools/india_edge/` and is plain Python (pandas, numpy, requests, pyarrow, pyyaml). It reads free NSE end-of-day files. Nothing here places real orders: the "bot" is a paper ledger. Output is statistics and paper results, not investment advice.

## What runs

| Layer | File | What it does |
|---|---|---|
| Data | `data/fetch.py` | Downloads cash bhavcopy (with delivery %), F&O bhavcopy and index closes into `data/{cash,fo,idx}/YYYY-MM-DD.parquet`. Incremental. |
| 1 | `run_scanner.py`, `layer1.py` | Scores the top F&O stocks (OI quadrant, delivery spike, RS, sector RS, unusual OI). Writes `out/top5_<date>.json/.md`. |
| 2 | `timing.py`, `session.py` | 15-minute OB/FVG pullback, BOS or engulfing trigger, ORB/VWAP side, trade windows 09:30-11:00 and 13:30-15:00 IST. |
| 3 | `vetoes.py` | Chop regime, IV percentile above 70, event within 2 days, expiry day, target beyond expected move, option spread above 2% of premium. |
| G: cause | `cause.py` | "Why is it moving": cause label (short covering, long buildup, fresh shorts, long unwinding, delivery spike, volume spike without a calendar event, gap-and-fade) + confidence + one-line reason + sector-driven vs stock-specific, plus a per-stock behaviour profile (gap fill rate, post-spike drift, expiry-week behaviour). |
| H: early detection | `early.py` | Quiet accumulation, OI build-up without price move, NR7 / Bollinger squeeze, RS divergence, volume dry-up. Stage model accumulation -> trigger -> confirmation, mapped to Watch -> Ready -> Go through the existing alert function. |
| D: options | `options_plan.py` | ATM or 1-ITM strike (1-ITM when IV percentile >= 50), expiry 10-15 days out (else nearest >= 10), premium from the bhavcopy or Black-Scholes, SL/target on the premium, premium-based size at 1-2% risk, max 2 positions. Pure functions. |
| Robustness | `robust.py`, `loader.py` | Tolerant day-file reader, row cleaning, duplicates, partial days, stale symbols, symbol renames, split/bonus back-adjustment, and the `data_health` block. |
| Telegram text | `telegram_fmt.py` | Compact messages, at most 6 lines. Sending is still `alerts.send_telegram` behind `TELEGRAM_ENABLED=true`. |
| Glue | `enrich.py` | Calls G, H and D for one pick; each block fails independently ("error" field) and never breaks the desk. |
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
| `DATA_DIR\events.csv` (`date,symbol,kind`; symbol `ALL` = market-wide) | Event veto, and "volume spike without news" | Event veto shows "no event in window"; the volume-spike cause is reported 0.1 weaker. |
| `DATA_DIR\lots.json` or `tools\india_edge\lots.json` (`{"TCS": 175, ...}`) | Lots in the option plan | The plan sizes in units and says "lot size unknown". |
| `tools\india_edge\symbol_renames.json` (`{"OLD": "NEW"}`, ships with four known renames) | History continuity | Renamed symbols restart their history. |

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

## Cause, early detection and option plan (desk schema 2)

Each pick card in `morning_desk.json` has new optional fields. Old pages and old files still work because the page checks each one before using it.

| Field | Content |
|---|---|
| `data_health` (top of the file) | `status` ok / degraded / bad, `missing` (inputs missing for the signal day), `warnings` (partial days, stale symbols, adjustments applied, unreadable files), `inputs`, `repairs`. |
| `cause` | `label`, `confidence` (0-1), `level`, `driver` (sector / stock / mixed), `tags`, `reason` (one line). |
| `profile` | `gap_fill`, `post_spike`, `expiry_week`, `summary`. Built from data up to the signal day only. |
| `early` | `stage` (none / accumulation / trigger / confirmation), `side`, `flags`, `detail`, `levels`. Note: the card's existing `stage` is still the Watch/Ready/Go alert stage. |
| `option_plan` | `status` (ok / no_premium / no_expiry / size_zero / no_levels), `type`, `strike`, `moneyness`, `expiry`, `premium` and its source, `premium_stop`, `premium_target`, `lots`, `qty`, `risk_at_stop`, `iv_percentile` (null = unavailable), `notes`. |

Early-stage changes go through the same Watch/Ready/Go messages: accumulation = Watch, trigger = Ready, confirmation = Go. Missing IV or option quotes never veto; the plan says what was unavailable.

Settings: `cause:`, `early:`, `options:` and `robust:` sections in `config_exec.yaml`.

## Data health

The nightly desk starts with `data_health`. `bad` means the cash bhavcopy or the Nifty 50 close for the signal day is missing: the page still opens, shows no picks and lists what is missing. `degraded` means optional inputs are missing or something was repaired. Corrupt day files are skipped and listed under `warnings`; a missing folder is treated as missing data, not an error.

Split/bonus style events are detected when NSE's `prev_close` differs from yesterday's close by more than 10%; earlier rows are scaled so returns stay continuous. A big move with an unadjusted `prev_close` is only flagged (it may be a real crash).

## Telegram messages

`telegram_fmt.format_message` builds at most 6 lines (headline, entry/SL/target with R, why, option line, stage trail, disclaimer). `python run_daily.py --send` or `nightly.py --send` formats and dispatches them, and does nothing unless `TELEGRAM_ENABLED=true` and the token and chat id are set.

## Weekly review

`weekly_review.py` now also reports win rate and expectancy by cause label and by early-detection stage (this week and all time). Ledgers created before this change are migrated automatically and show "unknown" for old trades.

## Lookahead audit

`audit_lookahead.py` also covers cause, profile, early stage and the option plan: each is recomputed on data cut at a past day and must equal the full-data result.
