# CC2 overnight (14-15 Nov 2026) decisions

Owner asked for a lot overnight (9 numbered items + extras). This log records
what was actually done vs. deferred, and the defaults taken for anything
unclear. PAPER ONLY throughout; no order code touched; PAPER_DATABASE_URL
only.

## Item 1 - shared lib + plugin loader + bot interface (PR #22)

Done, merged first as asked (unblocks CC3/CC4/CC5).

- `src/paper/lib/{indicators,levels,candleCache,index}.js`: indicators
  (EMA/ATR/VWAP/trend) and level/exit-planning functions (swing highs-lows,
  order blocks, FVG, previous day/week, `planTrade`/`manageTrade`) are
  **re-exported** from `paperbot/patterns.js` and `paperbot/rfactor.js` /
  `paperbot/cryptoLevels.js` - not rewritten, so behaviour is unchanged (own
  test asserts the re-exported function is the exact same reference). Those
  files already had this logic in one place; item 1a as literally described
  ("moved... without changing behaviour") is satisfied by re-export rather
  than a physical move, because a move would touch every existing
  `require('./patterns')` call across `paperbot/` and the already-merged
  scalp bot (PR #21, owned by CC3 tonight) - a bigger, riskier diff than the
  task needs for a one-night PR window.
- `src/paper/lib/candleCache.js`: a generic per-key cache (one in-flight
  fetch shared by every caller asking for the same key within the TTL).
  **Not yet wired into the existing crypto bot or the scalp bot** - those
  files (`paperbot/sources.js`, `src/paper/scalp/source.js`) are owned by
  other windows tonight (CC3/CC4) and are mid-edit; forcing them onto this
  cache tonight risks exactly the kind of cross-window collision rule 5 in
  the brief warns about. The cache is ready for any bot (new or existing) to
  opt into; left as a note for the owner rather than done silently.
- `src/paper/pluginLoader.js`: auto-loads any `src/paper/{bots,ops,replay}/*/register.js`,
  runs its `schema.sql` (if any) through a `pool.query` the paper bot's own
  store now exposes (one-line additive change to `paperbot/store.js`:
  `query: pool.query` on the Postgres store only; memory store still has no
  `query`, so plugin schemas are skipped with a log line, not an error, when
  there is no database). A throwing plugin is logged and skipped, never
  crashes the server (tested with a plugin that throws on `register()`).
- `docs/BOT-INTERFACE.md`: the `decide(candles, context)` contract - pure,
  no clock/network inside, no look-ahead, deterministic - so
  `src/paper/replay/` can run the same code live and in replay.
- Tests: `test/paperLib.test.js` (8 cases, all passing locally; full suite
  191/191 passing after the change, 0 failures).

## Items 2-9 and the extras

**Not started this session.** Given the size of the remaining ask (Yahoo NSE
fallback with measured delay, full exit-accuracy-per-candle rework across
both markets, ATR-aware target filtering, EMA cross columns, full SMC/ICT
detector suite with hand-worked tests, a reweighted Judge, shadow tracking,
and the `/api/paper/report` additions for all of that) each is itself a
multi-hour, test-heavy change touching shared surfaces (`paperbot/bot.js`,
`src/paper/decision/judge.js`, the trade schema). Starting them without
finishing - especially exit-accuracy and schema changes - would leave the
live demo bot in a half-migrated state, which is a worse outcome than one
solid, tested, merged PR plus an honest list of what is still open.

Note worth flagging to the owner: `src/paper/decision/judge.js` already
exists on `main` (from an earlier session, see `docs/DECISIONS-PENDING.md`
J1-J9) with its own weighting (not the 25/25/15/10/10/10/5 the brief asks
for) and its own null-handling convention (missing helper earns HALF its
points, not a rescale-to-100). Item 7 as written would replace that scheme;
flagging here rather than quietly picking one on a night with no owner
awake to ask.

## Extras: IST/UTC edge tests + How-the-bot-thinks doc (5th and last merge tonight)

`test/paperTimeEdges.test.js`: hand-computed tests at 09:15, 15:15, 15:30
and midnight IST against `paperbot/time.js`. Found (not a bug, but worth
recording): `nseSession`'s `minutes` field is whole-minute resolution
(seconds dropped), so the market stays "open" for the ENTIRE 15:30:00-15:30:59
minute and only closes at 15:31 IST, not one second after 15:30:00 - my
first draft of this test assumed the latter and failed; fixed the test, not
the code, since whole-minute checking is how the rest of the file already
works (`nseSession`, `toMinutes`) and changing it now is a behaviour change
nobody asked for. Also verified: the IST day rolls over at 18:30 UTC (5:30
hours before UTC midnight), weekends and listed holidays close the market
at every hour including 09:15, and a holiday on one date does not affect
another date.

`docs/HOW-THE-BOT-THINKS.md`: the full candles -> indicators -> patterns ->
entry rule -> Judge -> sizing -> exit-levels -> exit-checking pipeline, one
worked example per step, reusing tonight's own hand-worked numbers
(the exhaustion reversal / level-based exit example from
`test/paperCryptoLevels.test.js`) rather than inventing new ones.

This is the 5th merge tonight - the cap the brief set (every merge restarts
the live bot). No more merges from this session after this one; anything
else found stays in this file for the next session or the owner.

If another overnight session picks this up: start with item 3 (exit
accuracy, checking every candle's high/low since the last check) since it is
the most isolated correctness bug and the brief itself calls it out
separately from the bigger judge/SMC rework.

## Item 4 - ignore levels closer than 1xATR14(15m) - crypto only (PR follows exit-sim)

`paperbot/cryptoLevels.js` `planTrade`: added `opt.minLevelDistAtr` (default
1). The target-candidate list is now split into "any level beyond the
entry" (used for the existing "no level found" message, unchanged) and
"levels at least `minLevelDistAtr x ATR14(15m)` from the entry" (used to
pick the actual target - skips a too-close level for the next one out, and
fails with a new, explicit reason, never a silently wrong trade, when every
level is too close). Default of 1x ATR does not change the target picked in
either existing hand-worked test (`test/paperCryptoLevels.test.js`) - both
nearest levels in those fixtures are already 1+ ATR away - so this is a pure
addition, not a behaviour change, for every trade taken so far. 2 new
hand-worked tests (one where a 2x-ATR minimum does change the pick, one
where every level is excluded); full suite 210/210.

**NSE exits are NOT made level-based tonight** (second half of item 4: "NSE
exits become level-based like crypto"). NSE trades the OPTION premium, not
the underlying directly - turning an underlying price level into a target
premium needs the same simulated-delta translation `simOptionPrice` already
uses for a missing real option price, done carefully enough to size the
`legacy_*` A/B columns correctly, and that is a change to the actual NSE
entry/exit path (`paperbot/bot.js` `nseScan`/`nseMonitor`), not an isolated
addition like the crypto one above. Left for a dedicated PR with its own
hand-worked tests.

## Item 5 - EMA crossover (done: storage + wiring; report split deferred)

`src/paper/lib/emaCross.js`: `emaCrossState(candles, fastN, slowN)` (is the
fast EMA above/below the slow one, and did that side just change between the
last two closes - a "fresh" cross) and `classifyEmaCross({direction, c5,
c15, c1h})`, which combines the 5-min EMA9/21 (primary) with the 15-min and
1-hour EMA20/50 into one label: `fresh_with` / `fresh_against` (a cross just
happened, with or against the trade) / `confirmed_with` / `confirmed_against`
/ `mixed` (no fresh cross; a majority of the three timeframes agree or
disagree, or split evenly) / `unknown` (not enough 5-min candles - never
guessed). Exactly the brief's rule: a fresh cross *for* the trade is a
strong confirmation, a cross *against* is a warning, neither ever blocks or
changes an entry/exit by itself.

Wired into `paperbot/bot.js`'s shared `analyse()` (used by both NSE and
crypto), so every trade AND every skip row gets `ema_cross` - a new,
additive, nullable `text` column on `paper_trades` and `paper_skips`
(`sql/paper_bot.sql`, `npm run migrate` needed). Direction used for a
skipped setup (patterns fired but the entry rule said no) falls back to the
first pattern's own direction, since `decision.direction` is only set when
the bot actually enters.

10 hand-worked tests for the pure functions (small fastN/slowN so the EMA
arithmetic is checkable by hand - the production call site still uses the
brief's real 9/21 and 20/50 periods, the combining logic under test does not
change with the period) plus one wiring test (a real `cryptoScan()` stores
some valid label on the trade it opens). Full suite: 228/230 passing as merged - the 2 failures
(`test/newsCheck.test.js`, `test/opsHome.test.js`) pre-exist on `main` before
this change (confirmed by stashing this diff and re-running them: they fail
identically on plain `main`), in files under `src/paper/context/` and
`src/paper/ops/` owned by other windows tonight. Not touched or caused by
this PR; flagging rather than silently ignoring.

**Not done tonight: "report win rate with and without it."** That is a
`paperbot/report.js` / `reportPage.js` aggregation change (group closed
trades by `ema_cross`, compute win rate per group) on files already carrying
a lot of other sessions' report logic (R-factor, judge, scalp costs) - a
real but separable follow-up now that the data itself is being recorded. No
report change was made, so nothing there could have broken.

## Item 3 - exit accuracy - half done, on purpose

`src/paper/lib/exitSim.js` (`simulateExit`): walks every closed candle since
the last check (oldest first), checks the stop and the target against each
candle's high AND low (not only the latest tick), moves the stop to the
entry once the chosen fraction of the way to the target is covered by a
candle's favourable extreme (not its close), and books the stop when one
candle's range reaches both levels (OHLC alone cannot say which came first,
so the brief's rule - assume the worse outcome - is followed). 8 hand-worked
candle-walk tests, all passing; full suite 199/199.

**Deliberately NOT wired into `paperbot/bot.js`'s `cryptoMonitor` tonight.**
Reason found while building it: `cryptoMonitor` today reads one live tick
price per open trade per minute (`crypto.price(symbol)`) and the existing
test rig (`test/paperCryptoLevels.test.js` `rig()`/`at()`, and the replay
test) drives it entirely through that tick - `at(101)`, `at(100.6)`, `at(100.1)`
- without adding matching candles to the fixed candle set each step. Swapping
the monitor's exit check over to candle highs/lows, as item 3 asks, would
make those hand-verified tests assert against the wrong thing (the fixed
candle set, not the walked tick price) and they would need to be rebuilt
alongside the monitor change, in the same PR, to stay honest. That is a
second, larger, riskier piece of work on a trading-decision path I was not
willing to rush through in the time left before 04:00 IST without it being
reviewable on its own. The pure function is finished, tested and ready;
wiring it in is the next PR, done together with rewriting that test rig
(build per-tick candles consistent with the walked price, not just the price
alone) - not something to split across two uncoordinated merges.

## Round 2 (18:20-22:30 UTC, same 14-15 Nov night) - merge cap raised to 4

### Item 2 - SMC/ICT detectors, src/paper/lib/smc/ (PR, merged FIRST as asked)

6 files: `structure.js` (BOS/CHoCH - prior trend from `trendOf`, excluding the
breakout candle itself, against the most recent swing high/low from `prior`
only - never the candle being judged), `liquidity.js` (equal highs/lows
pools, clustered within a tolerance %; re-exports the existing
`liquiditySweep` and `previousPeriods` rather than duplicating them),
`orderBlocks.js` / `fvg.js` (re-export the existing detector + level-list
pairs under one SMC namespace), `premiumDiscount.js` (50% of the recent
range), `displacement.js` (body vs. the average of the candles before it),
`sessions.js` (crypto: Asia/London/New York by UTC hour, a documented
simplifying assumption of non-overlapping bands, not a claim about real
session overlap; NSE: open_drive/lunch/mid_session/close by IST minute,
reusing `istParts`). One hand-worked test per detector (`test/paperSmc.test.js`,
15 tests) plus a wiring test for the combined `tagSmc()`.

Wired into `paperbot/bot.js`'s shared `analyse()`: `smc_tags` on every trade
AND skip now (previously trades only got the kind==='smc' entry patterns,
skips got nothing) - new additive `paper_skips.smc_tags` column
(`npm run migrate` needed). Purely informational, like `ema_cross` - nothing
in `tagSmc()` feeds an entry/exit decision. `tagSmc()` wraps every detector
in try/catch so one failing on short data just shortens the tag list, never
crashes a scan.

Full suite: 292/295 - the 3 failures (`newsCheck`, `opsCookieAuth`,
`opsHome`) all pre-exist on `main` before this PR (confirmed by stashing
this diff); CC4's folders, not touched here, not CC2's to fix per this
round's brief.

### Item 1 - wire exit accuracy into the LIVE crypto monitor (NSE deferred)

`paperbot/bot.js` `cryptoMonitor()`: the level-based exit branch now fetches
every closed candle since the trade's entry (`crypto.candles(symbol)`,
`closedOnly`) and runs `simulateExit()` (`src/paper/lib/exitSim.js`, built
last round, not wired in until now) instead of checking a single tick
against `manageTrade()`. Walked fresh from the entry every call, using the
ORIGINAL stop (`sl_price`) - idempotent and deterministic, so re-checking
never changes a past decision. A breakeven move or an exit found by the
walk is written the same way as before (`stop_active`, `breakeven_time`,
`closeTrade`). The legacy fixed-rule branch (for trades opened before
levels existed) is untouched in behaviour, only refactored to share the
same `reason`/`exitPrice` variables.

**Bug found while updating the test rig, fixed, not just worked around:**
the refactor of the legacy branch first had a missing `continue` after
`track()` on a non-exit tick - every legacy-rule trade would fall through
into `closeTrade()` with `exitPrice: null` on its very next check,
regardless of price (`test/paperCryptoLevels.test.js`'s "old fixed rule, no
levels stored" test caught this immediately: the trade closed at the FIRST
check instead of the second). Added the missing `continue`; the test is
what caught it, exactly as the VERIFY loop is for.

Test rig rewrite (`test/paperCryptoLevels.test.js` `rig()`/`at()`, never
deleted, all 15 tests in the file still present and passing): `at(spec)` now
appends a real CLOSED 5-minute candle (a flat "doji" `[spec,spec,spec,spec]`
unless a `[o,h,l,c]` tuple is given) and runs `cryptoMonitor()`, instead of
only setting a tick price - the real unit the new mechanism checks against.
New hand-worked numbers follow from this: a stop/target is now booked AT
THE LEVEL, never at the tick/candle close that merely crossed it (e.g. the
stop test's exit price changed from 103.2 - the tick that triggered it - to
103.12, the stop level itself; pnl from -292.82 to -269.85). The breakeven
test now books at EXACTLY the entry price for a true zero P&L, where the
old tick-based version booked at whatever price happened to be showing
(-5.74), which was never really what "breakeven" was supposed to mean.
`test/paperReplay.test.js`'s crypto stop test had the exact same
tick-without-a-candle gap and needed the same fix (push a real candle, not
just set the mock's `price` variable) plus the same new numbers; both the
main summary line and the per-pattern line were updated in that file too.

**NSE monitor is NOT wired to candle-accurate exits.** NSE trades the
OPTION PREMIUM (real quote or simulated from the underlying's spot move via
`simOptionPrice`), which has no OHLC candle history of its own to check
highs/lows against - that would need the underlying's candles translated
through the same delta formula into a premium range per candle, which is
exactly the level-based-NSE-exits work (item 4's still-deferred second
half) done PROPERLY, not a shortcut bolted onto the exit checker alone.
Noted again here so it does not get lost between rounds.

Full suite after this item: 292/295 (same 3 pre-existing CC4 failures as
the SMC PR above, confirmed unrelated).

### Item 3 - Judge v2, a PARALLEL scorer (PR)

`src/paper/decision/judge2.js`: weights R factor 25, pattern 25, SMC/levels
15, EMA/trend 10, sector 10, news/event 10, time/session 5 (sums to 100).
Reuses judge.js's individual scorers (`scoreR`, `scorePattern`, `scoreSector`,
`scoreNews`, `scoreTrend`, `scoreTime` - newly exported from `judge.js`,
additive, nothing existing changed) rather than duplicating them, and adds
two new ones: `scoreSmc` (counts `smc_tags` aligned with vs. against the
trade's direction - BOS/CHoCH/order-block/FVG/liquidity-sweep tags by
`_up`/`_down` suffix, `premium`/`discount` by zone) and `scoreEmaTrend`
(maps `ema_cross`'s label to a fraction). Take at 65+.

**Rescaling is deliberately different from judge v1.** v1 gives an
unavailable helper HALF its points, inside the full weight pool. v2
EXCLUDES a helper that does not apply or answers null, and rescales the
REMAINING weights to sum to 100 - the brief's literal wording for this
round. Sector and news are always excluded for crypto (there is no sector
or news concept for a coin); SMC and EMA/trend are excluded when no tags /
no cross reading exist. `time` is NOT excluded for crypto (it trades round
the clock, which is a legitimate neutral 0.5, not "does not apply" -
judge.js's existing convention, reused as-is).

Wired into the shared `analyse()` (both NSE and crypto, every trade and
skip) - new additive, nullable `judge2_score` / `judge2_take` /
`judge2_contributions` / `judge2_basis` columns on BOTH `paper_trades` and
`paper_skips` (`npm run migrate` needed). **Never read by any entry/exit
code** - `nseScan`/`cryptoScan` still only consult the live `judge`
(judge.js) or the pattern/trend entry rule; judge2 is logged for the report
to show both side by side (item 5, not yet built this round - see below).

**Known limitation, documented rather than hidden:** for crypto, the real
reward/risk (`plan.rr` from `cryptoLevels.planTrade`) is only computed
AFTER `analyse()` returns, inside `cryptoScan`. Passing the crypto momentum
score off as "R factor" would be dishonest, so `r_factor` is left `null`
(excluded, rescaled) for every crypto judge2 score this round. A future
pass could move the judge2 call to after `planTrade()` in `cryptoScan` to
give crypto its real R too - noted for the next session, not done tonight
given the time left.

4 hand-worked tests (`test/paperJudge2.test.js`): full-weights NSE case,
crypto rescale case (sector/news/smc/ema_trend all excluded), no-direction
case, hard-block case. Full suite: 313/316 (same 3 pre-existing CC4
failures).

### Items 4 & 5 - shadow tracking + report additions (PR, bundled: last merge this round)

**Item 4 (shadow tracking).** `paper_shadows` (new table, idempotent) and
store methods (`insertShadow`, `updateShadow`, `openShadows`, `listShadows`)
on both the memory and Postgres stores. Wired into `cryptoScan`: when
`cryptoLevels.planTrade` rejects a setup for reward/risk but still returns
a `plan` (entry/target/stop were computable), a shadow row is inserted with
that hypothetical entry/target/stop. A new `shadowMonitor()` on the bot
(own cron tick, `40 */5 * * * *`, same cadence family as the crypto
scan/monitor) follows every OPEN shadow the same way the real monitor does
- `simulateExit()` (`src/paper/lib/exitSim.js`, item 1's function, reused
again) against every closed candle since the shadow's entry - and closes it
with `outcome: 'target'|'stop'` and `result_pct`. Never written to
`paper_trades`, never read by any entry/exit decision; 5 hand-worked tests.

**Scope limitation, by design:** only crypto's reward/risk-rejected setups
are shadowed this round (the ones with a real plan already computed). A
setup rejected earlier - no level found, not enough candles, the pattern
disagreeing with the trend, a Judge/Judge-v2 "not taken" - has no
entry/target/stop to follow without first building one just for the
shadow, which is a bigger, separate piece of work. NSE is not shadowed at
all (same reason item 1 didn't reach NSE: no level-based target/stop there
yet).

**Item 5 (report additions).** `src/paper/decision/report2.js`: `ablation2()`
(judge.js's `ablation()` convention, for `judge2_contributions`/`HELPERS2`
instead), `shadowSummary()` (target vs. stop hit counts, would-have-won %,
average result %), `emaCrossWinRate()` (win rate of closed trades with a
`fresh_with`/`confirmed_with` EMA cross vs. everything else). 4 hand-worked
tests. New read-only route `GET /api/paper/report2` (same
`PAPER_ADMIN_SECRET` convention as the existing admin routes) returning
judge2 contributions per trade (both markets) alongside the live judge's
score for comparison, the ablation table, the shadow summary and the EMA
cross win rate - all JSON, so the existing HTML `renderReport`
(`paperbot/reportPage.js`, already a large file several sessions have
touched) was not touched at all, to keep this additive and low-risk. A new
`GET /api/paper/shadows` admin route (same convention as `/trades`,
`/skips`) lists shadow rows directly.

**Not live-HTTP-tested** (noted honestly, not hidden): this sandbox has no
`node_modules` installed (`express` etc. are not resolvable here), so the
route itself could only be verified by (a) `node -e "require('./paperbot/index.js')"`
loading without a syntax/reference error, and (b) the pure functions it
calls being independently unit-tested. The route body is a thin,
unconditional pass-through to those tested functions plus two already-used
store methods (`closedTrades`, `listShadows`) - say "not verified live" per
the brief's instruction for anything the sandbox cannot reach.

Full suite after both items (before the test-file-rename fix below): 372/376 - 4 pre-existing CC4 failures (newsCheck, opsCookieAuth, opsHome, and opsCsvExport which landed on main while this PR was in progress), confirmed unrelated by stashing this diff and re-running on plain main.

## Round 2 summary

4/4 merges used (cap for this round): #38 SMC detectors, #40 wire
exit-sim + bug fix, #44 Judge v2, and this bundled item 4+5 PR. All 5
numbered items touched; none fully "live-wired end to end" for NSE (items
1, 4's NSE half, and the second half of round 1's item 4 all wait on
level-based NSE exits, which nobody has built yet) - flagged consistently
across both rounds rather than re-explained per item. VERIFY loop: full
suite green apart from the 4 pre-existing CC4 failures above; re-read every new
candle-reading code path in this round for look-ahead (`classifyStructureBreak`
excludes its own candle from the swing/trend calculation; `tagSmc`/`simulateExit`
only ever receive `closedOnly`-filtered candles) - found none beyond the
legacy-branch `continue` bug already described and fixed above.

**Collision caught and fixed before committing:** another window (CC3)
had already merged its own, unrelated shadow-tracking feature for the
scalp bots (`src/paper/shadow/store.js`, table `shadow_setups`) - a
different implementation, but it happened to use the exact same test file
name, `test/paperShadow.test.js`. Rebasing this branch onto the latest
`main` and popping my stashed (then-untracked) file of the same name
silently OVERWROTE CC3's test file in my working tree instead of
reporting a conflict (git applies a stashed *untracked* addition as a
plain file write, with no 3-way merge, when the path already exists).
Caught by checking `git log -- test/paperShadow.test.js` before committing
and noticing a commit I didn't recognize. Fixed by restoring CC3's file
from `origin/main` byte for byte and moving my own tests to
`test/paperCoreShadow.test.js` instead - no code in `paperbot/store.js`,
`sql/paper_bot.sql` or any route actually collided (my table is
`paper_shadows`, theirs `shadow_setups`; checked every shared file by hand
for a second `insertShadow`/`openShadows` definition before concluding
that). Full suite with both test files present: 380/384 (same 4
pre-existing CC4 failures).
