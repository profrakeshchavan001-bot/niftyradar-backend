@echo off
rem CC8 paper-forward logger (PAPER ONLY, no orders). Runs after the bhavcopy is out (~19:45 IST), once per day.
rem Register (run once in an elevated or normal cmd/PowerShell; replaces an existing task of the same name):
rem   schtasks /Create /F /SC DAILY /ST 19:45 /TN "NiftyRadar-CC8-PaperForward" /TR "\"C:\Users\user\Desktop\niftyradar-backend\tools\india_edge\run_paper_forward.bat\""
cd /d "%~dp0"
if not exist logs mkdir logs
if not exist out mkdir out
echo === %date% %time% >> logs\paper_forward.log
python paper_forward.py >> logs\paper_forward.log 2>&1
python paper_forward.py --symbol BANKNIFTY >> logs\paper_forward.log 2>&1
exit /b %errorlevel%
