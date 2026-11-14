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

---

## CC4 round 2 (news-check, cookie login, home page, alerts shipped earlier this round; this entry covers the rest)

### Item 1: CC2's 228/230 was a stale checkout, not a real failure
`npm test` on `origin/main` at `e4d3e26` (and every commit after, through this round's merges): **300-336/300-336
green, verified 3 repeated runs** before touching anything. `test/newsCheck.test.js` and `test/opsHome.test.js`
have no timing- or environment-sensitive code and no shared mutable state that could explain an intermittent
failure. Conclusion: CC2 ran against an older local checkout (before `#27`/`#28` merged, or before `node_modules`
was installed fresh) - no code fix was needed or made.

### Item 3: real per-source status, replacing "unchecked"
- `paperbot/sources.js`: a `dhanStats`/`stats` counter (`ok`, `fail`, `lastError`, `lastErrorAt`, `lastSuccessAt`)
  wraps every Dhan call (`dhanCall()`, used by `dhanIntraday()` and `chainCall()`/`optionQuote()`) and every
  Binance call (`createCryptoSource`'s `get()`, counting one failure even when both hosts were tried, not two).
- `paperbot/yahoo.js`: its existing `stats` object (`requests`/`retries`/`failures`) extended with the same
  `ok`/`lastError`/`lastErrorAt`/`lastSuccessAt` fields at the two places it already touched `stats`.
- `paperbot/index.js`: one new line, `state.yahoo = yahoo;` (nse/crypto were already on `state`).
- `src/paper/ops/health.js`: `dataSources` now reads `state.nse.stats` (Dhan), `state.crypto.stats` (Binance),
  `state.yahoo.stats` (Yahoo) and reports `ok`/`failing`/`unchecked` with real counts; `"unchecked"` is kept,
  truthfully, for a source that has genuinely never been asked anything yet (fresh boot) or whose object
  does not exist (bot disabled/starting) - never a guess.
- Tests: `test/opsSourceStats.test.js` (8 cases, fake axios, no network) + extended `test/opsHealth.test.js`.
- Not verified live (sandbox has no outbound network): these recorders have never seen a real Dhan/Binance/Yahoo
  response, only fakes. Items 2, 4 and 5 of this round are in a separate, immediately-following PR.

### Item 2: daily summary extension + morning brief
All in `paperbot/report.js` (CC4 was explicitly allowed to edit this round). `dailySummary()` extended,
`weeklySuggestions()`'s skip-grouping refactored into the same shared `groupSkipsByReason()` (identical
behaviour, no duplicate logic):
- **By bot**: `perBotBreakdown()` - net INR, wins/losses, open count per bot that traded that day. Only the
  bot's OWN market family: `VARIANT_MARKETS = { nse: ['nse_scalp'], crypto: ['crypto_scalp', 'crypto_wide_scalp'] }`.
  **`exhaustion_only` is deliberately excluded** - it keeps its own table (`src/paper/bots/exhaustion_only/store.js`)
  and already has its own report page (`/api/paper/exhaustion-report`); pulling its numbers in would need a
  cross-module store import outside tonight's scope, so it stays out rather than being guessed in.
- **Best/worst trade**: `bestWorstTrade()`, across the main market + its variants for that day.
- **Skips by reason**: `groupSkipsByReason()`, same normalization the weekly report already used.
- **What to learn**: `whatToLearn()` - "too few trades today" below `minTrades`; otherwise names the single
  best-average pattern of the day, worded as a suggestion ("nothing changed automatically"), never applied.
- **Morning brief**: `morningBrief()` + `reporter.morningBrief()`, scheduled `cron.schedule('45 4 * * *', ...)`
  (one line in `paperbot/index.js`) - yesterday's full NSE day, crypto trades since the 23:55 cutoff, every
  open trade across every bot, and any `paper_alerts` rows from the last 12h (via `store.query`, when the
  alerts plugin's table exists). Telegram only when both env vars are set (reuses the existing `sendTelegram`/
  `publish` gate - no new logic needed there).
- Tests: `test/opsDailySummary.test.js` (14 cases, every number hand-computed in the test comments per rule 8).

### Item 4: CSV export + ping status line
- `src/paper/ops/csvExport.js` (new): `GET /api/paper/export.csv?type=trades|skips&date=YYYY-MM-DD[&market=...]`,
  same secret check as every other route. No market given = every market in `VARIANT_MARKETS` combined (each
  row keeps its own `market` column). No new dependency - CSV escaping is 6 lines, not worth `csv-parse`/`csv-stringify`.
- `paperbot/index.js`: `GET /api/paper/ping` now carries a `status` field (`ALIVE`/`PROBLEM`/`disabled`) read
  from the shared health tracker **in memory only** (no database read - it's hit every 5 min by the free
  Render pinger) - no secrets, no stack traces, ever.
- Tests: `test/opsCsvExport.test.js` (9 cases) + `test/opsPingStatus.test.js` (4 cases).

### Item 5: home page auto-linking to other windows' new report pages
Confirmed working **as designed**, no fix needed for `replay-report` or `bots-report` - both routes (CC5's
`route()` helper and CC3's leaderboard plugin's `app.get(`) were picked up automatically by `routeExists()`'s
live Express-router check the moment they merged.
**One real gap, fixed**: CC3's `exhaustion_only` bot's own page is `/api/paper/exhaustion-report`, which
wasn't in the candidate list at all - added it to `CANDIDATE_LINKS` in `src/paper/ops/home.js`.

### A real secret-leak bug found and fixed during the VERIFY loop (real Chromium, 390px)
The home page was putting the raw `PAPER_ADMIN_SECRET` into every link's `href` on every load (`?key=...`),
even after the cookie (`#33`) was already authenticating the browser - so the "weak secret in a URL" problem
`#33` was meant to fix was quietly recreated inside the home page's own HTML. Caught by a real
headless-Chromium run at 390×844 checking the rendered page source for the secret string, not just the
response we expected. Fixed: link `href`s are now the plain path with no query string at all; the cookie
already carries every follow-up navigation. Re-ran the same Chromium check after the fix - clean on
`/home`, `/health`, `/report`, `/news-check`, `/export.csv`.

### VERIFY loop, this round
`npm test`: 396/396 on the final rebase (300-396 across the round as other windows merged), repeated clean
runs throughout. Real headless Chromium at 390×844 against a throwaway in-memory store: `/home`, `/health`,
`/report`, `/news-check`, `/export.csv` all load, no `PAPER_ADMIN_SECRET` value and no
`postgres://`/`PAPER_DATABASE_URL` substring anywhere in the rendered page source or in `document.cookie`
(HttpOnly confirmed invisible to JS). `GET /api/paper/export.csv` and the new `GET /api/paper/ping` `status`
field smoke-tested end to end against the real wired server.

### Not verified live (sandbox has no outbound network)
The morning brief and Telegram sends have never gone out for real - fixture/mock-only throughout.

---

## CC4 round 3

### Item 1: test truth
Fresh `git clone` of `origin/main` (eb4c9ec) into a new empty directory, `npm ci`, full suite run twice
under TZ=UTC and TZ=Asia/Kolkata, with PAPER_ADMIN_SECRET set and unset: **8/8 conditions, 412/412 clean,
every time**. Also ran 3x sequential (`--test-concurrency=1`) to rule out ordering/flake: clean. CC2's
"380/384" total doesn't even match this commit's own test count (412), so it was a stale/older checkout,
not a real failure on this commit. No code change made for this item.

### Item 2: ALIVE / DEGRADED / PROBLEM
`src/paper/ops/health.js` and `paperbot/index.js`'s `/api/paper/ping`: the 02:40 IST false "PROBLEM" was
nseScan/nseMonitor correctly idle because NSE was closed (weekend), which the old staleness check didn't
know how to tell apart from a real stall. Now: NSE job staleness only counts while `nseSession(now,
holidays).open` is true (crypto is 24/7, so its staleness always counts); PROBLEM = a job that should be
scanning hasn't in 15+ min, DB down, or a crypto/NSE source down with no working fallback; DEGRADED = NSE
closed, Dhan down but Yahoo fallback working, or Telegram not configured; priority PROBLEM > DEGRADED >
ALIVE. Fixed one cross-window test (`test/paperReplaySafety.test.js`) whose fixed timestamp now reads
DEGRADED instead of ALIVE at that instant - loosened its assertion to the real contract (`skip === false`
only happens when status is not PROBLEM), not the exact label.

### Item 3: morning card
`src/paper/ops/morningCard.js` (new) + top of `src/paper/ops/home.js`: since 18:00 IST yesterday, per bot
(nse, nse_scalp, crypto, crypto_scalp, crypto_wide_scalp - exhaustion_only/trend_smc/mix keep their own
tables, not pulled in, same reasoning as the daily summary) - trades, wins/losses, net INR, skip count and
top 3 skip reasons. Plus data-source status and replay's last run (`state.replay.getLastRunStatus()` -
CC5 had already exported this for exactly this purpose; one line, `state.replay = attachReplay(...)`,
needed to reach it). Honesty note on the time window: `paper_trades.entry_time` is exact, so trade counts
are exact; `paper_skips.skip_date` is a DATE only (no time of day), so the skip count is from yesterday's
calendar date onward, not exactly 18:00 - said on the card itself.
