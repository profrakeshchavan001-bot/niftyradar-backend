@echo off
rem NiftyRadar daily pipeline: incremental bhavcopy download -> Layer 1 scanner -> morning_desk.json
rem Windows task "NiftyRadar daily pipeline", weekdays 19:30 IST. Log: logs\pipeline.log
cd /d "%~dp0"
set PY=%~dp0.venv\Scripts\python.exe
if not exist "%PY%" set PY=python
if not exist logs mkdir logs
set LOG=logs\pipeline.log
echo ==== %date% %time% start >> %LOG%
rem a failed download is logged but does not stop the scan of stored data
"%PY%" data\fetch.py --days 10 >> %LOG% 2>&1
"%PY%" run_scanner.py --no-fetch >> %LOG% 2>&1 || goto :fail
set DATA_DIR=%~dp0data
"%PY%" run_daily.py >> %LOG% 2>&1 || goto :fail
echo ==== %date% %time% ok >> %LOG%
exit /b 0
:fail
echo ==== %date% %time% FAILED >> %LOG%
exit /b 1
