# RUN-ON-PC: the real-data run for the scores engine (for CC8 / the owner)

Everything here is research and analytics. Nothing places orders, nothing needs a broker login. NSE is not reachable from the cloud sandbox, so this is the sequence to run on a PC with internet. All commands are PowerShell, run from `tools\india_edge` unless stated. Replace `2026-10-28` with the last trading day.

Timings are estimates from fixtures and file counts, not measurements on your PC; the download dominates.

## 0. One-time setup (about 5 min)

```powershell
cd tools\india_edge
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -r scores\requirements-fundamentals.txt     # yfinance, only for step 3
$env:DATA_DIR = (Resolve-Path .\data).Path                            # the folder step 1 fills; every later step reads it
```

If `DATA_DIR` is not set, the scores code falls back to the SYNTHETIC fixtures. The page then shows "SAMPLE DATA". Always check the first line printed by step 4 says `real`.

## 1. Download bhavcopy (about 4 to 8 hours the first time; resumable)

```powershell
.venv\Scripts\python data\fetch.py --from 2015-01-01 --to 2026-10-28
```

About 2,800 trading days x 3 files (cash with delivery, F&O, index closes), 1 second polite delay per file. Safe to stop (Ctrl+C) and re-run: finished days are skipped and holidays are remembered. Check:

```powershell
(Get-ChildItem data\cash).Count; (Get-ChildItem data\fo).Count; (Get-ChildItem data\idx).Count   # similar counts, about 2,700-2,800
```

Pre-July-2024 F&O files use the old format; `fetch.py` handles both. `India VIX` and sector indices arrive inside the `idx` files and are picked up automatically. A few days failing is normal (printed as `FAIL`); re-run to retry.

## 2. Check the point-in-time universe (under 1 min)

```powershell
.venv\Scripts\python -m scores.universe
```

Look at: `members_first_day` and `members_last_day` (a few hundred stocks are in F&O in recent years; fewer in 2015), `by_year` entries/exits (a handful per year), and `suspect_renames`. For each real rename found, add `"OLDSYMBOL": "NEWSYMBOL"` to `symbol_renames.json` and re-run. `lot_size_column` will say `false`: lot sizes are not in the parsed columns, so capacity is measured by traded value only.

## 3. Fundamentals (about 15 to 25 min for ~200 stocks, first run only; cached after)

```powershell
.venv\Scripts\python -m scores.fundamentals --probe TCS                    # prints the raw field names NSE/Yahoo return; writes nothing
.venv\Scripts\python -m scores.fundamentals --from-data --dry-run          # plan: how many requests, how long
.venv\Scripts\python -m scores.fundamentals --from-data --out fundamentals.csv
.venv\Scripts\python -m scores.fundamentals --validate fundamentals.csv    # schema check: prints OK or the problems
```

If `--probe` shows different NSE field names from the ones listed at the top of `scores\fundamentals.py` (`HOLDING_KEYS`, `PLEDGE_KEYS`), add the real names there (one line) and re-run. Re-runs only fetch what is older than 7 days (Yahoo) or 30 days (NSE); failures are listed in `fundamentals.meta.json` and retried next run. The file is a snapshot (not point-in-time), so it affects today's quality and valuation scores only, never the validation.

## 4. Scores, screeners, rotation, fear/greed, validation (about 2 min)

```powershell
.venv\Scripts\python -m scores.run --validate --report --fundamentals fundamentals.csv
```

Add `--asof 2026-10-23` to score an earlier day. Leave out `--validate --report` for the quick daily version (about 10 seconds).

## 5. Look at the results

```powershell
.venv\Scripts\python scores\serve.py        # then open http://127.0.0.1:8765/web/   (serves only /web and /out/*.json)
type scores\out\report.md
```

First-run checklist:

1. The page header must NOT say "SAMPLE DATA" on "Does it work?", and `scores\out\report.json` must have `"source": "real"`.
2. "Data health" should be GOOD or WARN. BAD means fix the data first. Note which of "India VIX loaded" and "Put/call data" say `no`.
3. "Stocks" should list a few hundred names; `new_listing`, `suspended`, `illiquid` counts should be small.
4. In `report.md`, read the verdict first. The expected honest outcomes are "No edge found" or a short list of leads; either is a valid result. Do not act on a lead until it survives a second, later period.

## What each output file means (`scores\out\`)

| File | What it is |
|---|---|
| `overview.json` | top 8 and bottom 5 overall scores, how many stocks were scored, data-health grade |
| `scores.json` | every stock: 7 scores (0-100), band, plain sentence, and the plain readings behind each score |
| `history.json` | last 120 sessions of each score per stock (sparklines) |
| `screeners.json` | 8 rule lists, each row with a one-line reason; thresholds are percentiles with hysteresis |
| `rotation.json` | sector strength against the Nifty 50, its 10-day change, stage (Leading/Weakening/Improving/Lagging), 8-day tails |
| `feargreed.json` | 0-100 market mood, its parts, last 250 days |
| `health.json` | data checks and notes (missing VIX, put/call, price jumps, universe) |
| `validation.json` | rank link between score and next-10-day return, by year and regime, costs doubled |
| `report.json` / `report.md` | paper-portfolio test of each screener: costs doubled, CAGR vs Nifty, Sharpe, max drawdown, bootstrap CI, p-values, multiple-testing correction, random-selection comparison, Monte Carlo drawdown, capacity |
| `sensitivity.json` | how much rankings move if score weights move 25%, and how much screener list sizes move if thresholds move 20% |
| `heatmap.json` | list size and turnover across entry/exit bands for one screener (descriptive) |
| `history\YYYY-MM-DD\` | per-day copies kept by the daily runner (newest 30) |
| `site\` | static page plus data, uploadable to any static host |

## Daily after that

See `docs/RUN-DAILY.md` (Task Scheduler, lockfile, Telegram alert on failure).

## Troubleshooting

- "Not enough history" on the fear/greed gauge: the meter needs about 120 days of data.
- Everything says `new_listing`: fewer than 60 daily bars were found; check step 1.
- `DATA_DIR ... has no readable cash day files`: wrong folder, or step 1 not finished.
- A stock's score looks odd after a split/bonus: `robust.py` adjusts big one-day jumps; check "Price jumps over 40%" on the health page.
- Tests: `python -m unittest discover -s scores\tests -p "test_*.py"` (about 4 minutes, all offline).
