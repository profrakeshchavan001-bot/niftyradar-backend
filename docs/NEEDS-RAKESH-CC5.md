# Items for Rakesh (CC5)

- `tools/india_edge/scores` and its fixture data did not exist in the repo, so CC5 created synthetic fixtures (`scores/make_fixtures.py`, seeded, not real prices). Layer 1 behaviour is untouched; the new engine is separate. Confirm this is the intended location.
- `web/index.html` did not exist; created it (served at `/desk/`). `server.js` got two lines (API router + static). Confirm you want it served from the same service.
- Real-data run (bhavcopy + yfinance + NSE shareholding) is NOT done here; `build_public.py` refuses without `--fixtures`. For CC8: write cash/idx CSVs (columns as in `make_fixtures.py`) from `data/cash`, `data/idx`, then point `build_public.py` at them. yfinance only for India VIX / index history if needed.
- NSE shareholding is not used by any score yet (unclear which field/format you want); left out on purpose.
- `baserates.json` in fixtures is invented to demo both "edge" and "no edge found". The real file must come from your backtest; the page shows "No edge found" automatically when nothing survives.
- Score weights/bands live in `scores/config.yaml` (server-side only, never in `out/public`). Weights are first-guess values, not tuned.
- Lookahead audit: tests truncate and shock future data and assert scores, fear/greed and rotation for day t are unchanged. Not yet audited on real data (survivorship, corporate-action adjusted prices).
- Root `.gitignore` added (node_modules, out/public). Commits carry `[skip ci]` until 1 Nov.
