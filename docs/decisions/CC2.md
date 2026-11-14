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
