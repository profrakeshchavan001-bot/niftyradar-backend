# CC4 overnight (src/paper/ops/, src/paper/context/)

## What shipped tonight
- `GET /api/paper/health` (+ `&format=json`): one ALIVE/PROBLEM line, per-job (nseScan/nseMonitor/cryptoScan/cryptoMonitor)
  last-scan time and staleness (>15 min = stale), database reachability, open trades, today's trades/skips, uptime,
  memory, and the last 10 job errors. `src/paper/ops/health.js`, tests in `test/opsHealth.test.js`.
- Wiring: one `require` line and 4 `healthTracker.wrap(...)` calls in `paperbot/index.js` around the existing
  scan/monitor jobs, plus one `attachHealthRoute(...)` call. No other file touched. Rebased cleanly onto the
  plugin-loader commit (`ed2a635`) that landed on `main` mid-session.
- `src/paper/context/sector.js` was already on `main` with `test/sectorContext.test.js` green — item 1 of the
  brief needed no work.

## What did NOT ship (honest log, not silently dropped)
- **Data-source status (Binance/Yahoo/Dhan)** in the health page is reported as `"unchecked"`, not a guess.
  Real per-source status needs a hook inside `paperbot/sources.js` / `paperbot/yahoo.js` / the Dhan client in
  `server.js` - all outside `src/paper/ops/` and `src/paper/context/`, so left for a follow-up PR to avoid
  colliding with whoever owns those files tonight.
- **news-check page, summary extension, morning brief, cookie login, home page, alerts** (brief items 3-7) were
  not attempted this pass. `src/paper/context/news.js` already has retry-via-stale-cache and per-source
  ok/failed reporting built in; a `/api/paper/news-check` route reusing it is the natural next step.
- Sandbox has no outbound network to NSE/Binance/news sites, so nothing above was ever going to be "verified
  live" here regardless of scope - fixture-only testing throughout.

## Rule followed
Stayed inside `src/paper/ops/` (new folder) and `src/paper/context/` (read-only this pass). One necessary
wiring line in `paperbot/index.js`, noted here. No order code, no `DATABASE_URL`, no secrets printed.
