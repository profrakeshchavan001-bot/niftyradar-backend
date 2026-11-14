# R factor (paper bot)

The paper bot ranks stocks by a real risk-reward number, not by the size of the move.

**In one line:** R = how far the price can run to the next level, divided by how far away the stop has to sit.
R = 2 means the possible reward is twice the risk.

The website's own "R-Factor" column is NOT changed. It still shows the old placeholder (size of the move x 1.8 + 0.5). The bot stores that old number too, as `legacy_rf`, so the two can be compared later.

## The formula

Worked out for every stock, once for a long (CALL) and once for a short (PUT):

| Step | Long (CALL) | Short (PUT) |
|---|---|---|
| Entry | current price | current price |
| Stop distance | the bigger of: 1 x ATR, or the gap down to the nearest recent swing low | the bigger of: 1 x ATR, or the gap up to the nearest recent swing high |
| Target distance | gap up to the nearest level above (swing high, previous-day high or low) | gap down to the nearest level below (swing low, previous-day high or low) |
| Target limits | never more than 3 x ATR; if there is no level at all, use 2 x ATR | same |
| R | target distance / stop distance | target distance / stop distance |

The stock's R is the better of its two sides. The stocks are sorted by R and the top 5 go to the pattern check, as before.

## Words used

- **ATR**: the average size of the last 14 candles (true range), on 15-minute candles. It says how much the stock normally moves in 15 minutes.
- **Swing low**: a 15-minute candle whose low is lower than the 2 candles before it and the 2 after it. **Swing high** is the mirror. Only the last 40 candles (about a day and a half) are looked at.
- **Previous-day high / low**: highest and lowest price of the last trading day before today.

## Worked example

Price 101, ATR 2.5, nearest swing low 97, nearest swing high 106.

- Long: stop = bigger of 2.5 and (101 - 97 = 4) = 4. Target = 106 - 101 = 5 (below the limit 3 x 2.5 = 7.5). R = 5 / 4 = **1.25**.
- Short: stop = bigger of 2.5 and (106 - 101 = 5) = 5. Target = 101 - 97 = 4. R = 4 / 5 = **0.8**.
- The stock's R is 1.25 (long side).

If there were no swing levels at all: stop = 2.5, target = 2 x 2.5 = 5, R = **2** on both sides.

These are the same numbers the tests check (`test/paperFollowup.test.js`).

## Which stocks are ranked

- Only stocks with enough liquidity: today's traded value (price x volume) of at least Rs 1 crore (`nse.min_turnover_inr`).
- Only stocks with valid candles: at least 21 closed 5-minute candles, at least 15 closed 15-minute candles, and the newest candle not older than 2 candles. Others are left out, never guessed.

## What is stored on every NSE trade (`paper_trades`)

| Column | Meaning |
|---|---|
| `r_factor` | R of the side that was actually traded (CALL = long side, PUT = short side) |
| `legacy_rf` | the old number: size of today's % move x 1.8 + 0.5 |
| `r_detail` | both sides (stop, target, R and what they were based on), ATR, previous-day levels, the stock's place in the R ranking (`rRank`) and in the old ranking (`legacyRank`), and `inLegacyTop` (would the old ranking also have picked it) |

Compare the two rankings later, for example:

```sql
SELECT (r_detail->>'inLegacyTop')::boolean AS old_ranking_also_picked_it,
       count(*) AS trades, round(avg(pnl_inr)) AS avg_pnl, round(sum(pnl_inr)) AS total_pnl
FROM paper_trades WHERE market = 'nse' AND status = 'closed' GROUP BY 1;
```

## Settings (`paper_config`, key `rfactor`)

`capAtr` 3, `fallbackAtr` 2, `swingK` 2 (candles each side for a swing), `swingLookback` 40. The bot never changes them by itself.

## Limits to know

- R only decides which stocks are looked at. The trade's exit is still the option rule (+10 % target, -5 % stop, 15:15).
- A quiet stock with no swing levels gets R = 2 by the fallback rule, so it can rank above a stock with real but closer levels.
- The old ranking's trades are only seen when the new ranking also picked that stock; stocks only the old ranking would have picked are not traded.
