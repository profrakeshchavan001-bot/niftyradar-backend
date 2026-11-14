# Daily scores run on your Windows PC

Research and analytics only. The runner never places orders and never needs a login or a key (Telegram is optional).

## One-time setup (PowerShell, from the repo folder)

```powershell
cd tools\india_edge
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\pip install -r scores\requirements-fundamentals.txt   # only if you will run the fundamentals step
```

First data load (one time, the first run takes a while; NSE is polite-throttled to 1 file per second):

```powershell
.venv\Scripts\python data\fetch.py --from 2015-01-01 --to 2026-10-28
```

Dry run (nothing is downloaded or written, prints the plan):

```powershell
scores\run_daily.ps1 -DryRun
```

## Run it by hand

```powershell
scores\run_daily.ps1            # normal: download missing days, score, write JSON + site
scores\run_daily.ps1 -Force     # recompute even if nothing changed
scores\run_daily.ps1 -NoFetch   # use stored data only
scores\run_daily.ps1 -AsOf 2026-10-23
```

Or directly: `.venv\Scripts\python -m scores.daily --force`.

## Task Scheduler (21:00, Monday to Friday)

Easiest (elevated PowerShell): `scores\install_task.ps1`. Or by hand:

1. Task Scheduler > **Create Task** (not Basic Task), name `NiftyRadar Scores Daily`.
2. **Triggers** > New > Weekly, Mon-Fri, 21:00 (the PC clock must be IST; NSE publishes bhavcopy by about 19:00).
3. **Actions** > New > Start a program:
   - Program: `powershell.exe`
   - Arguments: `-NoProfile -ExecutionPolicy Bypass -File "C:\path\to\niftyradar-backend\tools\india_edge\scores\run_daily.ps1"`
4. **Settings**: tick "Run task as soon as possible after a scheduled start is missed", "Stop the task if it runs longer than 2 hours", and "Do not start a new instance" for "If the task is already running".

## Optional failure alert (Telegram)

Create a bot with BotFather, then set two user environment variables (never put them in the repo):

```powershell
[Environment]::SetEnvironmentVariable("TELEGRAM_BOT_TOKEN","<token from BotFather>","User")
[Environment]::SetEnvironmentVariable("TELEGRAM_CHAT_ID","<your chat id>","User")
```

Restart the task or PowerShell afterwards. A failed run sends one short message (no token, no data). Successful runs send nothing.

## What it writes (`tools\india_edge\scores\out\`)

| Path | What |
|---|---|
| `*.json` (overview, scores, screeners, rotation, feargreed, health) | the latest day, what the pages read |
| `history\YYYY-MM-DD\` | the same files per day plus `manifest.json`; the newest 30 days are kept |
| `site\` | static copy of the page and its data: upload this folder to any static host, or open `site\index.html` through a local server |
| `status.json` | result of the last run: `ok`, `up_to_date` or `failed`, date, seconds, error |
| `logs\daily_YYYY-MM-DD.log` | one log per day (kept 60 days); `scheduler_console.log` is the raw console |

Preview locally: `python scores\serve.py` then open http://127.0.0.1:8765/web/ (only `/web` and `/out/*.json` are served).

## Safe re-runs and overlapping runs

- Same day, same data, same code: the second run says "up to date" and changes nothing. A new bhavcopy file, a changed `config.yaml`/code, or `-Force` recomputes that day.
- A lockfile (`out\.daily.lock`) stops two runs overlapping (exit code 3, no alert). A lock older than 3 hours is treated as a crash and taken over.
- If the download fails but stored data exist, the run continues with a warning. If the newest bar is more than 5 days old, or data health is BAD, the run fails and publishes nothing.

## Exit codes

`0` ok or already up to date, `1` failed, `3` another run is active.

## Health check by hand

```powershell
type scores\out\status.json
type scores\out\health.json
```

Open `#health` in the page for the same information (stock status counts, price jumps, missing VIX or put/call, universe check).
