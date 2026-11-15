# Task Group A - NSE Monday 16 Nov 2026 readiness

PAPER ONLY, no order code touched, Supabase-only (no Neon), free-tier only. This log records what was
found already done vs. what was actually built, same convention as `docs/decisions/CC2.md` etc.

## 1. Real R-factor wired into the live NSE ranking - already done, verified, no change made

Checked `paperbot/bot.js` `rankNse()`: every candidate is scored with the real risk-reward R
(`paperbot/rfactor.js` `rFactor()`, docs/R-FACTOR.md) and `R.rankByR()` sorts **by that R, best
first** - the old "% move" placeholder (`legacyRf`) is only carried alongside for comparison
(`legacy_rf`, `r_detail.legacyRank`, `inLegacyTop`) and ties, never the primary sort key, and never
read by any entry decision. No placeholder ranking exists anywhere in the live NSE decision path.
Nothing changed here - redoing already-finished work was explicitly out of scope.

## 2. Exhaustion-reversal rule - gap found on the NSE path, fixed there only

The owner's rule, as given for this task, needs a confirming SECOND green candle before entry (the
first green candle closing above the small red candle's high only starts the reversal; the signal is
the second green candle closing above the first one's high - mirror for a short). The existing
`exhaustionReversal()` in `paperbot/patterns.js` only required the FIRST green candle - that is a real,
documented, deliberate rule for the crypto bots (`docs/SCALP.md`, `docs/BOTS.md`, `exhaustion_only`),
but it does not match the stricter rule this task describes, and NSE was using the exact same function
through the shared `detectPatterns()` list.

Fixed additively, NSE only:
- `paperbot/patterns.js`: new `exhaustionReversalConfirmed()` (same trend/VWAP/small-body checks, one
  extra confirming candle) and `DETECTORS_NSE` (the same detector list, with this swapped in for
  `exhaustionReversal`). `detectPatterns()` takes an optional `variant` ('default', unchanged, or
  'nse'). `exhaustionReversal()` itself is untouched - every crypto bot that uses it (scalp,
  scalp_wide, `exhaustion_only`, the main crypto bot's own `detectPatterns()` call) behaves exactly as
  before.
- `paperbot/bot.js`: `analyse()` now passes `variant: market === 'nse' ? 'nse' : 'default'` - the only
  wiring line changed.
- Both write the same pattern name (`exhaustion_reversal`), so the Judge's existing `pattern_strength`
  weight (0.8) and every report/leaderboard grouping by pattern name need no change.
- Updated the existing hand-built fixtures (`test/fixtures/make-paper-replay.js` +
  `test/fixtures/paper_replay.json`) to add the second confirming candle (one fewer drift candle to
  keep the session at exactly 75 five-minute bars) and re-worked every dependent assertion in
  `test/paperReplay.test.js` and `test/paperYahoo.test.js` (entry time now one candle later, 11:10
  IST instead of 11:05; everything downstream - R factor, exit numbers - recomputed and verified by
  actually running the updated fixture through the real bot, not retyped by hand blind).
- New unit tests in `test/paperPatterns.test.js` for `exhaustionReversalConfirmed()` and the
  `detectPatterns()` variant switch (both directions, both the "not yet confirmed" and "confirmed"
  cases, and proof the single-candle rule is still exactly what crypto gets).

## 3. SMC/ICT + news/sector wiring into the Judge, for NSE

**News and sector: already fully wired, verified, no change needed.** `src/paper/decision/judge.js`'s
`defaultHelpers()` loads `../context/sector` (CC4) and `../context/news` (CC3) and calls them with the
candidate's own symbol; `paperbot/bot.js`'s `nseScan()` calls `createJudge({ config, ...judgeHelpers })`
with no `sectorView`/`newsScore` override, so the real modules answer for every real NSE candidate.
Confirmed end to end in the new Monday session test below (the stubbed helpers are asked with
`'TESTSTK'` exactly once each, proving the live wiring, not just that the functions exist).

**SMC/ICT tags: real gap, left open on purpose, not silently redesigned.** `tagSmc()`
(`src/paper/lib/smc`) already runs for every NSE trade/skip and is stored (`smc_tags`) - but it feeds
only `judge2.js`, the explicitly **parallel, never-live** scorer (docs/decisions/CC2.md round 2, item
3), not the live Judge that `nseScan()` actually uses. Adding a new `smc` helper to the LIVE Judge
means changing its weight scheme (currently 25/25/20/10/10/10, ~20 hand-worked tests in
`test/paperJudge.test.js` pin those exact numbers) - a real, consequential change to a live
money-adjacent decision path. CC2 explicitly declined to do this kind of reweighting unattended
("Item 7 as written would replace that scheme; flagging here rather than quietly picking one on a
night with no owner awake to ask", docs/decisions/CC2.md). Same reasoning applies here: this is a
bigger, separate change than "Monday readiness" needs, and the order-block/liquidity-sweep/FVG-retest
SMC patterns are already scored through the existing `pattern_strength` table (`scorePattern()`) for
NSE, so SMC is not entirely absent from the live decision - only the extra informational tags
(BOS/CHoCH, premium/discount, displacement, sessions) are judge2-only. **Needs the owner**: say if the
live Judge should get its own `smc` weight (and what to subtract it from), or stay as is.

## 4. Full Monday session dry run (fake clock + fixtures)

`test/paperMondaySession.test.js` (new): simulates the whole 09:15-15:30 IST session, minute by
minute, with a fake clock and hand-built fixture candles (no network), through the REAL
`createBot()` - the owner's confirmed exhaustion rule, the real R-factor ranking, the live Judge
(`judgeOn: true`) with sector/news helpers that are proven to be asked for the real symbol, and SMC
tags stored on the trade. Three tests:
- a trade OPENS (on the second confirming candle, not the first), is TRACKED (`max_fav_pct` grows
  while open, checked at more than one point in time, not just the final row) and CLOSES (target hit,
  with the exact P&L);
- the first green candle alone never opens a trade (proves the confirmation really gates entry);
- a flat option price still forces an EOD exit at 15:15, inside the session.

All of it is deterministic, no live network (same "fixtures, not live" convention as the rest of
`paperbot/`/`src/paper/`), and runs under plain `npm test` (`node --test test/*.test.js`).

## Needs the owner

- Say if the live Judge should score SMC/ICT tags directly (see point 3) and, if so, what weight and
  what it comes out of.
- Watch the first real Monday session on Render: the free Yahoo fallback (`docs/PAPER-BOT.md`) is
  used automatically whenever Dhan has no candles or quotes; the delay shown on the entry log line
  and the trade's `data_delay_sec` is the thing to check first if entries look late.
