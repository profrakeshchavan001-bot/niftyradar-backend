# CC5 overnight log (scores engine, screeners, sector rotation, fear/greed)

Lane: `tools/india_edge/scores` only. Branch `claude/cc5-overnight`, stacked on the head of PR #4 (PRs #2, #3, #4 not merged). Fixtures only; the real-data run is CC8's.
Statistics on historical data, not advice.

## Decisions
1. **Branch base**: PR #4 head (`claude/india-edge-cause-options`), as instructed. PR #7 (my earlier main-based version) is superseded; its page and Node route were dropped to stay in lane.
2. **Nothing outside the lane**: no `server.js` change. The page is static HTML under `scores/web/` and reads `scores/out/*.json`; `scores/serve.py` serves only `/web/*` and `/out/*.json` (python files and `config.yaml` return 404, tested by hand).
3. **Input = the existing loader** (`loader.load_market()`, so `DATA_DIR` switches fixtures to real bhavcopy, with the existing sanitising/split adjustment). No new data code, no network calls here.
4. **Seven scores**: trend, momentum, relative strength, volume/delivery, volatility (shown as "Stability": higher = calmer), quality, valuation. Quality/valuation need an optional `fundamentals.csv`; without it they are not produced (never filled with fake numbers) and the overall renormalises over the scores that exist, with a coverage count.
5. **Components in public JSON** show the plain reading ("+3.1% from its 50-day average") and a 0-100 sub-score; weights, thresholds and formulas stay in `engine.py`/`config.yaml`. A test fails if words like weight/formula/rolling appear in public JSON.
6. **Screener 5 "weak/avoid list"** is published as "Weakest scores". "Avoid" is advice-like and the public view must not tip. A test bans buy/sell/avoid/target/profit/recommend in all public JSON.
7. **All thresholds are untuned first-guess defaults chosen up front**; nothing is fitted. So there is no train-fit step; train (2015-2022) and test (2023-now) are reported side by side by `validate.py` and the test years are never used to choose anything.
8. **Fear/greed** places each reading against its own trailing 252 days (percentile), so there are no hand-set thresholds and no future data. Uses India VIX if present in the index files, else labelled Nifty realised volatility; put/call OI ratio from stock-option rows (CE/PE) if present.
9. **Rotation** uses an equal-weight sector index vs Nifty 50: strength = RS vs its own 60-day average, change over 10 days; sectors with fewer than 3 scored stocks are not shown.
10. **Validation rules**: signal on close of t, entry close of t+1, exit 10 sessions later, non-overlapping dates, costs doubled (0.20% per side, 0.40% round trip on the top-quintile leg), by-year and regime split. A leak control (a score built from the label itself must give rank link 1.0) and a random-walk control (must give about 0) are unit tests.
11. **"Margin needed" (extra queue)**: not applicable; scores involve no positions. Skipped on purpose, not padded.
12. **Elapsed time**: the work was far faster than the 420-minute sizing. Real elapsed time is stated in the final answer; no padding.

## Findings (fixtures, so noise or planted effects, NOT evidence)
- Fixture data has planted per-stock trend regimes (+0.20%/-0.18% a day), so the scores show a positive rank link there (test mean 0.11). That is the generator, not an edge. On an i.i.d. random-walk world the same harness gives mean about 0 (t between -1.4 and 0.9) and negative after costs.
- Weight sensitivity: nudging any single weight by +-25% keeps the ranking at rank correlation >= 0.998 (top-10 overlap >= 0.98) on fixtures.
- Lookahead audit (`tests/test_leak.py`): scores, status, screeners, rotation and fear/greed for day t are identical when all later data is deleted, and identical when later data is wrecked (x9 prices, x0.1 index).
- Screener thresholds are knife-edged: scaling one threshold by +-20% moved e.g. "Relative-strength leaders" from 9 stocks to 22 (-20%) or 1 (+20%) and "Delivery rising" from 0 to 10. Counts are shown as data, so the page lists the rule next to each screener; do not read a short list as a signal. Thresholds now live in `config.yaml` (`screeners:`); `--validate` writes the full table to `sensitivity.json`.
- Bug found and fixed by the browser check: the stock page crashed for new listings (chained `append`). Regression test added (`tests/test_web.py`), plus a test that `serve.py` refuses `.py`/`config.yaml`.
- Speed: 200 stocks x 3000 days full build about 5 s (was 9 s before vectorising rotation).

## Needs Rakesh
- **Real-data run (CC8)**: `DATA_DIR=<folder with cash/ fo/ idx/ day files> python -m scores.run --validate` from `tools/india_edge`. Check the Data health page first. Needs: NSE reachable from CC8 (blocked in this sandbox).
- **India VIX / sector indices**: `data/fetch.py` keeps every row of `ind_close_all`, so "India VIX" should arrive on its own if the index name matches exactly; verify on the first real run.
- **Fundamentals + NSE shareholding**: no free bulk file is wired. Provide `fundamentals.csv` (columns in `scores/README.md`), built from yfinance and NSE shareholding on CC8. It is a snapshot (not point-in-time), so it is used for today's score only and excluded from validation. Not done here: yfinance/NSE are not reachable and no fake data was made.
- **Survivorship**: the universe is the current top-60 F&O list; real-data validation will be flattered by that. Needs a historical F&O membership list to fix.
- **Wiring**: nothing is mounted in `server.js` (other windows own it). To publish, serve `scores/web/` and `scores/out/*.json` from any static host.


