@echo off
rem CC8 paper-forward logger (PAPER ONLY, no orders). Logs ONLY the variants in backtest\survivors.json.
rem Runs once per day after the bhavcopy is out (~19:45 IST). Writes out\cc8_paper_ledger.csv and
rem out\cc8_daily_summary_latest.txt. Register (once) with the command at the top of
rem docs\BACKTEST-YT-REAL-DATA-31OCT.md; do not register twice.
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist out mkdir out
echo === %date% %time% >> logs\paper_forward.log
python paper_forward.py >> logs\paper_forward.log 2>&1
exit /b %errorlevel%
