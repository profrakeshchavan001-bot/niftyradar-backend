-- exhaustion_only_mirror (docs/BOTS.md "Mirror bots"): a FULLY SEPARATE trade record from
-- exhaustion_only_trades - its own table, its own balance, never a shared row. Same column shapes as
-- exhaustion_only_trades (src/paper/bots/exhaustion_only/schema.sql) plus original_trade_id, which ties
-- each mirror row to the one original trade it mirrors (one mirror per original, enforced below).
CREATE TABLE IF NOT EXISTS exhaustion_only_mirror_trades (
  id                 bigserial PRIMARY KEY,
  original_trade_id  bigint,                  -- exhaustion_only_trades.id this row mirrors
  symbol             text NOT NULL,
  trade_date         date NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction          text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  trigger_t          bigint,
  entry_price        numeric NOT NULL,
  entry_time         timestamptz NOT NULL,
  sl_price           numeric NOT NULL,
  target_price       numeric NOT NULL,
  stop_type          text,
  target_type        text,
  qty                numeric NOT NULL,
  rr                 numeric,
  basis              text,
  be_moved           boolean DEFAULT false,
  exit_price         numeric,
  exit_time          timestamptz,
  exit_reason        text,
  gross_pnl_usdt     numeric,
  cost_usdt          numeric,
  net_pnl_usdt       numeric,
  gross_pnl_inr      numeric,
  pnl_inr            numeric,
  fx_rate            numeric,
  fx_source          text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS exhaustion_only_mirror_trades_open_idx ON exhaustion_only_mirror_trades (symbol, status);
CREATE INDEX IF NOT EXISTS exhaustion_only_mirror_trades_date_idx ON exhaustion_only_mirror_trades (trade_date);
CREATE UNIQUE INDEX IF NOT EXISTS exhaustion_only_mirror_trades_once_idx ON exhaustion_only_mirror_trades (original_trade_id);
