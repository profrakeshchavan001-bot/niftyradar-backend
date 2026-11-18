-- research_nifty200_52whigh (S6 52-week-high rotation - PASSed its train+test backtest,
-- docs/RESEARCH-STRATEGIES-REPORT.md). One row per stock per monthly rebalance (equal-weight basket).
CREATE TABLE IF NOT EXISTS research_nifty200_52whigh_trades (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction       text NOT NULL DEFAULT 'LONG' CHECK (direction IN ('LONG', 'SHORT')),
  rebalance_period text NOT NULL,          -- 'YYYY-MM'
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
CREATE UNIQUE INDEX IF NOT EXISTS research_n200_52wh_period_symbol_idx ON research_nifty200_52whigh_trades (rebalance_period, symbol);
CREATE INDEX IF NOT EXISTS research_n200_52wh_status_idx ON research_nifty200_52whigh_trades (status);

CREATE TABLE IF NOT EXISTS research_nifty200_52whigh_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
