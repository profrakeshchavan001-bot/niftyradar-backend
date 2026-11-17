# Bots (paper only)

Several independent paper-trading strategies run side by side, each with its own virtual money, its own record, and its own report, so we can
see which logic really works. The shared interface every bot follows: `docs/BOT-INTERFACE.md`. This file documents, in plain words, exactly
what each bot does and does not do, with one worked example each.

Four bots exist: `scalp`, `scalp_wide`, `exhaustion_only` and `trend_smc` (added in round 2, once CC2's `src/paper/lib/smc/` landed -
see `docs/decisions/CC3.md`). Every skip whose reward/risk gate was the only thing that turned it down is **shadow-tracked**: followed
on paper to its would-be stop or target, never counted as a trade. There is now a cross-bot leaderboard and a suggestions-only "mix".

## scalp (`src/paper/scalp/`, docs/SCALP.md)

Crypto only (BTCUSDT, ETHUSDT, SOLUSDT). Entry on closed **1-minute** candles: one of exhaustion reversal, engulfing, hammer/shooting
star, liquidity sweep, agreeing with the 5-minute trend or VWAP side (exhaustion reversal exempt). Target = the nearest opposite level,
capped at 0.5%, floored at 0.3%. Stop = beyond the pattern candle + 0.5 x ATR14(1m), capped at 0.3%, floored at 0.05%. Breakeven at 50% of
the way to target. Time stop 15 minutes. Reward/risk after the 0.23% round-trip cost must be at least **1.0** (fixed tonight; was 1.3,
which the 0.5% target cap could almost never clear). Own 1,000 USDT, market `crypto_scalp`.

**Worked example:** 32 one-minute candles fall from 102.00 to 100.40 (0.05 each), then a small red candle (100.40→100.39) and a green
candle closing at 100.44 above the small one's high (100.405) - a bullish exhaustion reversal, entry 100.44. ATR14(1m) works out to
0.092143; stop = 100.44 − (0.06 + 0.5 × 0.092143) = 100.333929 (0.1056% away). No swing high nearby, so the target is the day's high, far
enough away to hit the 0.5% cap: 100.9422. Reward/risk after the 0.23% cost = (0.5 − 0.23) / (0.1056 + 0.23) = **0.8**, below 1.0 -
**skipped**, logged with those exact numbers. (This is why `scalp_wide` exists.)

## scalp_wide (`src/paper/scalp/engine.js` `analyseWide`, docs/SCALP.md)

The same coins and the same five patterns, but slower: entry on closed **5-minute** candles, trend from **15-minute** candles (built
from the 5-minute ones). The target must be the nearest opposite level, but that level must be at least **0.8% AND at least 1 x
ATR14(5m)** away (whichever is larger) or there is no room and the setup is skipped; when there is room, the target IS the level (no
margin held back). Stop = beyond the pattern candle + 0.5 x ATR14(5m), capped at 1.5%, floored at 0.1%. Breakeven at 50%. Time stop 45
minutes. Reward/risk after costs must be at least **1.0**, same floor, same reasoning (a trade that cannot pay its own costs is not
logical). Own 1,000 USDT, own market `crypto_wide_scalp` (note the suffix - it must end in `_scalp` for the existing intraday/judge
exclusion to apply, see `docs/decisions/CC3.md`).

**Worked example:** the identical candle shape as the scalp example above, just 5 minutes apart instead of 1 - same entry (100.44), same
stop maths (0.1056% away, 100.333929). The only level is a 15-minute swing high 102.025, 1.585 away = 1.578057%, which
clears both the 0.8% floor and 1 x ATR (0.0917%) easily, so the target IS 102.025 (no margin held back). Reward/risk after the 0.23% cost
= (1.578057 − 0.23) / (0.1056 + 0.23) = **4.02** - this one *trades*, which is the whole point of the wider variant.

## exhaustion_only (`src/paper/bots/exhaustion_only/`, a plugin under `src/paper/bots/`)

