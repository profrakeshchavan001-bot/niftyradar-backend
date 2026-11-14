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
