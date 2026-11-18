-- confluence (Bot A, GROUP 4): own tables, own market, independent of every other bot's schema - a plugin
-- adding a bot brings its own idempotent DDL (docs/BOT-INTERFACE.md), same convention as
-- src/paper/bots/exhaustion_only/schema.sql.
CREATE TABLE IF NOT EXISTS confluence_trades (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  trade_date      date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  trigger_t       bigint NOT NULL,          -- open time (ms) of the trigger candle; one trade per trigger candle per symbol
  entry_price     numeric NOT NULL,
  entry_time      timestamptz NOT NULL,
  sl_price        numeric NOT NULL,
  target_price    numeric NOT NULL,
  stop_type       text,
  target_type     text,
  location_type   text,                     -- order block / liquidity sweep (WHERE)
  pattern         text,                     -- trigger candle pattern (WHY)
  obstacles_on_path jsonb,
  qty             numeric NOT NULL,
  rr              numeric,                  -- reward / risk AFTER costs, at entry, from real levels only
  basis           text NOT NULL,
  exit_price      numeric,
  exit_time       timestamptz,
  exit_reason     text,
  gross_pnl_usdt  numeric,
  cost_usdt       numeric,
  net_pnl_usdt    numeric,
  gross_pnl_inr   numeric,
  pnl_inr         numeric,
  fx_rate         numeric,
  fx_source       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confluence_trades_open_idx ON confluence_trades (symbol, status);
CREATE INDEX IF NOT EXISTS confluence_trades_date_idx ON confluence_trades (trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS confluence_trades_once_idx ON confluence_trades (symbol, trigger_t);

CREATE TABLE IF NOT EXISTS confluence_skips (
  id          bigserial PRIMARY KEY,
  symbol      text NOT NULL,
  skip_date   date NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confluence_skips_date_idx ON confluence_skips (skip_date);

-- one-time "Hello, I am confluence, I am live now" flag (src/paper/lib/liveAnnounce.js's store.getMeta/setMeta contract)
CREATE TABLE IF NOT EXISTS confluence_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