The owner's own rule, measured alone: in a falling move (**4 or more of the last 6 candles red, price below VWAP**) a small red candle
followed by a green candle closing above its high means **LONG**; the mirror in a rising move means **SHORT**. 5-minute candles. **No
other pattern, no trend filter** - this is reused directly from `paperbot/patterns.js`'s `exhaustionReversal()`, which implements exactly
this rule and nothing more (so a second condition cannot quietly sneak in). Target and stop are level-based, via the shared
`src/paper/lib/levels.js` `planTrade()` (the same function the main crypto bot uses): target = the nearest opposite level 0.1% before it,
stop = beyond the pattern candle + 1 x ATR14(15m). Reward/risk after the 0.23% cost must be at least **1.2**. No breakeven, no time stop
(the brief gives this bot neither - it is level-based exits and nothing else). Own 1,000 USDT, own market `crypto_exhaustion_only`, own
tables (`exhaustion_only_trades`, `exhaustion_only_skips` - not the shared `paper_trades`, so it cannot collide with another bot's market
CHECK constraint or another window's concurrent schema edit). Switch: `PAPER_EXHAUSTION_ENABLED` (default on). Auto-loaded by
`src/paper/pluginLoader.js` - nothing in `paperbot/index.js` or `server.js` needed to change.

**Worked example:** 6 of the last 6 five-minute candles are red and the price is below VWAP, then a small red candle (0.01 body, average
body 0.05) closes at 100.39, then a green candle closes at 100.44, above the small candle's high 100.405 - LONG, entry 100.44. With ATR14
of the 15-minute candles at exactly 1.0 and the pattern's own low at 100.38, the stop is 100.38 − 1 × 1.0 = **99.38** (1.0554% away). The
only level above the entry is a 15-minute swing high at 103; 0.1% held back gives a target of **102.897** (2.4462% away). Reward/risk
after the 0.23% round-trip cost = (2.4462 − 0.23) / (1.0554 + 0.23) = **1.72**, above the 1.2 floor - trades.

## trend_smc (`src/paper/bots/trend_smc/`, a plugin under `src/paper/bots/`)

5-minute entry, **15-minute/1-hour trend** (EMA20/50) - **trades only with the trend**; if the 1-hour side is known and disagrees with
the 15-minute side, skipped. Entry is either a **fresh** 5-minute EMA9/21 cross with the trend, or a retest of an order block / FVG
(`src/paper/lib/smc/`) in the trend's direction - both already encode "a structural break, then a retest", so no extra state is needed
between candles (`decide()` stays pure, docs/BOT-INTERFACE.md). Taken only in **discount** (longs) or **premium** (shorts) - the ICT
50%-of-range zone; equilibrium blocks both sides. Target = nearest opposite level beyond 1 x ATR14(15m), stop = beyond the order
block/swing + 1 x ATR14(15m) (same `planTrade()` every level-based bot uses). Reward/risk after the 0.23% round-trip cost must be at
least **1.5**. Breakeven at 50%. Own 1,000 USDT, own market `crypto_trend_smc`, own tables. Needs real 15-minute candles (EMA20/50
needs 51+ of them, more than `aggregate()` can build from a sane number of 5-minute candles), so it reads them from a small,
self-contained Binance 15-minute source in its own `register.js` - not the shared `paperbot/sources.js`.

**Worked example:** an order block (a red candle, then an impulsive green candle at least 2x the recent average body, retested by a
later candle that dips into the zone and closes back above it) retests at a candle closing 102.5, with the 15-minute EMA20/50 clearly
up and the price in the discount half of its recent range. Stop = the order block's own low (99.8) − 1 x ATR14(15m) (1.0) = **98.8**
(3.6098% away). The only level above the entry is a 15-minute swing high at 130; 0.1% held back gives a target of **129.87** (26.7024%
away). Reward/risk after the 0.23% round-trip cost = (26.7024 − 0.23) / (3.6098 + 0.23) = **6.89**, well above the 1.5 floor - trades.

## Shadow tracking (`src/paper/shadow/`, shared by scalp, scalp_wide, exhaustion_only and trend_smc)

A skip that still had a **full** entry/stop/target plan worked out - only the reward/risk gate turned it down - is followed on paper to
its would-be stop or target, in its own `shadow_setups` table, **never counted as a trade**. A skip with no plan at all ("not enough
candles", "no setup") has nothing to follow and is not shadowed. One shadow per bot+symbol+candle (a unique index makes this safe to
insert twice without duplicating). Resolved by each bot's own `evaluateExit()` - the same exit a real trade of that bot would have had,
including that bot's own breakeven/time-stop rules.

## Leaderboard (`src/paper/bots/leaderboard/`, a plugin): `GET /api/paper/bots-report` (+ `&format=json`)

One read-only leaderboard across **every** bot (intraday, scalp, scalp_wide, exhaustion_only, trend_smc, and each one's own
`-MIRROR` bot, below): trades, win rate, net INR
after costs, average win, average loss, max drawdown (largest peak-to-trough drop of the bot's own cumulative net P&L, in the order
trades closed), average time in trade, and cost as a % of gross. A bot under 20 closed trades is shown but marked "too few trades, no
conclusion" and left out of the ranked list. **A bot losing after costs is flagged plainly** (`lossAfterCosts`), never hidden. A daily
table says which bot's net INR was highest each day. Each bot's row expands to its 20 most recent closed trades with their basis text.
Reads straight from each bot's own store (the shared `paper_trades` for intraday/scalp/scalp_wide, each plugin's own table for
exhaustion_only/trend_smc) - it writes nothing anywhere.