---

# Round 2 (fundamentals, point-in-time universe, realistic validation, robust screeners, daily runner, pages, handover)

## Decisions (round 2)
13. **Fundamentals transport**: yfinance is imported lazily (not needed for tests, dry runs or anything else) and listed in `scores/requirements-fundamentals.txt`; NSE shareholding/pledge use `requests` against the public JSON endpoints with cookie warm-up. Field names for NSE are my best knowledge and tolerant (several candidates, latest filing wins); `--probe` prints the real ones for you to confirm. No network is touched by tests.
14. **fundamentals.csv schema** is exactly the 8 columns the engine reads (`symbol,roe,debt_equity,profit_margin,pe,pb,promoter_pct,promoter_pledge_pct`); run metadata goes to a sidecar `.meta.json` so the CSV is byte-identical for identical inputs. A symbol with no data at all gets no row (never a row of fake values). Yahoo percent conventions are converted (ROE/margin fraction x100, debtToEquity /100).
15. **Universe**: membership = stock-futures rows with open interest or volume on the day; missing F&O file days carry the last membership for at most 3 days. Only stocks that were ever members are loaded; a stock is scored only on days it was a member (`not_in_universe` otherwise). Suspect renames are reported, never auto-applied. Validation exits a stock that stopped trading at its last traded price (not dropped).
16. **Lot sizes**: `data/fetch.py` does not keep lot size (outside my lane, not touched), so lot-size changes cannot be derived; `lot_changes()` works if a `lot` column ever exists. Capacity uses traded value only.
17. **Screeners**: absolute score cut-offs replaced by cross-sectional percentile thresholds with hysteresis (enter at top 15%, stay until top 25%). All numbers are untuned and fixed up front; no tuning happened, so "tune on train only" has nothing to tune. Hysteresis state depends on history before the day only (tested with cut-the-future).
18. **Costs**: equity delivery rates from config (`costs:`), my recollection of current NSE/SEBI/STT/stamp/GST/DP charges; all doubled; slippage = 5% of ATR per side. Rates change: verify. Equity delivery was chosen (10-day holds); futures/options costs differ and are not modelled.
19. **Portfolio sim**: 10 equal slots, rebalance every 10 sessions, one-day execution delay, kept positions cost nothing, unfilled slots stay cash, capacity 5% of 20-day average traded value, whole shares. Excess is measured against the Nifty 50 (headline) and against the equal-weight universe (shown).
20. **Multiple testing**: Holm and Benjamini-Hochberg across 9 rules on the test period; plus 100 random-selection portfolios to show what luck looks like. The verdict line says "No edge found" unless a rule survives Holm.
21. **Daily runner**: output folder layout, 30 history days, 60 log days, lock stale after 3 h, fails (and publishes nothing) if data health is BAD or the newest bar is over 5 days old; download failure alone is only a warning. Telegram only on failure, only via environment variables.
22. **Pages**: one static page, hash routes, dark/light (follows the system, toggle stored in localStorage inside try/catch), sortable tables, no data in innerHTML. "Weakest scores" wording kept, no tips anywhere (tested).

## Findings (round 2, fixtures: planted trends, so NOT evidence)
- Percentile screeners with hysteresis: moving every threshold by +-20% changes list size by about +-20% and flips under 7% of stock-days (absolute thresholds before: 9 to 22 or 1 stocks). Hysteresis cuts membership changes by more than 10% against a single threshold.
- On fixtures several rules "pass" even after Holm correction because the generator plants persistent trends. The random-walk control passes none, and a deliberately leaked score gets CAGR above 100% with p near zero, so the harness can detect both.
- Round-2 run times (200 stocks x 3000 days, synthetic): scores+screeners+rotation+fear/greed about 6 s; full validation report about 30 s; sensitivity and heatmaps about 40 s (can be trimmed).

## Needs Rakesh (round 2)
- Run `docs/RUN-ON-PC.md` on a PC with NSE access. Step 3 needs `pip install yfinance` and a check of NSE field names with `--probe` (I could not test live endpoints).
- Confirm the cost rates in `config.yaml` (`costs:`) match your broker and the current NSE/SEBI schedule.
- A historical F&O lot-size source if you want lot-size-aware capacity (needs a change in `data/fetch.py`, which I did not touch).
- Merger terms are not modelled (exit at last traded price). If you care about specific mergers (e.g. HDFC into HDFCBANK) add them to `symbol_renames.json` only where the share-swap makes the old price series continuous.
- Telegram bot token and chat id for failure alerts, set as user environment variables on the PC (never in the repo).
