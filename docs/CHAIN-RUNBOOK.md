# Option-chain engine runbook

Statistics and screening only, not advice. Everything lives in `tools/india_edge/chain/`; run commands from `tools/`
with the same venv as Layer 1 (`pip install -r india_edge/requirements.txt`).

```powershell
cd tools
python -m india_edge.chain make-fixtures --out india_edge/data/chain_fixture   # 20 stocks + NIFTY/BANKNIFTY x 60 days
python -m india_edge.chain run --raw-dir india_edge/data/chain_fixture --date 2026-10-28
python -m india_edge.chain fetch --from 2026-09-01 --to 2026-10-28             # real NSE files, PC only
python -m india_edge.chain run --date 2026-10-28                               # reads india_edge/data/chain
python -m india_edge.chain backtest --from 2015-01-01 --out india_edge/out/chain_base_rates.json
python -m india_edge.chain live --symbol NIFTY                                 # live chain once (PC, 60-180 s refresh)
python -m unittest discover -s india_edge/chain/tests                          # 45 tests
```

Output: `tools/india_edge/out/chain_<date>.json` = `{date, market{overview, fii_pulse, mmi, ...}, records[]}`.
Each record: `symbol, support, resistance, reversal_s, reversal_r, flags[], market_score, fii_pulse` (+ `detail`).
Flags: SFT SFB STT STB, SR_SUPPORT_TOUCH, SR_RESISTANCE_TOUCH, SUPPORT_BREAK, RESISTANCE_BREAK, TRIPLE_SR_SUPPORT,
TRIPLE_SR_RESISTANCE, POWER_BULL, POWER_BEAR, OI2OI_LONG, OI2OI_SHORT, BIG_BULL, BIG_BEAR.
Assumptions are in `docs/DECISIONS-CC12.md`.

## CC8: run on real data

1. Not run on real NSE data yet (downloads blocked in the build box). Do this on a PC with internet.
2. Recent days: `python -m india_edge.chain fetch --from <start> --to <end>` (files land in `india_edge/data/chain/`:
   `fo_<yyyymmdd>.csv`, `participant_<ddmmyyyy>.csv`). If a download fails, open the URL in `adapters.py` in a browser and check the file layout.
3. History to 2015: save old `fo<DD><MMM><YYYY>bhav.csv` files as `fo_<yyyymmdd>.csv` in the same folder (legacy layout is parsed;
   it has no underlying price, so extend `runner.load_day` with `spots=` taken from the cash bhavcopy). Add `market_<yyyymmdd>.json`
   (`{"vix": x, "sectors": {name: pct}}`) from index closes; without it the sector signal stays 0.
4. Smoke check: `run --date <day>` then compare 2-3 symbols with Sensibull / NSE option chain (support and resistance strikes, PCR).
5. Base rates: `backtest --from 2015-01-01 --out india_edge/out/chain_base_rates.json`. Read `TRIPLE_SR_SUPPORT.hit_pct` (support bounce %),
   `held_pct` and `n`; ignore flags with n < 100. Report the numbers back with n.
6. If any rule disagrees with what you expect, change the single constant named in `docs/DECISIONS-CC12.md` and re-run the tests.
