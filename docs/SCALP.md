# Scalp strategy (paper only)

A fast second strategy next to the intraday one. Rupees: none are risked, this is a paper bot. Switch: `PAPER_SCALP_ENABLED` (default true; `false` turns it off). Code: `src/paper/scalp/`. Every trade is tagged `strategy = 'scalp'` (old trades are `intraday`).

## Data
Crypto only, today: Binance public klines for BTCUSDT, ETHUSDT, SOLUSDT. **1-minute candles for the entry, 5-minute candles for the trend, VWAP and levels.** The bot scans every minute. NSE scalp does not run: there is no 1-minute NSE candle source (Dhan is wired for 5-minute candles, Yahoo is delayed), and the bot says so in its log once a day.

## Entry (all of it)
1. One of: exhaustion reversal (small red candle in a falling move, then a green candle closing above its high; mirror for a rise), engulfing, hammer / shooting star, liquidity sweep, on the closed 1-minute candles.
2. It must agree with the 5-minute trend or the VWAP side (the exhaustion reversal is a reversal by design and is exempt).
3. There must be room: the nearest opposite level (5-minute swing high / low or today's high / low) minus 0.1 % gives the target, at most +0.5 %; if that is under +0.3 % the setup is skipped.
4. Reward / risk **after costs** must be at least 1.3.

## Exits
- **Target** = min(nearest level - 0.1 %, +0.5 %), at least +0.3 %.
- **Stop** = beyond the pattern candle + 0.5 x ATR14 (1-minute), never wider than 0.3 % (and never tighter than 0.05 %).
- **Breakeven:** when the price is half way to the target the stop moves to the entry price.
- **Time stop:** out after 15 minutes.
- One candle that touches both stop and target counts as the stop (worst case).

## Costs
Every scalp P&L is shown **after** costs: 0.1 % fee on each side + 0.03 % slippage on the entry = **0.23 % round trip**. Stored per trade: `gross_pnl_usdt`, `cost_usdt`, `net_pnl_usdt`, `gross_pnl_inr` and `pnl_inr` (= net, in rupees).

**What to expect:** with 0.23 % of costs, a 0.5 % target and a 0.1-0.3 % stop, reward/risk after costs is roughly 0.5-0.9, so the 1.3 rule will skip most setups. Each skip is stored with its numbers. If you want trades to study, lower `min_rr` in `paper_config` (key `scalp`); that is a deliberate owner decision, the bot never changes it.

## Size and limits
Own virtual balance of 1,000 USDT (the intraday balance is untouched), 2 % risk, at most a third of it per coin, no leverage. **One open scalp per coin; no daily cap; no cooldown.**

## Where it shows
`GET /api/paper/scalp-report?key=<PAPER_ADMIN_SECRET>` (add `&format=json` for data): tabs **Scalp** and **Intraday** with closed trades, win rate, net P&L in rupees, average time in trade, skips with reasons, and a win rate per pattern. A pattern or a strategy with fewer than 20 trades says "too few trades, no conclusion". Scalp trades never appear in the intraday report (`/api/paper/report`), the daily summaries or the judge.

## Rules (paper_config key `scalp`, the table wins)
`symbols`, `capital_usdt`, `risk_pct`, `target_cap_pct` 0.5, `target_min_pct` 0.3, `level_margin_pct` 0.1, `stop_cap_pct` 0.3, `min_stop_pct` 0.05, `atr_mult` 0.5, `min_rr` 1.3, `time_stop_min` 15, `breakeven_frac` 0.5, `fee_pct_per_side` 0.1, `slippage_pct` 0.03, `min_trades_for_conclusion` 20.

Database: only `PAPER_DATABASE_URL`, with the paper tables' own schema file (`sql/paper_bot.sql`, idempotent). Default choices are in `docs/DECISIONS-PENDING.md` (S1-S12).
