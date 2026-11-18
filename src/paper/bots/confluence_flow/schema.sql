-- confluence_flow (Bot B, GROUP 4): own tables, own market - same shape as confluence's own schema
-- (src/paper/bots/confluence/schema.sql), kept separate since a plugin brings its own idempotent DDL
-- (docs/BOT-INTERFACE.md).
CREATE TABLE IF NOT EXISTS confluence_flow_trades (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  trade_date      date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  trigger_t       bigint NOT NULL,
  entry_price     numeric NOT NULL,
  entry_time      timestamptz NOT NULL,
  sl_price        numeric NOT NULL,
  target_price    numeric NOT NULL,
  stop_type       text,
  target_type     text,
  location_type   text,
  pattern         text,
  flow_direction  text,                     -- the order-flow reading that agreed with this trade (WHY, flow)
  flow_strength   numeric,
  obstacles_on_path jsonb,
  qty             numeric NOT NULL,
  rr              numeric,
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
CREATE INDEX IF NOT EXISTS confluence_flow_trades_open_idx ON confluence_flow_trades (symbol, status);
CREATE INDEX IF NOT EXISTS confluence_flow_trades_date_idx ON confluence_flow_trades (trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS confluence_flow_trades_once_idx ON confluence_flow_trades (symbol, trigger_t);

CREATE TABLE IF NOT EXISTS confluence_flow_skips (
  id          bigserial PRIMARY KEY,
  symbol      text NOT NULL,
  skip_date   date NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confluence_flow_skips_date_idx ON confluence_flow_skips (skip_date);

CREATE TABLE IF NOT EXISTS confluence_flow_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

-- GROUP 3: a small persisted sample of the order-flow reading at every setup (taken or skipped), for later
-- study - never read live by the bot itself, purely for offline analysis of whether the flow gate helps.
CREATE TABLE IF NOT EXISTS confluence_flow_samples (
  id          bigserial PRIMARY KEY,
  symbol      text NOT NULL,
  sample_date date NOT NULL,
  trigger_t   bigint NOT NULL,
  took_trade  boolean NOT NULL,            -- true if this setup became a trade, false if it was skipped
  direction   text,                       -- the direction the location+trigger wanted ('LONG'/'SHORT')
  flow_direction text,                    -- 'buy' | 'sell' | 'neutral'
  flow_strength  numeric,
  top5        numeric,
  top10       numeric,
  cvd30       numeric,
  cvd60       numeric,
  cvd120      numeric,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS confluence_flow_samples_date_idx ON confluence_flow_samples (sample_date);
CREATE UNIQUE INDEX IF NOT EXISTS confluence_flow_samples_once_idx ON confluence_flow_samples (symbol, trigger_t);
