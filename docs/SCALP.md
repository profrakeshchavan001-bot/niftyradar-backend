# Scalp strategy (paper only)

A fast second strategy next to the intraday one. Rupees: none are risked, this is a paper bot. Switch: `PAPER_SCALP_ENABLED` (default true; `false` turns it off). Code: `src/paper/scalp/`. Every trade is tagged `strategy = 'scalp'` (old trades are `intraday`).

## Data
Crypto only, today: Binance public klines for BTCUSDT, ETHUSDT, SOLUSDT. **1-minute candles for the entry, 5-minute candles for the trend, VWAP and levels.** The bot scans every minute. NSE scalp does not run: there is no 1-minute NSE candle source (Dhan is wired for 5-minute candles, Yahoo is delayed), and the bot says so in its log once a day.

## Entry (all of it)
1. One of: exhaustion reversal (small red candle in a falling move, then a green candle closing above its high; mirror for a rise), engulfing, hammer / shooting star, liquidity sweep, on the closed 1-minute candles.
2. It must agree with the 5-minute trend or the VWAP side (the exhaustion reversal is a reversal by design and is exempt).
3. There must be room: the nearest opposite level (5-minute swing high / low or today's high / low) minus 0.1 % gives the target, at most +0.5 %; if that is under +0.3 % the setup is skipped.
4. Reward / risk **after costs** must be at least 1.0 (CHANGED 2026-11-14, was 1.3 — the round-trip cost is 0.23 %, and a 1.3 floor left almost no setup able to pass once a 0.5 %-capped target and a 0.1-0.3 % stop both paid that cost; 1.0 is the real floor, never set below it, because a trade that cannot pay its own costs is not logical).

## Exits
- **Target** = min(nearest level - 0.1 %, +0.5 %), at least +0.3 %.
- **Stop** = beyond the pattern candle + 0.5 x ATR14 (1-minute), never wider than 0.3 % (and never tighter than 0.05 %).
- **Breakeven:** when the price is half way to the target the stop moves to the entry price.
- **Time stop:** out after 15 minutes.
- One candle that touches both stop and target counts as the stop (worst case).

## Costs
Every scalp P&L is shown **after** costs: 0.1 % fee on each side + 0.03 % slippage on the entry = **0.23 % round trip**. Stored per trade: `gross_pnl_usdt`, `cost_usdt`, `net_pnl_usdt`, `gross_pnl_inr` and `pnl_inr` (= net, in rupees).

**What to expect:** with 0.23 % of costs, a 0.5 % target and a 0.1-0.3 % stop, reward/risk after costs is roughly 0.5-0.9, so even the 1.0 floor still skips most setups (a 0.5 %-capped target simply cannot clear a 1.0 reward/risk once its stop plus 0.23 % of costs are counted as the risk, except on the tightest stops). Each skip is stored with its numbers. This is exactly why `scalp_wide` exists below: it is not capped at 0.5 %, so it can actually clear 1.0 after costs. If you want more tight-scalp trades to study, lower `min_rr` further in `paper_config` (key `scalp`); that is a deliberate owner decision, the bot never changes it.

## Size and limits
Own virtual balance of 1,000 USDT (the intraday balance is untouched), 2 % risk, at most a third of it per coin, no leverage. **One open scalp per coin; no daily cap; no cooldown.**

## Scalp wide (slower variant, same coins, own balance)

A second, slower crypto variant next to the tight scalp above, for when the tight scalp's 0.5 %-capped target cannot clear its own costs. Switch: same `PAPER_SCALP_ENABLED` (it starts or stops with the scalp strategy as a whole). Code: `src/paper/scalp/engine.js` (`analyseWide`), wired from `src/paper/scalp/bot.js`. Every trade is tagged `market = 'crypto_wide_scalp'`, `strategy = 'scalp_wide'` — its own market key, so it never appears in the tight scalp's trades, the intraday report, the daily summaries or the judge (same `_scalp`-suffix exclusion the tight scalp already relies on).

- **Data:** the same Binance public klines, but **5-minute candles for the entry, 15-minute candles for the trend** (built from the 5-minute candles when no native 15-minute feed is wired, same as the intraday bot's 15-minute trend). Scanned every 5 minutes; exits checked every minute.
- **Entry:** the same five patterns as the tight scalp (exhaustion reversal, engulfing, hammer / shooting star, liquidity sweep), on the closed 5-minute candles, agreeing with the 15-minute trend or the VWAP side (exhaustion reversal exempt, as above).
- **Target:** the nearest opposite level (5-minute swing high / low or today's high / low) — but only if that level is **at least 0.8 % AND at least 1 x ATR14(5-minute) away**, whichever is larger; otherwise there is no room and the setup is skipped. The target IS the level (no margin is held back, unlike the tight scalp's -0.1 %).
- **Stop:** beyond the pattern candle + 0.5 x ATR14 (5-minute), capped at 1.5 %, never tighter than 0.1 %.
- **Breakeven:** at 50 % of the way to the target, same rule as the tight scalp.
- **Time stop:** out after 45 minutes (vs 15 for the tight scalp).
- **Reward / risk after costs:** at least 1.0, same floor and same reasoning as above, and the same 0.23 % round trip.
- **Size:** own virtual 1,000 USDT, 2 % risk, at most a third of it per coin, no leverage, one open scalp_wide per coin, no daily cap, no cooldown — all independent of the tight scalp's own 1,000 USDT.

## Where it shows
`GET /api/paper/scalp-report?key=<PAPER_ADMIN_SECRET>` (add `&format=json` for data): tabs **Scalp**, **Scalp wide** and **Intraday** with closed trades, win rate, net P&L in rupees, average time in trade, skips with reasons, and a win rate per pattern. A pattern or a strategy with fewer than 20 trades says "too few trades, no conclusion". Scalp and scalp_wide trades never appear in the intraday report (`/api/paper/report`), the daily summaries or the judge.

## Rules (paper_config key `scalp`, the table wins)
`symbols`, `capital_usdt`, `risk_pct`, `target_cap_pct` 0.5, `target_min_pct` 0.3, `level_margin_pct` 0.1, `stop_cap_pct` 0.3, `min_stop_pct` 0.05, `atr_mult` 0.5, `min_rr` 1.0, `time_stop_min` 15, `breakeven_frac` 0.5, `fee_pct_per_side` 0.1, `slippage_pct` 0.03, `min_trades_for_conclusion` 20.

## Rules (paper_config key `scalp_wide`, the table wins)
`symbols`, `capital_usdt`, `risk_pct`, `target_min_pct` 0.8, `stop_cap_pct` 1.5, `min_stop_pct` 0.1, `atr_mult` 0.5, `min_rr` 1.0, `time_stop_min` 45, `breakeven_frac` 0.5, `fee_pct_per_side` 0.1, `slippage_pct` 0.03, `min_trades_for_conclusion` 20.

Database: only `PAPER_DATABASE_URL`, with the paper tables' own schema file (`sql/paper_bot.sql`, idempotent). Default choices are in `docs/DECISIONS-PENDING.md` (S1-S12). The `scalp_wide` choices (stop cap, min stop, target floor) are new defaults, not from an earlier decision round; see `docs/decisions/CC3.md`.
