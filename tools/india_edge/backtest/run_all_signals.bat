@echo off
rem CC4: run every signal group in turn (one at a time: the groups are memory hungry).
if "%DATA_DIR%"=="" set DATA_DIR=C:\Users\user\Desktop\niftyradar-backend\tools\india_edge\data
cd /d "%~dp0\.."
for %%g in (layer1 early chain scores) do (
  python -I -X faulthandler backtest/run_signal_backtest.py --groups %%g --out backtest/results/sig_%%g.json > "%TEMP%\%%g.out" 2> "%TEMP%\%%g.err"
)
python -I backtest/make_signal_doc.py
