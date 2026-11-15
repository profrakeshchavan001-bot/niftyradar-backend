# Paper-trading bot (demo only)

Solves: "trade the top R-factor stocks in demo using candle patterns, log WHY each trade was taken, send an end-of-day summary, and keep stats per pattern so we learn what actually works."

**Paper only.** No order is ever sent anywhere. The code in `paperbot/` only reads market data and writes its own tables. A test (`test/paperReplay.test.js`, "safety") fails if an order endpoint ever appears in that folder.

## What runs (inside the existing server, IST)

| When | Job |
|---|---|
| every 5 min, Mon-Fri 09:15-15:00 | NSE scan: top 5 by the real risk-reward R factor (`docs/R-FACTOR.md`), 5-min candles, patterns, entry |
| every minute, Mon-Fri | NSE exit check: target +10 %, stop -5 %, forced exit 15:15 |
| every 5 min, all days | Crypto scan: BTCUSDT, ETHUSDT, SOLUSDT (Binance public candles, no key); one open trade per coin, no daily limit |
| every minute, all days | Crypto exit check: level-based target and stop, breakeven move (see "Crypto exits" below) |
| 15:45 Mon-Fri | NSE summary to Telegram + `daily_summaries` |
| 23:55 daily | Crypto summary |
| Sunday 10:00 | Weekly suggestions report (nothing is applied) |

## Patterns

`exhaustion_reversal` (may trade against the trend), `bullish_engulfing`, `bearish_engulfing`, `hammer`, `shooting_star`, `morning_star`, `evening_star`, `inside_bar_breakout`, `liquidity_sweep`, `order_block`, `fvg_retest`. Exact rules are in the comments of `paperbot/patterns.js`.

