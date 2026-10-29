@echo off
REM Task Scheduler entry point. Edit nothing here; see docs/INDIA-EDGE-RUNBOOK.md
cd /d "%~dp0"
if not exist logs mkdir logs
call .venv\Scripts\activate.bat
python nightly.py >> logs\nightly.log 2>&1