## Mix (`src/paper/bots/mix/`, a plugin): `GET /api/paper/mix-report` (+ `&format=json`) - **SUGGESTIONS ONLY**

Labelled `"suggestion, needs owner approval"` on every response, in the HTML and the JSON both. **It never places a trade and never
changes any bot's rules or weights.** Three read-only sections, all built purely from trades every bot already took:

1. **Score-weighted vote**: for every candle that 2 or more bots actually traded (same symbol, same candle open time), a
   score-weighted vote: each bot's weight is its own win rate, but **only for bots with 20+ closed trades** - a bot under that still
   shows in the leaderboard but contributes nothing to a vote. The "weighted result" is the weighted average of what those bots'
   *own* trades on that candle actually scored - an approximation (each bot's real entry/stop/target differed slightly), not a fresh
   backtest of one combined position, and the report says so. Equal weights pointing opposite directions is reported as "no
   agreement", never forced to a side.
2. **Per-bot scoreboard** (Task Group C): the same `computeBotStats()` the leaderboard uses (net INR after costs, win rate, max
   drawdown), with `avgRFactor` (real risk-reward at entry, `docs/R-FACTOR.md`) and `tradesPerDay` added on top.
3. **Mix candidate** (Task Group C, `src/paper/bots/mix/stats.js` `buildMixCandidate`): a plain-English, descriptive-only analysis of
   which entry pattern / SMC tag each bot's own best-performing trades share, against that bot's own static reward/risk floor -
   i.e. what a combined "best-of" bot's entry+filter rule-set would look like if assembled from these slices. **It changes no live
   filter, threshold or bot, and builds/wires no new engine** - it only describes, in the report's text, what the existing bots'
   best slices have in common. Reads `paper_shadows` (if that table exists) only to report its row count; its absence never fails
   the route.

## Mirror bots (`src/paper/bots/<bot>_mirror/`, plugins): `exhaustion_only-MIRROR`, `trend_smc-MIRROR`, `scalp-MIRROR`, `scalp_wide-MIRROR`, `intraday-MIRROR`

For every trade an original bot takes, its mirror opens the **exact opposite** trade: same entry price/time and qty, same
fee/slippage model, but direction flipped (LONG becomes SHORT and back) and target/stop **swapped** - the mirror's target is the
original's own stop price, and the mirror's stop is the original's own target price. Because both sides are watching the same two
price barriers, the mirror always closes at the exact same exit price/time as the original, just on the opposite side of it (the
original's "stop hit" is the mirror's "target hit", and vice versa). P&L is always computed by the ORIGINAL bot's own
`settle({ trade, exitPrice, cfg, fxRate })` with the mirror's inverted direction - never a `pnl * -1` sign-flip - so the cost model
(fees + slippage) is identical on both sides and a mirror pays its own costs rather than simply negating the original's net.

Each mirror has its **own table, own trade ids, own virtual balance** - never a shared row or balance with the original it shadows
(`src/paper/lib/mirrorStore.js`). Every read path there casts NUMERIC/DECIMAL columns (`entry_price`, `qty`, `sl_price`,
`target_price`, `rr`, `gross_pnl_usdt`, `cost_usdt`, `net_pnl_usdt`, `gross_pnl_inr`, `pnl_inr`, `fx_rate`) to real JS numbers
with a shared `castNumericColumns()` helper - node-pg returns NUMERIC columns as strings, which silently made
`computeBotStats()` produce null/NaN net/win-rate/fees for every mirror bot against real Postgres (fixed for all five mirror
tables at once, same fix, no bot special-cased). The original bot's own code, store and schedule are completely untouched: a mirror plugin only
*reads* the original's store (`src/paper/lib/mirrorBot.js`'s `sync()`, run on its own cron tick) and writes only to its own table.
Telegram alerts (`src/paper/ops/telegramAlerts/`) use the exact same `formatEntry`/`formatExit` as every other bot, with the bot
label suffixed `-MIRROR` so the two sides are visually distinguishable in the same channel. The leaderboard and mix report
(above) list every mirror bot right alongside the original it shadows.

