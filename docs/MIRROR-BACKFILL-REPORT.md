# Mirror backfill report

Generated: 2026-11-17T13:53:23.611Z

Every MIRROR bot (docs/BOTS.md "Mirror bots") takes the exact opposite side of its original bot's trade - same entry price/time and qty, direction flipped, target/stop swapped (mirror target = the original's own stop price, mirror stop = the original's own target price) - and settles with the SAME settle()/cost model as the original (src/paper/lib/mirror.js). This report replays EVERY historical closed trade of every original bot into its mirror, with no sampling, by running the same sync() the live mirror bots schedule on a cron (src/paper/lib/mirrorBot.js), then compares the two sides.

> **PAPER_DATABASE_URL was not set when this report was generated**, so there is no live trade history to read in this environment - every number below is 0. The backfill mechanism itself (src/paper/lib/mirror.js, mirrorStore.js, mirrorBot.js and scripts/mirrorBackfill.js) is fully implemented and unit-tested (test/paperMirror.test.js, test/paperMirrorBot.test.js); re-run `node scripts/mirrorBackfill.js` with `PAPER_DATABASE_URL` set to the production database to populate this report with real numbers.

| Bot | Trades replayed | Original net P&L | Mirror net P&L | Win rate (orig vs mirror) | Fees (orig vs mirror) |
|---|---|---|---|---|---|
| exhaustion_only (mirror: exhaustion_only-MIRROR) | 0 | +₹0 | +₹0 | n/a vs n/a | +₹0 vs +₹0 |
| trend_smc (mirror: trend_smc-MIRROR) | 0 | +₹0 | +₹0 | n/a vs n/a | +₹0 vs +₹0 |
| scalp (mirror: scalp-MIRROR) | 0 | +₹0 | +₹0 | n/a vs n/a | +₹0 vs +₹0 |
| scalp_wide (mirror: scalp_wide-MIRROR) | 0 | +₹0 | +₹0 | n/a vs n/a | +₹0 vs +₹0 |

## Per-bot detail

### exhaustion_only

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a
- Mirror: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a

### trend_smc

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a
- Mirror: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a

### scalp

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a
- Mirror: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a

### scalp_wide

- Mirror opened this run: 0, mirror closed this run: 0
- Original: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a
- Mirror: 0 closed trades, gross +₹0, net +₹0, fees +₹0, win rate n/a

