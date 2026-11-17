-- intraday-MIRROR (docs/BOTS.md "Mirror bots"): FULLY SEPARATE trade records from the shared
-- paper_trades table the main crypto bot ("intraday") uses (market 'crypto') - its own table, its own
-- balance, never a shared row. original_trade_id ties each mirror row to the one original paper_trades.id
-- it mirrors (one mirror per original, enforced below). Same shape as scalp_mirror_trades.
CREATE TABLE IF NOT EXISTS intraday_mirror_trades (
  id                 bigserial PRIMARY KEY,
  original_trade_id  bigint,
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
CREATE INDEX IF NOT EXISTS intraday_mirror_trades_open_idx ON intraday_mirror_trades (symbol, status);
CREATE UNIQUE INDEX IF NOT EXISTS intraday_mirror_trades_once_idx ON intraday_mirror_trades (original_trade_id);
