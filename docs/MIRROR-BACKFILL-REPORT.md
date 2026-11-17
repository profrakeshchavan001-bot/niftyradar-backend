# Mirror backfill report

Generated: 2026-11-17T16:08:13.572Z

Every MIRROR bot (docs/BOTS.md "Mirror bots") takes the exact opposite side of its original bot's trade - same entry price/time and qty, direction flipped, target/stop swapped (mirror target = the original's own stop price, mirror stop = the original's own target price) - and settles with the SAME settle()/cost model as the original (src/paper/lib/mirror.js). This report replays EVERY historical closed trade of every original bot into its mirror, with no sampling, by running the same sync() the live mirror bots schedule on a cron (src/paper/lib/mirrorBot.js), then compares the two sides.

| Bot | Trades replayed | Original net P&L | Mirror net P&L | Win rate (orig vs mirror) | Fees (orig vs mirror) |
|---|---|---|---|---|---|
| intraday (mirror: intraday-MIRROR) | 1 | +₹1,760 | n/a | 100% vs 0% | +₹0 vs n/a |
| exhaustion_only (mirror: exhaustion_only-MIRROR) | 0 | +₹0 | +₹0 | n/a vs n/a | +₹0 vs +₹0 |
| trend_smc (mirror: trend_smc-MIRROR) | 0 | +₹0 | +₹0 | n/a vs n/a | +₹0 vs +₹0 |
| scalp (mirror: scalp-MIRROR) | 1 | +₹88 | n/a | 100% vs 0% | +₹0 vs n/a |
| scalp_wide (mirror: scalp_wide-MIRROR) | 0 | +₹0 | +₹0 | n/a vs n/a | +₹0 vs +₹0 |

## Per-bot detail

### intraday

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 1 closed trades, gross +₹1,760, net +₹1,760, fees +₹0, win rate 100%
- Mirror: 1 closed trades, gross n/a, net n/a, fees n/a, win rate 0%

### exhaustion_only

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a
- Mirror: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a

### trend_smc

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a
- Mirror: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a

### scalp

- Mirror opened this run: 1, mirror closed this run: 1
- Original: 1 closed trades, gross +₹88, net +₹88, fees +₹0, win rate 100%
- Mirror: 1 closed trades, gross n/a, net n/a, fees n/a, win rate 0%

### scalp_wide

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a
- Mirror: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a

