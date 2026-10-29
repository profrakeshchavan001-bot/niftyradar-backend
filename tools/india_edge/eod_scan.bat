@echo off
rem NiftyRadar EOD: incremental bhavcopy fetch (last 10 days) + Layer 1 scanner.
rem Registered as Windows task "NiftyRadar EOD scanner", daily 22:30.
cd /d "%~dp0"
set PY=%~dp0.venv\Scripts\python.exe
if not exist "%PY%" set PY=python
echo ==== %date% %time% >> out\eod.log
"%PY%" -c "import pandas as p; print((p.Timestamp.today()-p.Timedelta(days=10)).strftime('%%Y-%%m-%%d'))" > out\.from.txt
set /p FROM=<out\.from.txt
"%PY%" data\fetch.py --from %FROM% >> out\eod.log 2>&1
"%PY%" run_scanner.py --no-fetch >> out\eod.log 2>&1
exit /b %errorlevel%
