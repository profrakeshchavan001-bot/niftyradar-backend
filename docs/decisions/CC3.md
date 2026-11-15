# CC3 overnight (2026-11-14)

**Update, ~18:10 UTC:** the first note below (written right after cloning, before any other PR had landed) said CC2's shared
`src/paper/lib/` and plugin loader did not exist. That changed: PR #22 ("Shared paper-bot lib + plugin auto-loader + bot interface
doc") landed on `main` while this session was working, confirming other windows really are active tonight as the brief described.
Re-read `docs/BOT-INTERFACE.md` and `src/paper/lib/` after that, and used them to build `exhaustion_only` (item 3) as a real plugin
under `src/paper/bots/` - see the section below. `trend_smc` (item 2, more involved: EMA cross OR BOS/CHoCH + order-block/FVG retest
with premium/discount zones) was not attempted after that: time was spent instead on exhaustion_only end-to-end (hand-verified tests,
a real-Postgres check of its own schema) rather than starting a second, more complex bot with less time left to verify it properly.


Session scope and decisions, PAPER ONLY, crypto scalp strategy (`src/paper/scalp/`).

## What this session actually found

The overnight brief described a much larger multi-window swarm (CC2 owning a shared `src/paper/lib/` candle-cache/EMA/ATR/SMC library and a plugin loader with `docs/BOT-INTERFACE.md`, CC4 owning `src/paper/ops/`, CC5 owning `src/paper/replay/`, several new bots: `trend_smc`, `exhaustion_only`, a cross-bot leaderboard, a shadow-tracker, a suggestion/mix engine). None of that exists in this repository: there is no `src/paper/lib/`, no `src/paper/bots/`, no `BOT-INTERFACE.md`, and no evidence any other session was working on this repo tonight. Rather than invent that whole framework unverified and unattributed to sessions that may not exist, this session did the one item from the brief that is concrete, bounded, and fits the repository's existing, mature scalp code: item 1, the scalp fix and `scalp_wide` variant. Items 2-8 (the new bots, shared lib, leaderboard, shadow tracking, suggestion engine, docs/BOTS.md) were **not** attempted; they need the shared candle-cache/indicator library and plugin interface the brief assumes, which does not exist, and building that from scratch overnight, alone, for real SMC/trend logic without another session to review it, was judged too large a scope change to take unreviewed. Flagging this rather than guessing.

## Item 1: scalp fix + scalp_wide (done, merged)