`intraday-MIRROR` (`src/paper/bots/intraday_mirror/`) mirrors the main crypto bot ("intraday" - `paperbot/bot.js`'s
`cryptoScan`/`cryptoMonitor`) exactly the way `scalp-MIRROR` mirrors `scalp`: by reading the SHARED `paper_trades` table the
original already writes to, filtered to the `crypto` market only (never `nse`, `crypto_scalp` or `crypto_wide_scalp` - those
already have their own mirrors), into its own `intraday_mirror_trades` table. Unlike every other original bot, intraday had no
exported `settle({ trade, exitPrice, cfg, fxRate })` of its own (the booking math lived inline in `paperbot/bot.js`'s
`closeTrade`/`cryptoMonitor`); `paperbot/engine.js` now exports one, matching that exact arithmetic (no fee/slippage model - the
real intraday bot applies none) - `paperbot/bot.js` itself is unchanged and never calls it. Switch: `PAPER_INTRADAY_MIRROR_ENABLED`
(default on, follows `PAPER_BOT_ENABLED` - the only switch the crypto loop itself has). Report: `GET
/api/paper/intraday-mirror-report?key=<PAPER_ADMIN_SECRET>`.

A one-off backfill (`node scripts/mirrorBackfill.js`, or `npm run report:mirror-backfill`; needs `PAPER_DATABASE_URL`) replays
**every** historical closed trade of every original bot into its mirror - no sampling - by calling the exact same `sync()` the
live mirror bots schedule, and writes a per-bot comparison (trades, net INR, win rate, fees, capital used, original vs mirror) to
`docs/MIRROR-BACKFILL-REPORT.md`. "Capital used" is that side's currently-open trades' own locked capital against its own
configured total (the same `computeCapitalState()` the Telegram capital line uses, fed that side's own `allOpenTrades()`) -
shown as `n/a`, never 0, when there is no `USDINR_FALLBACK` rate to express it in rupees with. That script needs
`PAPER_DATABASE_URL` set wherever it is run, which this session was never given - so the committed
`docs/MIRROR-BACKFILL-REPORT.md` only ever shows 0/n-a numbers from a sandbox with no database.

**The real backfill now runs itself, on the production server** (`src/paper/ops/mirrorBackfillReport/`, auto-loaded by
`src/paper/pluginLoader.js`): the first time the deployed server boots with `PAPER_DATABASE_URL` configured, it reuses the exact
same `buildJobs()`/`runJob()` as the script above - no re-implementation - to replay every closed trade of every bot
(`intraday`, `exhaustion_only`, `trend_smc`, `scalp`, `scalp_wide`) into its mirror, then sends a per-bot summary (trade count, original vs
mirror net INR P&L, win rate, fees impact, capital used - "no trades yet" for a bot with none) plus a "best bot" line (highest combined
original+mirror net P&L) to Telegram, using the same `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` the trade alerts already use (split
across 2-3 messages if the full report would exceed Telegram's ~4096-character limit). This runs **at most once, ever**: it
claims a row in a tiny `system_flags` table (`src/paper/ops/mirrorBackfillReport/schema.sql`) atomically before running, so a
restart or redeploy never re-sends the report. To re-run it by hand later (e.g. once real trading has accumulated more
history), hit `GET /api/paper/mirror-backfill-report?key=<PAPER_ADMIN_SECRET>` (or the `x-paper-secret` header, same convention
as every other `/api/paper/` route) - that re-run deliberately bypasses the once-ever guard, but a simple in-process lock
refuses a second concurrent call (`429`) so two overlapping manual calls can never double-send.

## REVERSE bots (`src/paper/bots/<bot>_reverse/`, plugins): `intraday-REVERSE`, `scalp_wide-REVERSE`

MIRROR takes the opposite side of the original but swaps target and stop, which makes its own reward:risk about 0.3 - it needs
roughly an 88% win rate after fees and tax just to break even. REVERSE takes the **same direction as the MIRROR** (opposite of
the original) but with a proper reward:risk instead: same entry price/time/qty as the original, stop placed at the distance of
the ORIGINAL's own stop from entry (the same pattern high/low + ATR distance, resolved via the shared
`resolveExitLevels()`/`legacyExit.js` a legacy pre-level-exits trade already needs), on the *losing* side of the reverse trade;
target at **2x** that distance, on the *winning* side - reward:risk is always exactly 2.0, by construction
(`src/paper/lib/reverse.js`'s `buildReverseEntry`). Only `intraday` and `scalp_wide` have a REVERSE bot, as asked - plain `scalp`
does not.

Unlike MIRROR (whose target/stop are a literal swap of the original's own two numbers, so whichever one the original hits, the
mirror hits the other at the same instant - closing it is just a patch), REVERSE's levels are independent, so its exit is **not**
determined by the original's close. The live `<bot>-REVERSE` plugin runs its own candle-by-candle monitor
(`src/paper/lib/reverseBot.js`'s `monitor()`), reusing the SAME `evaluateExit`/`simulateExit` and `settle()` the original bot
itself uses - never a different exit rule, just the reverse trade's own levels. `sync()` opens a reverse trade for every
original trade not reversed yet (open or closed), the same no-sampling convention `createMirrorBot`'s `sync()` uses. Each
REVERSE bot has its own table/balance (`intraday_reverse_trades`, `scalp_wide_reverse_trades` - same shape as the matching
mirror table), and sends its own Telegram alert (`formatEntry`/`formatExit`, label suffixed `-REVERSE`, basis line "REVERSE of
trade #N: same direction as the MIRROR..."), so every signal gives **3** Telegram messages: original, MIRROR, REVERSE. Switch:
`PAPER_INTRADAY_REVERSE_ENABLED` / `PAPER_SCALP_WIDE_REVERSE_ENABLED` (default on, follow `PAPER_BOT_ENABLED`/`PAPER_SCALP_ENABLED`
the same way their matching MIRROR bots do). Reports: `GET /api/paper/intraday-reverse-report` / `GET
/api/paper/scalp-wide-reverse-report` (`?key=<PAPER_ADMIN_SECRET>`).

The mirror backfill (`scripts/mirrorBackfill.js`) replays REVERSE too for these two bots, opening a row for every original
trade exactly like the mirror side - but **cannot** run the real, candle-accurate monitor retroactively, because no candle
history is stored anywhere in this schema. It can only resolve an exit when the original's own stored row *proves* one
(`estimateReverseExit()`): the original hitting its own target always means the reverse side was already stopped out (every
bot's own reward:risk floor is >= 1, so the stop distance is always crossed first); anything else is left **open** rather than
guessed. `docs/MIRROR-BACKFILL-REPORT.md`'s "3-way comparison" table and the production mirror-backfill Telegram report
(`src/paper/ops/mirrorBackfillReport/`) both show original vs MIRROR vs REVERSE for these two bots, and "Best bot" there is the
highest *combined* original+mirror+reverse net P&L. The daily 05:00 IST report (`src/paper/ops/dailyReport/`) picks REVERSE up
automatically the same way (`REVERSE_OF` in `fetch.js`) - a 3-way group in "OVERALL STATUS" for `intraday`/`scalp_wide`, still
original/MIRROR-only for every other bot.

## Report

`exhaustion_only`: `GET /api/paper/exhaustion-report?key=<PAPER_ADMIN_SECRET>`. `trend_smc`: `GET /api/paper/trend-smc-report`. Scalp and
scalp_wide share `GET /api/paper/scalp-report` (tabs **Scalp**, **Scalp wide**, **Intraday**). `intraday-MIRROR`: `GET
/api/paper/intraday-mirror-report?key=<PAPER_ADMIN_SECRET>` (same shape as `scalp-mirror-report`, above). Across every bot: `GET
/api/paper/bots-report` (leaderboard, above) and `GET /api/paper/mix-report` (suggestions only, above). Manual re-run of the
production mirror backfill (above): `GET /api/paper/mirror-backfill-report?key=<PAPER_ADMIN_SECRET>`.

## Telegram alerts: capital line (live running balance)

Every trade alert (`src/paper/ops/telegramAlerts/format.js`'s `formatEntry`/`formatExit`, every bot and every `-MIRROR`, entry
AND exit) carries total demo capital, how much of it THIS trade uses (in rupees and as a % of the total - `entry_price x qty`,
already each trade's own fields, converted via the same `fxInfo()`/`USDINR_FALLBACK` the rest of the message already uses),
and a LIVE running balance: "capital left now" = capitalTotal (in INR) + realized net P&L of that bot's own CLOSED trades so
far - capital currently locked in that bot's own OPEN trades (each one's own `entry_price x qty`, converted via ITS OWN
`fx_rate`/`nativeInr`, never the alert's own trade's rate) - plus the running net P&L itself, shown as its own explicit line
(`computeCapitalState()` in format.js, pure and unit-tested - `register.js`'s `check()` reads that bot's own
`closedTrades()`/`allOpenTrades()` once per 20s poll tick, the same store calls the leaderboard already makes, and passes the
arrays in; the formatter itself never touches a database). This replaced the earlier "per-trade view" (total minus only this
alert's own trade), which could not reflect the bot's other open positions. Capital totals come from each bot's own existing
config, never an invented number: `paperbot/config.js`'s `DEFAULTS.nse.capital_inr` (nse) / `DEFAULTS.crypto.capital_usdt`
(intraday), `SCALP_DEFAULTS`/`SCALP_WIDE_DEFAULTS`/`EXHAUSTION_ONLY_DEFAULTS`/`TREND_SMC_DEFAULTS`'s own `capital_usdt` for
scalp/scalp_wide/exhaustion_only/trend_smc. `nse_scalp` has no capital config of its own in this repo - it is shown against the
main `nse` pool as a documented assumption. Every `-MIRROR` bot shows the SAME total as the original it mirrors (no
mirror-specific capital config exists) and its OWN book's realized/locked numbers (never the original's). The whole capital
block is omitted (not shown as 0 or guessed) when a caller does not pass `capitalTotal`, or when there is no rate anywhere to
express it in rupees with.

## Not attempted

The main intraday bot's own shadow tracking (this round only covered the four bots above, per the brief's scope) and a UI that lets the
owner actually apply a suggested weight (mix is read-only by design, so there is nothing to "apply" yet - see `docs/decisions/CC3.md`).
