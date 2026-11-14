# How the bot thinks (plain words)

PAPER ONLY. This page explains, in plain words, how a single trade gets
decided - from "a candle just closed" to "a paper trade opened" or "skipped,
and why". It does not explain every rule (see `docs/R-FACTOR.md`,
`docs/JUDGE.md`, `docs/SCALP.md` for those) - it is the map that shows how
the pieces fit together, with one worked example per step.

## The pipeline, in order

```
closed candles -> indicators & context -> pattern detectors -> entry rule -> (NSE only) the Judge -> size the trade -> exit levels -> open the trade
```

Every step only looks at candles that have FULLY CLOSED. The bot never
peeks at the candle still forming - that would be "look-ahead", deciding a
trade using information it would not really have had yet. This is checked
every night in the VERIFY loop.

### 1. Indicators & context

From the closed 5-minute candles, the bot works out:
- **EMA20** (5-min) and the **15-minute trend** (up / down / flat / unknown)
- **VWAP** (today's volume-weighted average price) and which side of it the
  price is on
- **EMA9/21 (5m) and EMA20/50 (15m/1h) crossover** (`src/paper/lib/emaCross.js`):
  did the fast EMA just cross the slow one, and which way

**Worked example:** BTCUSDT's last six 5-minute closes are falling, then
jump up sharply. EMA9 was below EMA21 (a "down" side) and the jump pushes
EMA9 back above EMA21 for the first time - that is a **fresh** cross up.
If the trade about to be considered is a LONG, this is logged as
`fresh_with` (a strong confirmation). If it were a SHORT, it would be
`fresh_against` (a warning) - either way, it is never a hard block, only
something stored on the trade so the weekly numbers can show whether it
actually mattered.

### 2. Pattern detectors (`paperbot/patterns.js`)

Every closed-candle pattern the bot knows (classic candlestick shapes,
SMC ones like order blocks and fair value gap retests, and the exhaustion
reversal) runs against the latest candles. Zero, one or several can fire at
once.

**Worked example:** a stock's 5-minute candles show four red candles in a
row, VWAP above the price, then one small red candle closing below VWAP,
then a green candle closing back above that small candle's high. That
matches `exhaustion_reversal`, direction `up`.

### 3. Entry rule (`paperbot/engine.js` `decideEntry`)

At least one pattern must fire, AND its direction must agree with BOTH the
15-minute trend and the VWAP side - unless it is the exhaustion reversal,
which is allowed to fire against the trend by design (that is the point of
a reversal pattern). Patterns that disagree with each other are skipped,
not resolved by a tie-break.

**Worked example (continuing):** the 15-minute trend was down, VWAP side was
down, and the pattern that fired is the exhaustion reversal pointing up.
Because it is a reversal pattern, going against the trend is allowed:
`enter: true, direction: 'up'`.

### 4. The Judge - NSE entries only (`src/paper/decision/judge.js`, `docs/JUDGE.md`)

For NSE, the Judge scores the candidate 0-100 from several helpers
(risk-reward R, pattern strength, sector, news, Nifty 15-min trend, time of
day), each worth its own share of 100 points; a helper that cannot answer
(no sector view yet, feed down) earns half its points rather than zero or
full, and is listed as "unavailable". A trade is only taken at 65 or above,
and an event block / strong news-against / sector-against can block it
outright, whatever the score. Crypto entries are not judged (`PAPER_JUDGE_ON`
only wires into the NSE path).

**Worked example:** the exhaustion reversal above scores R-factor 25/25
(reward is 3x the risk), pattern 20/25 (exhaustion reversal, no extra
confirming pattern), sector "unavailable" (12.5/25 - i.e. half), news
"unavailable" (half), Nifty trend down against the trade (0/10... scaled
into whatever its share is), time of day mid-session (full). Added up and
rescaled to 100, say it comes to 68 - at or above 65, so `take: true`.

### 5. Sizing

NSE: risk = capital x risk%, position value = risk / stop%, rounded down to
whole option lots; skipped if even one lot does not fit. Crypto: the same
risk formula, but capped at an equal share of the capital per coin and no
leverage.

### 6. Exit levels (level-based, `paperbot/cryptoLevels.js` for crypto, legacy
+10%/-5% for NSE options until that becomes level-based too)

Crypto's target is the nearest swing high/low, order block, FVG edge, or
previous day/week high/low on the far side of the entry - but a level
closer than 1x ATR14(15m) to the entry is skipped for the next one out
(too little room for the trade). The stop is beyond the pattern's own
candle, or the nearest 15-minute swing if the pattern gives none, plus 1x
ATR14(15m). A trade only goes ahead if reward/risk is at least 1.5.

**Worked example:** entry 102.18 (short), nearest support below it is 101.5
(previous day low) - but that is only 0.68 away, less than 1x ATR (0.6 here,
so the 1x-ATR floor does NOT exclude it this time, 0.68 > 0.6) - so 101.5 is
still used: target 101.6015 (0.1% before it). Stop: the pattern's high
102.52 plus 1x ATR (0.6) = 103.12. Reward 0.58, risk 0.94 - if that fell
below 1.5 reward/risk, the trade would be skipped with that reason recorded
in `paper_skips`, not silently taken anyway.

### 7. Exit checking (while the trade is open)

Checked every minute (crypto) or against the option price (NSE). The stop
moves to the entry once half the distance to the target is covered
(breakeven). A pure, tested but **not yet live-wired** `simulateExit()`
(`src/paper/lib/exitSim.js`) exists for checking the stop/target against
every candle's high and low since the last check, not only the single tick
price - see `docs/decisions/CC2.md` for why it is not wired into the live
monitor yet.

## What never happens

- No order is ever sent anywhere. Every "BUY"/"SHORT"/"target hit" is a row
  in `paper_trades`, nothing else.
- No step reads a candle before it has closed.
- No weight (Judge or otherwise) changes itself. A weekly ablation report
  can say a helper "adds value" or "does not" - that is a suggestion for the
  owner, never applied automatically.
