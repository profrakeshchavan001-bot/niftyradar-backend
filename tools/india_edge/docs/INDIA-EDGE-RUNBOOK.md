# India Edge runbook (Windows)

All commands run from `tools\india_edge` with the venv: `.venv\Scripts\python.exe`.

## Daily pipeline (automatic)

Windows task **NiftyRadar daily pipeline**: weekdays (Mon–Fri) at 19:30 IST. It runs
`daily_pipeline.bat`, which does three steps:

1. `python data\fetch.py --days 10`: incremental download of the last 10 days. Stored days are skipped.
2. `python run_scanner.py --no-fetch`: writes `out\latest.json` and `out\top5_<date>.json/.md`.
3. `python morning_desk.py`: writes `out\morning_desk.json`, the top 5 with grade, stop and target.

The log is appended to `logs\pipeline.log`. The task was registered with this exact command:

```
schtasks /Create /TN "NiftyRadar daily pipeline" /TR "\"C:\Users\user\Desktop\niftyradar-backend\tools\india_edge\daily_pipeline.bat\"" /SC WEEKLY /D MON,TUE,WED,THU,FRI /ST 19:30 /F
```

To check it: `schtasks /Query /TN "NiftyRadar daily pipeline" /V /FO LIST`. To run it now: `schtasks /Run /TN "NiftyRadar daily pipeline"`.
To remove it: `schtasks /Delete /TN "NiftyRadar daily pipeline" /F`.

NSE usually publishes the day's files by 18:00–19:00. A file that isn't up yet is retried
on the next run. It is only marked as a holiday once it is more than 4 days old.

## Manual jobs

| Job | Command |
|---|---|
| Full history download | `python data\fetch.py --from 2015-01-01 --to today` |
| Verify data + retry gaps, write `data\manifest.json` | `python data\verify.py` |
| Lookahead audit (exits 1 on a leak) | `python backtest\audit.py` |
| Train/test + calibration → `backtest\results\<stamp>\` | `python backtest\calibrate.py` |
| Original backtest report → `backtest\out\` | `python backtest\run.py --train --test` |
| Unit tests | `python -m unittest discover -s tests` |

## Data notes

- Cash data before 30 Sep 2019 comes from the legacy `cm…bhav.csv.zip` file plus the `MTO_….DAT` delivery file. From that date on it comes from `sec_bhavdata_full`.
- F&O data before 8 Jul 2024 comes from the legacy `fo…bhav.csv.zip` file. From that date on it comes from UDiFF.
- NSE also publishes a cash file on holidays, as a copy of the previous session. Fetch stores a cash day only when an F&O or index file exists for that day too. Five such files picked up earlier were moved to `data\quarantine\cash\`. They were not deleted.
- The `nsearchives` server leaves out an intermediate certificate. Fetch uses the Windows certificate store through `truststore`, so certificate verification stays on.
