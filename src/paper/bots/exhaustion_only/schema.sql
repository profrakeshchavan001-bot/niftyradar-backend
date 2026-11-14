-- exhaustion_only (CC3, docs/BOTS.md): one trading rule measured alone, so its own tables, separate from paper_trades / paper_skips -
-- that table's CHECK constraint lists every market by name (see docs/decisions/CC3.md, the scalp_wide fix), and a plugin adding a bot
-- is supposed to bring its own idempotent schema (docs/BOT-INTERFACE.md) rather than widen a table other sessions are also touching tonight.
CREATE TABLE IF NOT EXISTS exhaustion_only_trades (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  trade_date      date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  trigger_t       bigint NOT NULL,          -- open time (ms) of the green/red reversal candle; one trade per trigger candle per symbol
  entry_price     numeric NOT NULL,
  entry_time      timestamptz NOT NULL,
  sl_price        numeric NOT NULL,
  target_price    numeric NOT NULL,
  stop_type       text,
  target_type     text,
  qty             numeric NOT NULL,
  rr              numeric,                  -- reward / risk AFTER costs, at entry
  basis           text NOT NULL,
  exit_price      numeric,
  exit_time       timestamptz,
  exit_reason     text,                     -- target | stop | both_hit_candle
  gross_pnl_usdt  numeric,
  cost_usdt       numeric,
  net_pnl_usdt    numeric,
  gross_pnl_inr   numeric,
  pnl_inr         numeric,                  -- net, in rupees (= net_pnl_usdt x fx_rate)
  fx_rate         numeric,
  fx_source       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exhaustion_only_trades_open_idx ON exhaustion_only_trades (symbol, status);
CREATE INDEX IF NOT EXISTS exhaustion_only_trades_date_idx ON exhaustion_only_trades (trade_date);
-- CC3 round 3 (restart safety): a restart mid-cycle re-scanning the still-current candle must never double-enter.
CREATE UNIQUE INDEX IF NOT EXISTS exhaustion_only_trades_once_idx ON exhaustion_only_trades (symbol, trigger_t);

CREATE TABLE IF NOT EXISTS exhaustion_only_skips (
  id          bigserial PRIMARY KEY,
  symbol      text NOT NULL,
  skip_date   date NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exhaustion_only_skips_date_idx ON exhaustion_only_skips (skip_date);
