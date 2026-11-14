-- trend_smc (CC3, docs/BOTS.md): own tables, same reasoning as exhaustion_only's own tables - a plugin brings its own idempotent
-- schema rather than widening the shared paper_trades table's market CHECK constraint a second time.
CREATE TABLE IF NOT EXISTS trend_smc_trades (
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
  qty             numeric NOT NULL,
  rr              numeric,
  trend15         text,                     -- 'up' | 'down' - the 15-min EMA20/50 side this trade went with
  zone            text,                     -- 'discount' | 'premium' at entry
  basis           text NOT NULL,
  be_moved        boolean DEFAULT false,
  exit_price      numeric,
  exit_time       timestamptz,
  exit_reason     text,                     -- target | stop | breakeven
  gross_pnl_usdt  numeric,
  cost_usdt       numeric,
  net_pnl_usdt    numeric,
  gross_pnl_inr   numeric,
  pnl_inr         numeric,
  fx_rate         numeric,
  fx_source       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trend_smc_trades_open_idx ON trend_smc_trades (symbol, status);
CREATE INDEX IF NOT EXISTS trend_smc_trades_date_idx ON trend_smc_trades (trade_date);

CREATE TABLE IF NOT EXISTS trend_smc_skips (
  id          bigserial PRIMARY KEY,
  symbol      text NOT NULL,
  skip_date   date NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trend_smc_skips_date_idx ON trend_smc_skips (skip_date);
