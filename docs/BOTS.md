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

One read-only leaderboard across **every** bot (intraday, scalp, scalp_wide, exhaustion_only, trend_smc): trades, win rate, net INR
after costs, average win, average loss, max drawdown (largest peak-to-trough drop of the bot's own cumulative net P&L, in the order
trades closed), average time in trade, and cost as a % of gross. A bot under 20 closed trades is shown but marked "too few trades, no
conclusion" and left out of the ranked list. **A bot losing after costs is flagged plainly** (`lossAfterCosts`), never hidden. A daily
table says which bot's net INR was highest each day. Each bot's row expands to its 20 most recent closed trades with their basis text.
Reads straight from each bot's own store (the shared `paper_trades` for intraday/scalp/scalp_wide, each plugin's own table for
exhaustion_only/trend_smc) - it writes nothing anywhere.

## Mix (`src/paper/bots/mix/`, a plugin): `GET /api/paper/mix-report` (+ `&format=json`) - **SUGGESTIONS ONLY**

Labelled `"suggestion, needs owner approval"` on every response, in the HTML and the JSON both. **It never places a trade and never
changes any bot's rules or weights.** For every candle that 2 or more bots actually traded (same symbol, same candle open time), it
works out a score-weighted vote: each bot's weight is its own win rate, but **only for bots with 20+ closed trades** - a bot under that
still shows in the leaderboard but contributes nothing to a vote. The "weighted result" is the weighted average of what those bots'
*own* trades on that candle actually scored - an approximation (each bot's real entry/stop/target differed slightly), not a fresh
backtest of one combined position, and the report says so. Equal weights pointing opposite directions is reported as "no agreement",
never forced to a side.

## Report

`exhaustion_only`: `GET /api/paper/exhaustion-report?key=<PAPER_ADMIN_SECRET>`. `trend_smc`: `GET /api/paper/trend-smc-report`. Scalp and
scalp_wide share `GET /api/paper/scalp-report` (tabs **Scalp**, **Scalp wide**, **Intraday**). Across every bot: `GET
/api/paper/bots-report` (leaderboard, above) and `GET /api/paper/mix-report` (suggestions only, above).

## Not attempted

The main intraday bot's own shadow tracking (this round only covered the four bots above, per the brief's scope) and a UI that lets the
owner actually apply a suggested weight (mix is read-only by design, so there is nothing to "apply" yet - see `docs/decisions/CC3.md`).