**`exhaustion_reversal` is two different rules, on purpose.** Crypto (the main bot, scalp, scalp_wide, `exhaustion_only`) keeps the original single-candle rule: small red candle in a falling move, closing below VWAP, then ONE green candle closing above its high (mirror for a rise) - `exhaustionReversal()`. **NSE uses a stricter, owner-specified rule** (`exhaustionReversalConfirmed()`, only reached through `paperbot/bot.js`'s `analyse()` with `variant: 'nse'`): that first green candle only starts the reversal and is never itself a signal - entry is confirmed only on a SECOND green candle closing above the first green candle's high (mirror: two reds confirm a short). Both write the same pattern name, `exhaustion_reversal`, so the Judge's `pattern_strength` weight (0.8) applies unchanged either way.

## Environment variables

| Name | Purpose |
|---|---|
| `PAPER_BOT_ENABLED` | default on; `false` switches the whole bot off |
| `PAPER_DATABASE_URL` | the bot's own Postgres (for example a free Supabase project). The bot never reads `DATABASE_URL` and never writes to the PictoTrade / Neon database. Without it trades live in memory only; the Telegram summary is still sent |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | summaries and trade alerts to Telegram; without them, summaries are only stored and trade alerts never send |
| `TELEGRAM_TRADE_ALERTS` | `on` sends a Telegram message the moment a trade is TAKEN (entry price/target/stop with the level type in brackets, Rs lost if stop hit, Rs gained if target hit) for every bot: nse, nse_scalp, crypto, crypto_scalp, crypto_wide_scalp, exhaustion_only, trend_smc. Default off (unset = no trade alerts; summaries above are unaffected) |
| `TELEGRAM_EXIT_ALERTS` | `off` silences the matching exit alert, keeping only the entry one. Default `on` |
| `TELEGRAM_BOTS` | optional comma list to send trade alerts for only these bots (e.g. `nse,crypto`). Default: every bot above |
| `USDINR_FALLBACK` | optional USD→INR rate used only when a crypto trade's own stored `fx_rate` is missing, so its Rs estimate can still be shown; without it that one trade's alert shows USD with "rate n/a" rather than a guessed rate. Not used by nse/nse_scalp, whose prices are already in rupees |
| `PAPER_ADMIN_SECRET` | key for the read-only routes (falls back to `RENEW_SECRET`) |

## Tables (`sql/paper_bot.sql`, created automatically)

`paper_trades`, `paper_skips`, `daily_summaries`, `paper_config` (rules: target, stop, max trades, capital, risk, holidays).

Change a rule (example: NSE target 12 %):

```sql
UPDATE paper_config SET value = jsonb_set(value, '{target_pct}', '12'), updated_at = now() WHERE key = 'nse';
```

## Database (separate, free)

- Set `PAPER_DATABASE_URL` to a standard Postgres URL. Supabase: Project Settings, Database, Connection string (URI). Both the direct connection (port 5432) and the pooler work.
- SSL is always on for a remote host. At most 2 connections, opened only when a query is needed and closed when idle.
- Tables are created automatically on the first connect (`sql/paper_bot.sql`, safe to run again).
- No polling: open trades, today's trades and the rules are read once and kept in memory; the database is touched only when a trade, a skip or a summary happens (rules are re-read at most every 10 minutes).

## Keep-alive on the Render free plan

`GET /api/paper/ping` needs no key and no database. It returns `ok`, the IST date and time, and `insideMarketHours`. Point a free external pinger (for example UptimeRobot or cron-job.org) at it every 5 minutes so the service does not sleep.

If the service did sleep, a wake is a fresh start. One minute after start the bot checks open trades and looks at the current candle only:
- missed candles are never replayed, so a signal that passed while asleep is not traded;
- a candle is traded at most once (its time is checked against the stored trades);
- data older than 2 candles is refused, and live quotes older than 2 minutes are refused.

## Read-only routes

`GET /api/paper/summaries`, `/api/paper/trades`, `/api/paper/skips` with `?key=<PAPER_ADMIN_SECRET>&limit=50`. `GET /api/paper/ping` is open (keep-alive only).

## Crypto exits (from price levels, not a fixed %)

- **Target** = the nearest support (for a short) or resistance (for a long) beyond the entry, exit 0.1 % before it. Levels looked at:
  swing highs / lows on 15-minute and 1-hour candles, order blocks, fair value gap edges, previous day and previous week high / low (UTC; week = Monday to Sunday).
- **Stop** = beyond the high / low of the candles that fired the pattern (or the nearest 15-minute swing if the pattern gives none), plus 1 x ATR14 on 15-minute candles.
- **Reward / risk** = distance to the target / distance to the stop. Under 1.5 the trade is not taken and the reason goes to `paper_skips`. No level found = no trade.
- **Breakeven**: once the price has covered 50 % of the way to the target, the stop moves to the entry (`stop_active`, `breakeven_time`). Exit reasons: `target`, `stop`, `breakeven_stop`.
- **Old rule for comparison only**: the fixed +2 % / -1 % levels are stored on every trade (`legacy_target`, `legacy_stop`) and followed at every minute check, also after the trade has closed, until one is hit (`legacy_result` = `target` or `stop`; `undecided after 48 h` if neither). They never cause an exit.
- **Best / worst %** (`max_fav_pct`, `max_adv_pct`) of every open trade is written at every 5-minute scan; for crypto from the highs and lows of the candles since entry.
- Stored per trade: `sl_price` and `target_price` (as set at entry), `target_type` (for example "swing low 1h at 3012.5"), `stop_type`, `rr`. The report page shows them in the table, on the chart lines and in the "why" text.
- Settings: `paper_config`, key `crypto`: `levels.minRr` 1.5, `levels.targetBufferPct` 0.1, `levels.atrStopMult` 1, `breakeven_at` 0.5, `legacy_max_hours` 48; `target_pct` 2 and `stop_pct` 1 are now only the old rule's numbers.

Compare the two rules later:

```sql
SELECT exit_reason AS level_rule_ended, legacy_result AS old_rule_would_have_ended, count(*) AS trades, round(sum(pnl_inr)) AS level_rule_pnl_inr
FROM paper_trades WHERE market = 'crypto' AND status = 'closed' AND legacy_target IS NOT NULL GROUP BY 1, 2 ORDER BY 3 DESC;
```

## NSE candles without Dhan (free Yahoo fallback)

When Dhan has no candles or no live quotes (expired token), the bot reads 5-minute candles from Yahoo Finance's public chart
endpoint (`SYMBOL.NS`) by itself: `paperbot/yahoo.js`. Only the 60 stocks in `data/nse-fno-top60.json`, about 1 request per second,
one request per stock per 5 minutes (plus one 15-minute read for a stock about to be analysed), backoff on 429 / 5xx.
Every trade AND every skipped setup stores `data_source` ("dhan", "yahoo_delayed", "binance_public") and `data_delay_sec`
(seconds since the latest closed candle ended, about 900 when Yahoo runs 15 minutes late); the entry log line shows the delay.

Yahoo's NSE data can be about 15 minutes late. So on `yahoo_delayed` data the latest closed candle may be up to
2 candles + 900 seconds old (`nse.yahoo_max_delay_sec`); older than that means no trade. On live data the limit stays 2 candles.
A candle counts as closed only up to the time of the last trade Yahoo has seen, so a half-formed candle is never traded.
Entries, the exit checks and the 15:15 exit then all run on prices that are about 15 minutes old, and the option price is
simulated (Yahoo has no NSE option prices). If Yahoo fails, the stock is skipped and the failure is logged; no value is ever
filled in. Dhan takes over again by itself when it answers. The R-factor ranking is unchanged.

## Report page

`GET /api/paper/report?key=<PAPER_ADMIN_SECRET>`: one page for the phone. Read-only.

- Top: trades today, wins, total P&L in INR, setups skipped today, and a "How the bot decides" box.
- Table of the last 100 trades, newest first: market, symbol, direction, entry, SL, target, exit, exit reason, P&L (INR), status.
- Tap a row: candle chart around the trade (open-source lightweight-charts, loaded from the unpkg CDN, pinned version), markers
  for entry and exit, lines for SL and target, the "basis" sentence (why), and an "Open in TradingView" button
  (`NSE:SYMBOL` or `BINANCE:ETHUSDT`).
- Skipped today: every setup the bot saw but did not trade, with the reason.
- Then, as before: day totals per market, today's trades as cards, open trades, win rate per pattern.

NSE trades are option trades but the chart shows the stock (there are no option candles). The SL and target lines on the
chart are the stock prices at which the option reaches its level at delta 0.5: exact for simulated options, approximate for
real ones. The table always shows the option prices. SL and target are stored with each new trade (`sl_price`,
`target_price`); for older trades they are worked out from the current rules.

`GET /api/paper/chart?key=...&id=<trade id>` gives the chart data (candles, markers, lines) as JSON.
`GET /api/paper/universe?key=...` lists what the bot scans; the same in words: `docs/UNIVERSE.md`.

## Tests

`npm test` (offline): pattern detection, rules, sizing, stats, a replay of recorded candles through the real bot, the Yahoo adapter on fixture answers, and the report page.

Open points and defaults taken: `docs/DECISIONS-PENDING.md`.
