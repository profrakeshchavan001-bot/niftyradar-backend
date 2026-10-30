# scores (CC5): scores engine, screeners, sector rotation, fear/greed

Data and analytics only: statistics on historical data, not advice. Run from `tools/india_edge`.

```
python -m scores.run                      # fixtures (DATA_DIR unset) -> scores/out/*.json
DATA_DIR=/path/to/data python -m scores.run --validate --fundamentals fundamentals.csv   # real bhavcopy (CC8)
python scores/serve.py                    # preview http://127.0.0.1:8765/web/  (serves /web and /out/*.json only)
python -m unittest discover -s scores/tests -p "test_*.py"
```

## Interface for CC8
- Input: `loader.load_market()` (cash, fo, idx day files under `DATA_DIR`). Index file should include `Nifty 50`; `India VIX` is used if present; stock-option rows with `opt_type` CE/PE give the put/call ratio.
- Optional `fundamentals.csv`: `symbol, roe, debt_equity, profit_margin, pe, pb, promoter_pct, promoter_pledge_pct` (percent values; snapshot only).
- Output (`scores/out/`, git-ignored): `overview, scores, screeners, rotation, feargreed, health` (+ `validation, sensitivity` with `--validate`). Schema version 1; strict JSON.
- Stock status: `ok`, `new_listing` (< 60 bars), `suspended` (no print today), `illiquid` (3+ zero-volume days in 5), `not_listed`. Only `ok` stocks are scored.

## What is public vs server side
Public JSON: scores 0-100, band (Strong/Mixed/Weak), a plain sentence, and per component the plain reading plus a 0-100 sub-score. Never: weights, thresholds, formulas (`engine.py`, `config.yaml`). Tests enforce this.

## Files
`data.py` panels, `engine.py` scores, `screeners.py` (8, each row has a one-line reason), `rotation.py`, `feargreed.py`, `health.py`, `build.py` (JSON), `validate.py` (rank link by year/regime with doubled costs, controls), `sensitivity.py`, `run.py`, `serve.py`, `web/index.html`.
