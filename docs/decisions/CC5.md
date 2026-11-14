# CC5 overnight decisions (replay engine, src/paper/replay/ only)

Branch `claude/cc5-replay-engine`. PAPER ONLY, no order code, Rs 0, no paid service. `PAPER_DATABASE_URL`
only, never `DATABASE_URL`. Lane: `src/paper/replay/` only (plus one wiring line in `paperbot/index.js`, one
new `sql/replay.sql`, and `docs/REPLAY.md`).

## Decisions

1. **No CC2/CC3/CC4 interface to plug into.** The brief described a `decide(candles, context)` plugin loader
   (`src/paper/lib/`, `docs/BOT-INTERFACE.md`) being built tonight by other windows. Checked: it does not
   exist anywhere — not on `main`, not on any of the 24 remote branches (`cc2/judge`, `cc2/judge-v2`,
   `cc2/scalp`, every `claude/cc*` branch). Confirmed with the owner (mid-session) and told to build against
   the real, already-live code instead: `paperbot/engine.js` (`decideEntry`) and, as the actual target,
   `src/paper/scalp/engine.js` (`analyse`/`evaluateExit`/`settle`, merged in PR #21). The scalp engine already
   matches the brief's numbers almost exactly (0.1% fee/side + 0.03% slippage, 2% risk, BTCUSDT/ETHUSDT/SOLUSDT,
   `min_trades_for_conclusion: 20`), so it is the real target, not a stand-in.
2. **This repo's own `docs/overnight/CC5.md` is from a past, unrelated night** (`tools/india_edge/scores`, a
   Python NSE scoring engine). The owner said to ignore it; this file is the real log for tonight.
3. **Every decision function is imported, never copied**, per the brief and `docs/REPLAY.md`. Where that rule
   makes a full filter ablation impossible (the trend/VWAP agreement check and the pattern/SMC-tag list are
   hard-coded inside `analyse()`, not config knobs), the report says so and gives a descriptive breakdown
   instead of a fake on/off switch. See `docs/REPLAY.md` "Filter study".
4. **In-sample/out-of-sample split is done by splitting the resulting trade list**, not by re-running the
   simulator on two separate windows, so the out-of-sample segment is not given a fake warm-up restart that
   the live bot would not have. See `docs/REPLAY.md`.
