# The judge

One decision for every possible paper trade: all the helpers are combined into a single score from 0 to 100, and the bot takes the trade only if the score is high enough and no hard block applies. Every trade stores the points of each helper, so we can later measure which helper really adds value.

Code: `src/paper/decision/judge.js`. Tests: `test/paperJudge.test.js`, `test/paperJudgeWiring.test.js`. It applies to NSE entries (crypto is unchanged). `PAPER_JUDGE_ON=false` switches it off.

## The score (default points, all in `paper_config`, key `judge`)
| Helper | Points | What earns them |
|---|---|---|
| R factor | 25 | Real risk-reward of the traded side: R 1 = 0 points, R 2 = half, R 3 or more = all |
| Pattern | 25 | The candle / SMC patterns that fired. Strongest one counts (order block 0.9, FVG retest and liquidity sweep 0.85, exhaustion reversal 0.8, stars 0.75, engulfing 0.7, hammer and shooting star 0.6, inside bar 0.55); +0.1 for each extra confirming pattern, -0.1 for each pattern against the trade |
| Sector | 20 | The stock's sector score 0-100 (for a short: 100 minus it) |
| News | 10 | News score -100..100 mapped to 0..10 (for a short: reversed) |
| Market trend | 10 | Nifty 15-minute trend: with the trade all, flat half, against none |
| Time | 10 | Full points in the steady part of the day; none in the first 15 minutes (09:15-09:30 IST) and the last 30 minutes (15:00-15:30 IST) |

If the weights do not add up to 100 they are scaled, so the score always stays 0-100. A helper that is not available (module missing, no data, error) earns half its points and is listed as `unavailable`.

## Hard blocks (no trade, whatever the score)
- the event block says so (results, big event due),
- news score below -40 against a long (a short: above +40),
- the sector is WEAK against a long (a short: STRONG).

## Take or not
Take the trade only when the score is **65 or more** (`take_threshold`). The answer is `{ score, take, basis, contributions }`: `basis` is a plain sentence saying why, `contributions` is the points per helper.

## Measuring the helpers (weekly, Sunday)
Each trade stores `judge_score`, `judge_take`, `judge_contributions` and `judge_basis`. The Sunday job sends a second message, **which helper adds value**: for every helper, the closed trades where it earned at least half of its points ("with") against the trades where it earned less ("without"), with win rate and average P&L of each group.
- A group needs **20 trades**; with fewer the report says "too few trades, no conclusion".
- The report only **suggests** ("consider lowering the weight"). **The weights are never changed by the bot.** The owner changes the `judge` row in `paper_config` (or tells Claude to).

## Where the helpers come from
`stockSectorView(symbol)` comes from `src/paper/context/sector.js` (CC4, on main). `newsScore(symbol)` and `eventBlock(symbol)` come from `src/paper/context/news.js` (CC3); until that file exists the judge gives the news helper neutral half points and no event block is checked (the bot's own headline filter still runs before the judge). The Nifty trend comes from `nse.niftyTrend()` if a source provides it (none yet).

## Not changed by the judge
Entry timing, option choice, size, target, stop and exit rules stay as they were.