| # | Topic | What was found | Decision taken | Needs from owner |
|---|---|---|---|---|
| 1 | `min_rr` | Default 1.3; round-trip cost 0.23 %, tight scalp's target is capped at 0.5 %, so almost every setup computed reward/risk well under 1.3 and was skipped (confirmed by the repo's own existing test). | Set `SCALP_DEFAULTS.min_rr` to 1.0 (never lower — a trade that cannot pay its own costs is not logical, per the brief). At 1.0 the tight scalp still skips most setups (0.5 % cap vs 0.23 % costs rarely clears 1.0); this is expected and stated in `docs/SCALP.md`, not hidden. | None — this is the floor asked for. Lower per-run via `paper_config.scalp.min_rr` only if you want more (marginal) tight-scalp trades to study. |
| 2 | `scalp_wide` timeframe | Brief said "on 5m candles" without naming a trend timeframe. | Entry on closed 5-minute candles, trend on 15-minute candles built from them (same ratio as the tight scalp's 1m-entry / 5m-trend, and the same fallback the intraday bot already uses when no native 15m feed exists). | Say if a native 15-minute feed should be read directly instead (one extra Binance call per scan). |
| 3 | `scalp_wide` target rule | "target the nearest level at least 0.8% and 1xATR away" — satisfying both minimums at once is the same as requiring the larger of the two. | `required = max(0.8%, 1 x ATR14(5m)%)`; if the nearest opposite level is closer than `required`, skipped (no room). The target actually used **is** the level itself (no margin held back), unlike the tight scalp's level-minus-0.1%. | OK, or say if a margin should be held back before the level too. |
| 4 | `scalp_wide` stop cap / floor | Not given a number. | `stop_cap_pct` 1.5 %, `min_stop_pct` 0.1 % (5-minute ATR moves are naturally larger than 1-minute ones, so both are set wider than the tight scalp's 0.3 % / 0.05 %). | Review against real data once it has run a few days; these are my own defaults, not from the brief. |
| 5 | `scalp_wide` market key | The brief's item 4 (not attempted) asks every full bot for its own market key; item 1 only asked for a "variant". | Gave it its own market key `crypto_wide_scalp` anyway (own balance, own open-trade tracking, independent of the tight scalp) rather than share `crypto_scalp`, because two variants sharing one market would have blocked each other's "one open trade per coin" check. The name **must** end in `_scalp` (not `_scalp_wide`) — the existing store code excludes intraday markets by `market.endsWith('_scalp')`; getting the suffix the other way round would have leaked scalp_wide trades into the intraday report, the daily summaries and the judge. Caught this before merging. | None. |
| 6 | Report page | Brief didn't ask for a new endpoint for the variant. | Added a third tab ("Scalp wide") to the existing `/api/paper/scalp-report` rather than a new route; same secret, same JSON shape (`scalpWide`, `recentScalpWide`). | OK, or say if it should be a separate route instead. |
| 7 | Cron timing | Not specified. | Scan every 5 minutes (10 s past the minute, offset from the tight scalp's own 5 s), monitor every minute (40 s past). | None. |

Tests: `node --test test/paperScalp.test.js` (28 passing, including hand-verified numbers for `analyseWide` worked by long division in the test comments, not copied from the function's own output) and the full `node --test test/*.test.js` (189 passing, 0 failing) both run locally on this build machine. `test-integration/` (needs a real `*_test` Postgres) and live Binance access were **not** tried — this sandbox could not reach `data-api.binance.vision` (see note below) and there is no Postgres here; said so rather than claiming otherwise.

**Binance reachability:** not verified live, as instructed. A connection attempt to `https://data-api.binance.vision` from this sandbox was not possible (no outbound network to that host from this build environment). Tests use fixtures only; live behaviour is unconfirmed until the real Render deploy runs it.

**Merge:** this PR was merged to `main` by this session with the owner's explicit permission (given this session, for `niftyradar-backend` only), per the overnight brief's rule 11 exception. Commit carries `[skip ci]` (no GitHub Actions workflow exists in this repo anyway, so this is a no-op, but kept for the brief's convention).

## Follow-up: a real bug caught in the VERIFY loop (second PR, second merge tonight)

Re-reading tonight's own code for cost mistakes and look-ahead mistakes (as the brief's VERIFY loop asks), `sql/paper_bot.sql` has `ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_market_check CHECK (market IN ('nse', 'crypto', 'nse_scalp', 'crypto_scalp'))`. `crypto_wide_scalp` was not in that list. The in-memory test store (used by every test above) does not enforce SQL constraints, so all 29 tests passed while a real Postgres would have rejected **every single scalp_wide trade insert** with a constraint violation, the moment it ran on Render. Caught this by starting a local Postgres 16 in this sandbox, applying `sql/paper_bot.sql` to a throwaway database, and inserting a real row with `market = 'crypto_wide_scalp'` — it failed exactly as predicted, confirming the gap before it shipped.

Fix: appended one more idempotent `DROP CONSTRAINT IF EXISTS` / `ADD CONSTRAINT` pair widening the list to include `crypto_wide_scalp` (same pattern the file already uses for every earlier change to this constraint). Verified on the same local Postgres: the schema file re-applies cleanly a second time (idempotent), a `crypto_wide_scalp` row now inserts, and an arbitrary market string is still correctly rejected. Added an offline test (`test/paperScalp.test.js`) that reads `sql/paper_bot.sql` and checks the live constraint text includes `crypto_wide_scalp`, so this exact class of mistake — a bot added to `src/paper/scalp/` without updating the schema's allow-list — fails `npm test` next time instead of only failing in production. `npm run migrate` still needs to be run on deploy, as always (rule 4 / `docs/DEPLOY.md`-equivalent here).

## Item 3: exhaustion_only (done, merged) - a real plugin under src/paper/bots/

Built once CC2's `src/paper/lib/` and `src/paper/pluginLoader.js` landed on `main` (see the update note at the top of this file). Files:
`src/paper/bots/exhaustion_only/{engine,bot,store,config,register,schema.sql}.js`, worked example in `docs/BOTS.md`, tests in
`test/exhaustionOnly.test.js` (11 passing, hand-verified numbers).

| # | Topic | What was found | Decision taken | Needs from owner |
|---|---|---|---|---|
| 1 | The rule itself | The brief's wording ("4+ of last 6 red, price below VWAP, small red then green closing above its high") is, candle for candle, exactly what `paperbot/patterns.js`'s `exhaustionReversal()` already implements - not a coincidence; it is the same reversal pattern the main bot and the scalp bots already use. | Reused `exhaustionReversal()` directly rather than writing a second copy of the same rule, so there is exactly one implementation of it in the repo (one place to fix if it is ever wrong) and no risk of two slightly different versions drifting apart. The brief's "no other pattern, no trend filter" is satisfied because that function checks only this rule - nothing about the 5-min/15-min trend agreement the scalp bots layer on top of it. | None. |
| 2 | Target / stop | "Level-based target and stop" was not given exact numbers. | Reused `src/paper/lib/levels.js` `planTrade()` (the shared library CC2 built, the same one the main crypto bot's own target/stop already uses): target = nearest opposite level, 0.1% held back; stop = pattern candle + 1 x ATR14(15-minute). `min_rr` 1.2 after the same 0.23% round-trip cost as the other crypto bots. | OK, or give different numbers. |
| 3 | Breakeven / time stop | Not mentioned for this bot (unlike scalp and scalp_wide, which both get an explicit breakeven rule). | Gave it neither - plain target/stop exits only, via `src/paper/lib/exitSim.js` `simulateExit()` (candle-accurate, built by CC2; both touched in one candle still books the stop, same worst-case rule as every other bot tonight). | Say if a time stop should exist after all. |
| 4 | Storage | Could have reused the shared `paper_trades` table (like scalp) or its own tables. | **Own tables** (`exhaustion_only_trades`, `exhaustion_only_skips`, own `schema.sql`, loaded by the plugin loader) rather than widening `paper_trades`'s market CHECK constraint a second time tonight - several windows may be touching that table's constraint concurrently (see the scalp_wide fix above), and a plugin is supposed to bring its own idempotent schema per `docs/BOT-INTERFACE.md`. Verified on a local Postgres: applies idempotently, inserts and reads correctly. | None. |
| 5 | Config | Rule numbers (min_rr, atr_mult, ...) needed to live somewhere the owner can change without a redeploy. | Reused the *existing* `paper_config` table (key `exhaustion_only`) via the main store the plugin already receives in `register(ctx)`, same convention as `scalp`/`scalp_wide`, rather than inventing a second config mechanism for this one bot. | None. |
| 6 | 15-minute candles | No native feed; `planTrade()` needs ATR14(15m) and 15-minute swing levels. | Same choice the main crypto bot already made (`paperbot/bot.js`): build them from the 5-minute candles (`E.aggregate`) rather than an extra Binance request. | Say if a native 15m read should be added later (one extra call per symbol per cycle). |
| 7 | Restart safety | The brief's EXTRA section asked that a redeploy never double-enter a trade. | Same mechanism every bot tonight already uses: the candle's own open time (`trigger_t`) is checked against today's stored trades before entering, so a restart that re-scans the same still-current candle finds the earlier trade and does nothing. This only holds with `PAPER_DATABASE_URL` set (memory mode has no restart safety at all, same caveat as every other bot). Not re-tested beyond that - no actual Render redeploy was available from this sandbox to rehearse. | None. |
| 8 | GitHub Actions | No workflow file exists. | Merge commit carries `[skip ci]`, same as every PR tonight. | None. |

**Not attempted:** `trend_smc` (item 2 of the overnight brief - EMA cross or BOS/CHoCH + order-block/FVG retest, premium/discount zones), the cross-bot leaderboard (`/api/paper/bots-report`, item 6), shadow-tracking of every skip (item 5), and the suggestion/mix engine (item 7). Each of these is a larger piece than `exhaustion_only` and would have needed either less verification tonight or less sleep than the brief's own 04:00 IST cutoff allows for honestly. Flagging rather than rushing them.


## EXTRA: shared candle cache across bots (scan-time / memory check for one Render Free instance)

The overnight brief's EXTRA section asks that every bot "fit one Render Free instance, using the shared candle cache and never fetching
the same candles twice." Checked: the main crypto bot, the scalp bots and `exhaustion_only` all independently asked Binance for the same
symbol's 5-minute candles through separate, uncached `createCryptoSource()` calls - up to 4 Binance requests per coin per cycle instead
of 1. Fixed in `paperbot/index.js`: the one `cryptoSrc` instance already shared by the main bot and `attachScalp()` is now wrapped with
`src/paper/lib/candleCache.js` (`createCachedCrypto`, 50 s TTL for 5-minute candles, 4 min for hourly - well under a candle's own close
time, long enough to dedupe same-tick callers) and the SAME wrapped instance is also handed to the plugin loader as `ctx.cachedCrypto`,
so `exhaustion_only`'s `register.js` reuses it instead of making its own. A call with a custom range or a non-default limit (the report
page's chart) always bypasses the cache, so nothing that needs an exact window is ever served another caller's cached window.
`test/paperCachedCrypto.test.js`: 5 passing (shared fetch, independent symbols, range/limit bypass, hourly cached separately, `price()`
passed through unchanged). `scalp`/`scalp_wide` needed no changes at all - they already received `crypto` as an injected parameter, so
wrapping it once at the source fixed all three without touching either of those two already-merged files.

Not done: the main crypto bot's *own* internal candle-fetch calls inside `paperbot/bot.js` were left untouched beyond this (they already
go through the now-cached `cryptoSrc`, so they benefit automatically); no attempt was made to also share NSE candles, since the brief's
EXTRA item was about the crypto bots specifically and NSE has no equivalent duplication tonight.

# CC3 round 2 (2026-11-14, continued)

Four PRs this round, all merged with the owner's standing permission for this session: shadow tracking + leaderboard (#39), trend_smc
(#42), and this one (mix + docs/BOTS.md). 4 of the raised cap of "at most 4 more merges" used.

## Item 1: shadow tracking (done, merged in #39)

Own `src/paper/shadow/` (schema + store), shared by scalp, scalp_wide and exhaustion_only (and, once it existed, trend_smc too). Each
engine's "reward/risk below min_rr" skip branch - the one case with a complete entry/stop/target plan already computed - now also
returns a `shadowPlan` in `extra`; every other skip reason (no setup, too few candles, no room for a target) genuinely has nothing to
follow, so it carries none. `src/paper/scalp/bot.js` and `src/paper/bots/exhaustion_only/bot.js` record one on that skip and resolve
open shadows in their own `monitor()`, using the SAME `evaluateExit()` a real trade of that bot would get (same breakeven/time-stop
rules). Verified against a local Postgres: the schema is idempotent and the unique `(bot, symbol, trigger_t)` index does the dedupe on
Postgres too, not just in the memory store.

## Item 2: leaderboard (done, merged in #39)

`src/paper/bots/leaderboard/` (a plugin, auto-loaded). `GET /api/paper/bots-report`. Stats worked out independently per bot
(`computeBotStats`): win rate, net/gross/cost-% from `pnl_inr`/`gross_pnl_inr` (every bot's trade rows carry these - exhaustion_only and
trend_smc deliberately use the SAME field names as scalp's `settle()` so one stats function works for all of them without a per-bot
adapter), average win/loss, max drawdown (walks trades in the order they CLOSED, tracks the running peak of cumulative net P&L). A bot
under 20 trades is shown (never hidden) but excluded from the ranked list and marked "too few trades, no conclusion"; a net loss after
costs sets `lossAfterCosts: true` and is shown in red on the page, not quietly left out. `exhaustion_only`'s and `trend_smc`'s trades are
read live at request time (`ctx.exhaustionMemoryStore` / `ctx.trendSmcMemoryStore`, set by each plugin's own `register()`), not captured
at the leaderboard's own registration time - this was deliberate, because `src/paper/pluginLoader.js`'s plugin load order is whatever
`fs.readdirSync` happens to return, not guaranteed alphabetical, so the leaderboard must never assume another plugin registered first.

## Item 3: mix (done, merged this PR)

`src/paper/bots/mix/` (a plugin). `GET /api/paper/mix-report`, labelled `"suggestion, needs owner approval"` in every response. Reuses
`leaderboard`'s own `closedTradesByBot()` (exported for this reason) rather than re-querying every store a second time. Groups closed
trades by (symbol, candle open time); a candle only one bot ever traded is not a vote. Weight = that bot's own win rate, zero unless it
has 20+ trades (per the brief). Score = the weighted sum of directions (LONG/up = +1, SHORT/down = -1), normalized by the total weight
of the bots that actually had an opinion on that candle - a bot with zero weight still shows in the "who voted" list but does not move
the score. A score near zero (both sides equally weighted and opposite) is reported as "no agreement", never forced to a side by
floating-point noise - this needed a small deadband (±0.05) once I noticed an exact tie could otherwise read as a direction due to
rounding. The "weighted result" is a weighted average of what the voting bots' OWN trades on that candle actually scored - clearly an
approximation (their real entries/stops/targets differ), and the report says so, since fully re-simulating a single combined position
candle-by-candle was judged too large an addition for the time left tonight. It writes nothing, anywhere, ever.

## Item 4: trend_smc (done, merged in #42)

See `docs/BOTS.md` for the rule. Found CC2's `src/paper/lib/smc/` on `main` about 90 minutes into this round (checked by `git fetch`
periodically, as the brief asked) - well before the brief's own "build a private helper by 02:30" fallback would have triggered, so no
private SMC helper was needed. The one real gap: EMA20/50(15m) needs 51+ real 15-minute candles, more than `aggregate()` of a sane
number of 5-minute candles can give, so a small, self-contained Binance 15-minute source was added inside `trend_smc/register.js` only
(not the shared `paperbot/sources.js`, to avoid touching a file other windows may also be mid-edit on tonight).

## Item 5: docs/BOTS.md (done)

Updated with trend_smc, shadow tracking, the leaderboard and mix - each with a worked example where the brief asked for one.

## Not attempted this round

- The main **intraday** bot's own shadow tracking (the brief scoped this round's shadow tracking to "YOUR bots": scalp, scalp_wide,
  exhaustion_only - trend_smc was added once it existed too, since it is also mine).
- A UI or route that lets the owner actually **apply** a mix-suggested weight to a bot. Mix is read-only by design tonight; there is
  nothing in the brief asking for it to write anything, and building a write path the owner never asked to be built seemed like the
  wrong kind of initiative for an unattended overnight session.
- A real backtest of "what a single combined position would have done" for mix, as opposed to the weighted-average-of-actual-trades
  approximation above - flagged, not hidden.

## VERIFY loop this round

`node --test test/*.test.js`: 363 passing, 0 failing, after every rebase onto the other windows' work tonight (one real merge conflict,
in `test/paperLib.test.js`, resolved in favor of the other window's more robust fix rather than my own). Every new/changed schema file
(`src/paper/shadow/schema.sql`, `src/paper/bots/trend_smc/schema.sql`) applied twice against a local Postgres 16 to confirm idempotency,
plus a real insert to confirm the constraints actually work, not just parse. Re-read every new file once more for look-ahead mistakes
(a shadow or a mix suggestion reading a candle before it closed) and cost mistakes (the 0.23% round trip applied twice, or not at all)
before each merge; found none beyond the two already described above (the entry-price mix-up in trend_smc's own test, and the
mismatched test-fixture clocks), both caught by the tests themselves, not missed. Binance not verified live (no route from this
sandbox); fixtures only throughout.

# CC3 round 3 (2026-11-14): stability audit

One bundled PR, one merge, as the brief capped it ("every merge restarts the live bot"). Full detail and the measured numbers:
`docs/STABILITY.md`.

| # | Topic | What was found | Decision taken | Needs from owner |
|---|---|---|---|---|
| 1 | Measurement | No prior measurement existed for this session's 4 bots + shadow tracking together. | `tools/stability-check.js`: fixtures, a throwaway Postgres, one full scan+monitor cycle - 59 ms, 44 DB queries, 60.5 MB process RSS (bare Node + pg, no Express). Said plainly in `docs/STABILITY.md` that the main intraday bot, the Judge and the replay engine were NOT included (their fixtures would have needed more time than was left), so this is not a clean bill of health for the whole app, only for this session's own bots. | Someone should benchmark the main bot + replay the same way; flagged, not done. |
| 2 | Cron collisions | 3 real second-collisions found by listing every `cron.schedule` call: `trend_smc scan`/`nse scan` both `:20` every 5 min (market hours); `trend_smc monitor`/`nse monitor` both `:50` every minute (market hours); `shadow monitor`/`scalp_wide monitor` both `:40` (one every 5 min, one every minute - collide every 5th minute). | Moved to `:22`, `:58`, `:42` respectively. Every other requirement (overlap guard, error isolation) was already satisfied by the existing `guarded()` wrapper every job already used - checked, not re-implemented. | None. |
| 3 | Timeout/backoff | 15 s timeout, no backoff, on Binance/CoinGecko; Yahoo already had retries but a 15 s default timeout too. | 8 s timeout everywhere named, one backoff pass (400 ms, then every host again) added to the Binance/CoinGecko fetch and `trend_smc`'s own 15-minute source; Yahoo's own retry/backoff logic untouched, only its default timeout lowered. | Say if 8 s is too aggressive once this runs live (Binance can be slow from some regions). |
| 4 | No held DB connections | Brief asked this be confirmed. | Grepped the whole repo for `pool.connect()` / `client.release` - none found; every store call uses `pool.query()` directly, which `pg` checks out and returns per call, never held across an `await` on a network fetch. Confirmed, not changed. | None. |
| 5 | Shared cache | `trend_smc`'s own 15-minute Binance source used its own `createCandleCache()`, separate from the 5m/1h cache every other bot shares. | `paperbot/index.js` now builds ONE cache and wraps both the 5m/1h source (`createCachedCrypto`) and the new 15m wrapper (`create15mCrypto`) with it; the plugin loader hands trend_smc the wrapped version as `ctx.cached15mCrypto`. | None. |
| 6 | Restart safety | The existing protection was application-level only (a `SELECT` before every insert) - real, but not airtight across a true process restart mid-insert. | Added a real `UNIQUE` index: `(market, symbol, trigger_t)` on the shared `paper_trades` (idempotent `CREATE UNIQUE INDEX IF NOT EXISTS`; nullable `trigger_t` rows are untouched, Postgres never conflicts two NULLs), `(symbol, trigger_t)` on `exhaustion_only_trades` and `trend_smc_trades`. Every `insertTrade()` (Postgres and the in-memory store that mirrors it for tests) does `ON CONFLICT ... DO NOTHING RETURNING id`, returns `null` on a duplicate, and every bot's `scan()` now checks for that and silently moves on instead of logging a second entry. Simulated the actual kill-mid-cycle both in `test/paperRestartSafety.test.js` (a fresh bot instance, same store, same still-current candle) and by hand against a local Postgres 16 (same insert run twice with `ON CONFLICT`: second run returns 0 rows, the table still has exactly 1). `shadow_setups` already had this from round 2, unchanged. | None. |

**VERIFY loop:** `node --test test/*.test.js` - 419 passing, 0 failing. Re-read the whole diff once more specifically for anything
that could change a trade decision: nothing does - every change is a timeout value, a cron second, a cache key, a DB-level dedupe,
or a restart-safety null-check; no stop/target/reward-risk/pattern/trend calculation was touched. Binance/Yahoo not verified live
(no route from this sandbox); every number in `docs/STABILITY.md` came from fixtures against a real local throwaway Postgres, said
so there and here.

# CC3 urgent fix (14 Nov, ~21:35-22:00 UTC): live evidence from Supabase

## (a) 10 shadow_setups rows stuck open 40+ minutes past their stop/target/time stop

Root cause, found by re-reading the live wiring rather than just the tests: `resolveShadows()` (src/paper/scalp/bot.js,
src/paper/bots/exhaustion_only/bot.js, src/paper/bots/trend_smc/bot.js) only wrapped the CANDLE FETCH in a try/catch - a throw
from `shadowStore.openShadows()` or `shadowStore.resolveShadow()` itself (a real Postgres error - connection hiccup, a transient
Supabase blip, anything) killed the WHOLE function for every shadow on that tick, logged once to a line nobody was watching, and
repeated forever on every later tick since the row never moved past status='open'. The cron wiring itself was correct (`scalp
monitor` at `:35`, every minute, calls `resolveShadows` at the end either way) - this was not a missing/clashing cron line, it
was an unguarded throw. CC2's SEPARATE `paper_shadows`/`shadowMonitor` (the main bot's own shadow tracking) is a different table
and a different job; no clash with this session's `shadow_setups`.

Fix: wrapped the ENTIRE body of `resolveShadows()` in try/catch (outer: the whole function; inner: per-shadow, so one bad row
never blocks the rest), with the real error message logged instead of swallowed. Added `test/paperShadowResolver.test.js`: boots
the REAL `attachScalp()`/`exhaustion_only` `register()` wiring (not just `createScalpBot()` directly), with a `createScalpSource`-
shaped axios mock (real Binance-kline array format), and proves (1) the scan/monitor crons are actually registered - fails loudly
if not - and (2) the exact scheduled monitor function resolves a real shadow to its target, end to end.

**Backfill (item 2):** `backfillShadows()` added to every bot, run once (fire-and-forget) right after each plugin's `register()`
finishes wiring its crons - uses a bigger candle window than the regular per-tick fetch (24h of 1-minute candles for scalp; the
5-minute source's own 330-candle/~27h default already covers scalp_wide/exhaustion_only/trend_smc). Idempotent: `resolveShadows`
only ever reads `status = 'open'` rows, so running it twice, or on a database already caught up, is always a safe no-op.
**Not verified live** - this sandbox cannot reach Binance; the 10 real stuck rows in Supabase will be picked up by this backfill
on the next deploy, not by this session directly.

## (b) scalp skips still say "below 1.3" though PR #25 set the code default to 1.0

Root cause: the precedence rule was already correct and already documented ("the stored row wins") - the bug was that the
`scalp` row in `paper_config` was written ONCE, by `setConfigIfMissing`, before PR #25 existed, so it still holds the
pre-PR#25 default (`min_rr: 1.3`) and silently overrides the new code default on every deploy since. `setConfigIfMissing` is
right to never overwrite a value the owner might have hand-tuned - the real fix is a one-time, named migration of that ONE
known-stale value, not a change to the precedence rule itself.

Fix: `paperbot/configMigrate.js`, a small table of `{key, field, from, to}` one-time corrections (currently just
`scalp.min_rr: 1.3 -> 1.0`), run once at startup, idempotent (checks the stored value is STILL exactly the old default before
touching it - never touches a value the owner changed to something else on purpose). Added `store.setConfig()` (unconditional
upsert) alongside the existing `setConfigIfMissing()`, on the memory store, the Postgres store and the cached wrapper.
`GET /api/paper/scalp-report` now shows the EFFECTIVE config (`effectiveConfig.scalp.min_rr` / `.scalp_wide.min_rr`, both JSON and
the HTML page) so a stale stored value can never again hide silently.

**Checked scalp_wide, exhaustion_only, trend_smc for the same class of bug:** none found - their `min_rr` defaults (1.0, 1.2, 1.5
respectively) were set correctly on their very first deploy and have never been changed in a later PR, so there is no
pre-existing stale row for them to migrate. Only `scalp` had a code default that changed AFTER its config row was first created.

## Item 4: /api/paper/health

`staleShadows`: a raw count of `shadow_setups` rows `status='open'` and `created_at` older than 60 minutes, across every bot
(one query, not per-bot - the count alone is the signal). `null` when there is no raw `store.query` access (memory mode / bot
not ready) - never reported as a false "0". Any count above 0 is a `PROBLEM`, with the count stated in the reason text, same
severity tier as a stale job or a down data source.

**VERIFY:** `node --test test/*.test.js` - 465 passing, 0 failing. The `setConfig` UPSERT and the stale-shadow COUNT query were
both run by hand against a local Postgres 16 (not just asserted in the test suite): the upsert correctly replaces an existing
row's value, and the count query correctly found 1 row inserted 90 minutes in the past. Not verified against live Binance or the
real Supabase database - fixtures and a local throwaway Postgres only, as every round this session.

# CC3 URGENT (15 Nov, ~00:30 UTC): the ~3-hour total write stall

## Root cause: no Postgres statement_timeout, pool max 2

A query that stalls mid-flight (a dropped TCP connection to Supabase, a frozen pooler) had NO timeout at all -
`connectionTimeoutMillis` in `pgOptions()` only bounds ESTABLISHING a new connection, never a query already running on
one. With the pool capped at 2 connections and 5+ bots sharing it, two such stalls at once exhaust the pool completely:
every other job's write then queues forever, with no error anywhere - exactly "every table stops at once, cron still
fires, `/api/paper/ping` still answers" (ping and most of health do not touch the DB at all).

**Reproduced by hand** on a local Postgres 16: `pool.query('SELECT pg_sleep(30)')` x2 (pool max 2, no timeout) leaves a
3rd, completely ordinary query pending indefinitely - confirmed it was STILL pending 5 seconds later with no sign of
resolving. Adding `statement_timeout: 10000, query_timeout: 10000` to the pool options: both `pg_sleep(30)` calls are
killed at ~10.0s ("canceling statement due to statement timeout" / "Query read timeout"), the connections are returned,
and the 3rd query succeeds immediately after. This is the actual fix, not a guess - `paperbot/index.js` `pgOptions()`.

**Also found and fixed while reproducing, real but secondary:**
- `src/paper/scalp/index.js`'s shadow-schema creation was a bare, un-awaited fire-and-forget; the very first shadow
  backfill (and potentially the first scan tick) could race it and fail with `relation "shadow_setups" does not exist`
  - reproduced locally, now fixed the same way `exhaustion_only`/`trend_smc` already did it (round-3 urgent fix): the
  backfill now `.then()`s off the schema promise instead of firing blind.
- A second, more minor race remains between concurrent `CREATE TABLE IF NOT EXISTS` statements from different plugins
  loading in parallel (a known Postgres gotcha - `IF NOT EXISTS` is not fully race-proof under true concurrency); seen
  once as a harmless, already-caught-and-logged "duplicate key value violates... pg_type_typname_nsp_index" on
  `exhaustion_only`'s own schema apply. Not chased further tonight - it is already non-fatal (the table the OTHER
  concurrent creator made is still there and used correctly) and genuinely minor next to the real fix above.

## What to check on Render logs (for the owner)

Grep the Render logs around 14 Nov 21:25-21:35 UTC for `ECONNRESET`, `Connection terminated`, a Postgres/Supabase
connection error, or several merges landing in quick succession (each merge restarts the live process, and several
landed in that exact window - #49, #50, #51, this session's earlier #52). If the logs show nothing explicit at all for
that window either, that itself is consistent with this root cause: a stalled query produces no error of its own, only
silence, until something else (a restart) clears it.

## Fixes (items 2-4)

- `pgOptions()`: `statement_timeout`/`query_timeout` 10s (the real fix, above).
- `guarded()`: every job now races against `maxMs` (25s default) - a hang anywhere else is abandoned and logged, never
  silently wedging that job's own guard shut; `busy` additionally self-clears after `maxBusyMs` (75s) as a second,
  independent safety net; the timeout's own internal timer is explicitly `clearTimeout`'d on the normal/fast path so it
  never lingers.
- Startup resume (item 4): every bot (`scalp`, `scalp_wide`, `exhaustion_only`, `trend_smc`) now runs its own `monitor()`
  once immediately at startup (not waiting for the next cron tick), so a trade left open across a restart/outage - the
  stuck `crypto_wide_scalp` ETHUSDT row - is checked against real candle history right away. Combined with the
  statement_timeout fix, this is what actually closes it on the next deploy; not verified live (no route to Binance or
  Render from this sandbox).
- `/api/paper/health`: `lastDbWriteMinutesAgo` - the newest row across `paper_trades`, `paper_skips`, `shadow_setups`,
  `exhaustion_only_trades`, `trend_smc_trades` in one query - PROBLEM at 10+ minutes. This is the check that would have
  caught the actual outage directly, not inferred from a cron tick having merely fired.
- **Not added, though asked for:** a flat "storage !== postgres -> PROBLEM". Every existing ALIVE/DEGRADED test in
  `test/opsHealth.test.js` (and `paperReplaySafety.test.js`'s `shouldSkipAutoRun`) stands a plain memory store in as "the
  database is fine" - adding this check turned every one of those into a false PROBLEM. `state.enabled`/`db.ok` already
  cover "no database configured at all" today; rewriting that whole test baseline to tell a real memory *fallback* apart
  from a memory store used as a *test double* was judged too large a change to make safely in this pass. Flagged, not
  silently dropped.

**VERIFY:** `node --test test/*.test.js` - 471 passing, 0 failing. The full fix stack (statement_timeout, the schema-race
fix, startup resume, backfill) booted end to end against a fresh local Postgres with the real `attachPaperBot()` wiring
and a deliberately-failing axios (simulating Binance being unreachable, as it is from this sandbox): no race errors, no
hangs, every bot's startup resume and backfill ran and logged `checked 0, closed 0` / `0/0` correctly on the empty
database. Not verified against live Binance, live Render, or the real Supabase database.