5. **Random-entry baseline** reuses the live `evaluateExit()`/`settle()` with a fake entry (random time,
   random direction, stop%/target% resampled from the real strategy's own trades) rather than reimplementing
   exit logic a second time.
6. **Binance is blocked from this sandbox** (checked once: `curl` to `data-api.binance.vision` returns a proxy
   403, as the brief expected). Everything is tested against fixture candle files
   (`test/fixtures/replay/`); `docs/REPLAY.md` and the PR say "not verified live" plainly.
7. **Replay's own database tables** live in `sql/replay.sql` (own file, idempotent, never edited `sql/paper_bot.sql`)
   and are created lazily on first use, same pattern as `paperbot/store.js`. A second `pg.Pool` (max unspecified
   by the owner's cap for this lane) is opened only if `PAPER_DATABASE_URL` is set; without it, replay runs
   in-memory only (lost on restart), same fallback behaviour as the rest of the paper bot.
8. **Config**: the replay engine reads the live scalp config via `loadScalpConfig(liveStore)` (so an owner
   change in `paper_config` is honoured), falling back to `SCALP_DEFAULTS` only if the live store could not be
   built.
9. **Scope cut, stated plainly**: this PR wires up the **scalp** strategy only (`src/paper/scalp/`). The
   brief's "intraday crypto" bot (`paperbot/engine.js` + `paperbot/cryptoLevels.js`, 5-minute scans, level-based
   exits) is not adapted yet — it is a second, independent adapter and was not reached tonight. Also not
   reached: 90-day history, NSE/Yahoo replay, and the stop/target parameter sweep (all listed as "if time
   allows" in the brief).

## Findings (fixtures only — planted patterns, not evidence of a real edge)

Recorded in the PR description once the full local test run (hand-verified candle sets) and the fixture-based
history/simulator run are both green; not duplicated here to avoid getting out of sync with the PR.

## Update (after rebasing onto main)

CC2's interface landed since decision 1 above was written: `docs/BOT-INTERFACE.md`, `src/paper/lib/`
(shared indicators/levels/exitSim, re-exporting `paperbot/patterns.js`/`rfactor.js`/`cryptoLevels.js`), and
`src/paper/pluginLoader.js` (auto-loads `src/paper/{bots,ops,replay}/*/register.js`). Checked `src/paper/bots/`
on main after rebasing: **empty, nothing from CC3 yet**, so there is no `decide(candles, context)` bot to
adapt tonight. This PR's wiring (one explicit line in `paperbot/index.js`) keeps working unchanged alongside
the new plugin loader (the loader simply finds nothing under `src/paper/replay/*/register.js`, since this PR
put its files directly in `src/paper/replay/`, not a subfolder with its own `register.js`). Converting to the
plugin-folder shape is a clean follow-up, not done tonight to keep this PR's diff to the replay logic itself;
noted for whoever picks this lane up next. Will keep checking `src/paper/bots/` as instructed.

## Needs Rakesh

- Confirm on Render, after the next deploy, that `/api/paper/replay-report` shows real numbers and the
  look-ahead check passes on real Binance history (this was never reachable from the sandbox tonight).
- Decide whether the "intraday crypto" (paperbot/engine.js) adapter should be CC5's next lane or another
  window's, since it is a second surface with its own level-based exit rules (`paperbot/cryptoLevels.js`).

---

# Round 2 (three more adapters, live-bot safety guard, bigger filter study)

Branch `claude/cc5-adapters-round2`, rebased on `origin/main` after it picked up `exhaustion_only` (CC3),
the shared `src/paper/lib/exitSim.js`/`emaCross.js` (CC2) and `/api/paper/health` (CC4).

## Decisions (round 2)

1. **scalp_wide, exhaustion_only, intraday_crypto all adapted** this round (item 1). scalp_wide and
   exhaustion_only reuse their own live `decide`/`analyseWide`/`evaluateExit`/`settle` with no new logic,
   only window-shaping. intraday_crypto composes real pieces into the `decide(candles,context)` shape; two
   deliberate differences from the live bot (candle-accurate exit instead of tick-based, and the brief's
   uniform cost model since the live bot's own P&L has none) are documented plainly in `docs/REPLAY.md`
   rather than silently changing the numbers.
2. **Generic adapter layer added** (`scanDecideSignals`/`resolveDecideTrade`/`replayDecideBot`/
   `replayRandomGeneric` in `simulator.js`) so **trend_smc, when it lands, needs only a small adapter file**
   like `adapters/exhaustionOnly.js` -- no new simulator or look-ahead code. Checked `src/paper/bots/` again
   after this round's rebase: still only `exhaustion_only`; will keep checking every ~30 min as instructed.
3. **Live-bot safety guard** (`safety.js`, item 2): the 02:00 IST automatic run is skipped (never started,
   just logged) when `src/paper/ops/health.js`'s own `buildHealth()` would report `PROBLEM`, or when this
   process's RSS is over 400 MB (Render Free is 512 MB). A manual run is never blocked. The round-1 "also run
   once on startup if the code changed" trigger is **removed**: the round-2 brief narrows automatic runs to
   "02:00 IST and manual start" only, so that extra trigger would now be out of scope.
4. **Filter study extended** (item 3) with a real with/without split per SMC tag and an EMA-cross breakdown
   using the real `classifyEmaCross()`, recomputed per trade from the stored 5-minute history at its own
   entry time. Both stay descriptive, not a true ablation, for the same reason as round 1's pattern
   breakdown: neither is a config knob or a hard block in the live `decide()` functions.
5. **Report + health export** (item 4): `/api/paper/replay-report` now shows a last-run line (run id,
   trigger, status, started, candles loaded, runtime) and a row per strategy; `attachReplay()` now returns
   `getLastRunStatus()` (also exported as `lastRunStatus`) for the health page to call directly, without
   touching `src/paper/ops/health.js` myself (staying in my own folder, per the rules).
6. **Per-strategy live config**: scalp_wide and exhaustion_only read their config from the main paperbot
   store the same way the live bots do (`loadScalpWideConfig`, `loadExhaustionConfig`); intraday_crypto reads
   `paperbot/config.js`'s `DEFAULTS.crypto`/`DEFAULTS.patterns` the same way, with the uniform cost fields
   layered on top (see item 1). Falls back to each strategy's own defaults if the live store is unavailable.
7. **Binance still unreachable from this sandbox** (not re-checked this round; round 1's result stands).
   Everything tested against the fixtures in `test/` and synthetic candle generators; not verified live.

## Needs Rakesh (round 2)

- Same as round 1: watch the first real Render run (`/api/paper/replay-report`) and the look-ahead result on
  real Binance history.
- Decide who owns wiring `lastRunStatus()` into `src/paper/ops/health.js` (CC4's file, not touched here).
- `trend_smc`: once it lands, point its own decide/evaluateExit/settle at `adapters/` following
  `exhaustionOnly.js`'s pattern -- should be a small follow-up, not a new engine change.
