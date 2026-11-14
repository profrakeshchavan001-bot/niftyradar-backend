# Paper-trading bot (demo only)

Solves: "trade the top R-factor stocks in demo using candle patterns, log WHY each trade was taken, send an end-of-day summary, and keep stats per pattern so we learn what actually works."

**Paper only.** No order is ever sent anywhere. The code in `paperbot/` only reads market data and writes its own tables. A test (`test/paperReplay.test.js`, "safety") fails if an order endpoint ever appears in that folder.

## What runs (inside the existing server, IST)

| When | Job |
|---|---|
| every 5 min, Mon-Fri 09:15-15:00 | NSE scan: top 5 by R-factor, 5-min candles, patterns, entry |
| every minute, Mon-Fri | NSE exit check: target +10 %, stop -5 %, forced exit 15:15 |
| every 5 min, all days | Crypto scan: BTCUSDT, ETHUSDT, SOLUSDT (Binance public candles, no key) |
| every minute, all days | Crypto exit check: target +2 %, stop -1 % |
| 15:45 Mon-Fri | NSE summary to Telegram + `daily_summaries` |
| 23:55 daily | Crypto summary |
| Sunday 10:00 | Weekly suggestions report (nothing is applied) |

## Patterns

`exhaustion_reversal` (may trade against the trend), `bullish_engulfing`, `bearish_engulfing`, `hammer`, `shooting_star`, `morning_star`, `evening_star`, `inside_bar_breakout`, `liquidity_sweep`, `order_block`, `fvg_retest`. Exact rules are in the comments of `paperbot/patterns.js`.

## Environment variables

| Name | Purpose |
|---|---|
| `PAPER_BOT_ENABLED` | default on; `false` switches the whole bot off |
| `DATABASE_URL` | Neon Postgres; without it trades live in memory only |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | summaries to Telegram; without them summaries are only stored |
| `PAPER_ADMIN_SECRET` | key for the read-only routes (falls back to `RENEW_SECRET`) |

## Tables (`sql/paper_bot.sql`, created automatically)

`paper_trades`, `paper_skips`, `daily_summaries`, `paper_config` (rules: target, stop, max trades, capital, risk, holidays).

Change a rule (example: NSE target 12 %):

```sql
UPDATE paper_config SET value = jsonb_set(value, '{target_pct}', '12'), updated_at = now() WHERE key = 'nse';
```

## Read-only routes

`GET /api/paper/summaries`, `/api/paper/trades`, `/api/paper/skips` with `?key=<PAPER_ADMIN_SECRET>&limit=50`.

## Tests

`npm test` (offline): pattern detection, rules, sizing, stats, and a replay of recorded candles through the real bot.

Open points and defaults taken: `docs/DECISIONS-PENDING.md`.
