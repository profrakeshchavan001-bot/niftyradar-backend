-- ccy_eurinr-MIRROR (docs/BOTS.md "Mirror bots"): FULLY SEPARATE trade records from ccy_eurinr's own
-- table - own balance, never a shared row. original_trade_id ties each mirror row to the ccy_eurinr_trades.id
-- it mirrors (one mirror per original, enforced below). Same shape as scalp_mirror/schema.sql, in rupees,
-- no fx_rate column (ccy_eurinr is already rupees-native - see src/paper/lib/currencyEngine.js).
CREATE TABLE IF NOT EXISTS ccy_eurinr_mirror_trades (
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
  gross_pnl_inr      numeric,
  cost_inr           numeric,
  net_pnl_inr        numeric,
  pnl_inr            numeric,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ccy_eurinr_mirror_trades_open_idx ON ccy_eurinr_mirror_trades (symbol, status);
CREATE UNIQUE INDEX IF NOT EXISTS ccy_eurinr_mirror_trades_once_idx ON ccy_eurinr_mirror_trades (original_trade_id);
