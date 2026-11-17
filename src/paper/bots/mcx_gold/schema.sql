-- mcx_gold (docs/BOTS.md): one trading rule measured alone (MCX GOLDM proxy, scalp_wide engine reused), its
-- own tables, separate from paper_trades and from every other bot's own tables - same convention
-- src/paper/bots/exhaustion_only/schema.sql uses.
CREATE TABLE IF NOT EXISTS mcx_gold_trades (
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
  basis           text NOT NULL,
  exit_price      numeric,
  exit_time       timestamptz,
  exit_reason     text,
  gross_pnl_usdt  numeric, -- naming kept consistent with every other bot's settle() output (src/paper/scalp/engine.js); this bot's unit is already INR, fx_rate = 1
  cost_usdt       numeric,
  net_pnl_usdt    numeric,
  gross_pnl_inr   numeric,
  pnl_inr         numeric,
  fx_rate         numeric,
  fx_source       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcx_gold_trades_open_idx ON mcx_gold_trades (symbol, status);
CREATE INDEX IF NOT EXISTS mcx_gold_trades_date_idx ON mcx_gold_trades (trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS mcx_gold_trades_once_idx ON mcx_gold_trades (symbol, trigger_t);

CREATE TABLE IF NOT EXISTS mcx_gold_trades_skips (
  id          bigserial PRIMARY KEY,
  symbol      text NOT NULL,
  skip_date   date NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mcx_gold_trades_skips_date_idx ON mcx_gold_trades_skips (skip_date);
