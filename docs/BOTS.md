# Bots (paper only)

Several independent paper-trading strategies run side by side, each with its own virtual money, its own record, and its own report, so we can
see which logic really works. The shared interface every bot follows: `docs/BOT-INTERFACE.md`. This file documents, in plain words, exactly
what each bot does and does not do, with one worked example each.

**Only the bots below exist.** The rest of the overnight plan this file was requested from (`trend_smc`, a cross-bot leaderboard,
shadow-tracking of every skip, and a suggestion engine that would vote across bots) was not attempted this session - see
`docs/decisions/CC3.md` for exactly why and what each would need.

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

## Report

`exhaustion_only` has its own JSON report: `GET /api/paper/exhaustion-report?key=<PAPER_ADMIN_SECRET>`. Scalp and scalp_wide share
`GET /api/paper/scalp-report` (tabs **Scalp**, **Scalp wide**, **Intraday**). There is no single leaderboard across all three yet (that
was item 6 of the overnight plan and was not attempted - see `docs/decisions/CC3.md`).
