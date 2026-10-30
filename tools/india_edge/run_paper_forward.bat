@echo off
rem CC8 paper-forward logger (no orders). Schedule daily ~19:45 IST, e.g.:
rem   schtasks /Create /SC DAILY /ST 19:45 /TN "NiftyRadar-CC8-PaperForward" /TR "%~f0"
cd /d "%~dp0"
python paper_forward.py >> logs\paper_forward.log 2>&1
