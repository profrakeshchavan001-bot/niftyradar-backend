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
