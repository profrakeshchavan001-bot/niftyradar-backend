# CC8 overnight log

## Decisions
- New branch claude/cc8-real-data-backtest from origin/main; copied options_yt.py (modelled engine) + earlier docs from claude/cc8-pattern-hunt as the comparison baseline.
- Own downloader data/fetch_idxopt.py (index rows only) instead of changing shared fetch.py; downloads use curl (python TLS re-verification took 10+ s per request).
- Raw cache in data/idxopt_raw and data/nifty/raw (git-ignored); clean parquet data/idxopt_nifty.parquet and idxopt_banknifty.parquet.
- Expiry-day settle bug fixed by valuing expiring legs at intrinsic vs Nifty close.
- Verdict rule fixed before running: test > 0 and walk-forward > 0 and >= half of years positive, >= 20 trades each side.

## Needs Rakesh
- SPAN/broker margin figures (margins here are rough estimates).
- Task Scheduler registration for run_paper_forward.bat (not registered by me).
- 9 sessions (e.g. 2015-02-02, 2015-03-12/13) have no NSE index file; treated as data gaps.

## Not done
- Interpretation of sensitivity grids, BANKNIFTY runs, forward-harness test, extra tests for harness.
