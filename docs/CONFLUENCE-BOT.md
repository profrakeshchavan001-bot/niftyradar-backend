# Confluence bots (Bot A / Bot B) - plain English

Both bots are **paper/demo only**. No real order is ever placed, by either bot, anywhere.

## confluence (Bot A)

Trades BTC, ETH and SOL on 5-minute candles, and only when two separate things agree:

1. **Location** - price is sitting right at a real chart feature: an order block or a liquidity
   sweep (both detected from real candles, `paperbot/patterns.js`).
2. **Trigger** - a directional candle pattern (engulfing, hammer, shooting star, star,
   inside-bar breakout, or an exhaustion reversal) fires in the SAME direction as the location.

If both agree, the stop and target are worked out purely from real chart levels
(`src/paper/lib/levelEngine.js` + `src/paper/lib/logicalTargets.js`):

- **Stop**: just beyond the order block / swing the entry is based on, with a small ATR cushion.
- **Target**: the first real resistance/support level in the trade's direction.
- **Path check**: if another level (an order block, FVG, or higher-timeframe level) sits between
  the entry and that target, the target is pulled IN to that nearer level - never pushed further out.
- **Reward:Risk gate**: if R:R after fees/slippage is below 1.5, the idea is skipped with a plain
  reason. The target is never moved further out to force a pass - the gate is allowed to say no.

Max 6 trades/day. Own capital pool (own virtual USDT balance), own P&L ledger, same fee +
slippage model as `scalp_wide` (`src/paper/scalp/engine.js`'s `settle()`).

## confluence_flow (Bot B)

Exactly Bot A's logic, PLUS one more requirement: the live order-flow reading
(`src/paper/lib/orderFlow.js` - bid/ask book imbalance plus aggressor delta/CVD, read from
Binance's existing public market data, no new exchange integration, no keys, no orders) must
agree with the trade's direction. If it disagrees, the idea is skipped and logged to the shared
shadow-tracking table with the reason, and a small sample of the order-flow reading is saved
(`confluence_flow_samples`) for later study - whether taken or skipped.

## Alerts

Every real entry/exit sends a Telegram message in the exact same format `scalp_wide` already
uses (trade number, entry time, target/stop, capital line, running P&L), with four extra lines
for these two bots only: **where** (the location type), **why** (the trigger pattern), the
**order-flow reading**, the **target level/type**, and any **obstacles found on the path**.

Each bot also sends one message, exactly once, ever: *"Hello, I am confluence/confluence_flow,
I am live now."*

## Replay / backtest

Only **Bot A** can be replayed (`scripts/confluenceReplay.js`, `src/paper/replay/adapters/confluence.js`):
it reuses the stored historical candles, splits each symbol's history 60% train / 40% test by
time, and runs the SAME config against both - no tuning on the test split. It reports trade
count, win %, net Rs, average R:R and max drawdown.

**Bot B cannot be replayed.** Its decision needs a LIVE order-book reading (bid/ask depth and
recent trades), and this repository stores no historical order-book data - only candles. There is
no honest way to backtest the order-flow gate without that history, so it is not attempted.

## NSE variant (off by default)

`src/paper/bots/confluence_nse/` is the same logic for NSE intraday stocks, reusing the existing
Dhan integration for candles and real option prices. It is behind `PAPER_CONFLUENCE_NSE_ENABLED`
(default off). Even when turned on, it will not run without a real `DHAN_ACCESS_TOKEN` - it logs
"waiting for Dhan token" once and does nothing else. NSE order flow is meant to use Dhan's
20-level market depth, which is not wired into this repository today (only quote/OHLC and the
option chain are) - this is a known, documented gap, not a silent shortcut.

## Weekly scoreboard

Every Sunday at 09:00 IST, `src/paper/ops/weeklyScoreboard/` sends one Telegram report covering
**every** demo bot (existing ones included), read-only: trades, win %, net after fees, and a
status label - "too early" (under 30 lifetime trades), "ahead" (profitable with a 40%+ win rate),
or "under review" (anything else). It never changes or disables any bot.
