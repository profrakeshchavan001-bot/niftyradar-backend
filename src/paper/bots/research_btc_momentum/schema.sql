-- research_btc_momentum (S2 BTC weekly momentum - PASSed its train+test backtest,
-- docs/RESEARCH-STRATEGIES-REPORT.md). Own table, separate from paper_trades.
CREATE TABLE IF NOT EXISTS research_btc_momentum_trades (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  rebalance_period text NOT NULL,          -- ISO week start date 'YYYY-MM-DD' (Monday), one position per week
  entry_price     numeric NOT NULL,
  entry_time      timestamptz NOT NULL,
  target_price    numeric,
  sl_price        numeric,
  qty             numeric NOT NULL,
  basis           text NOT NULL,
  exit_price      numeric,
  exit_time       timestamptz,
  exit_reason     text,
  pnl_inr         numeric,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS research_btc_momentum_period_idx ON research_btc_momentum_trades (rebalance_period);
CREATE INDEX IF NOT EXISTS research_btc_momentum_status_idx ON research_btc_momentum_trades (status);

CREATE TABLE IF NOT EXISTS research_btc_momentum_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
