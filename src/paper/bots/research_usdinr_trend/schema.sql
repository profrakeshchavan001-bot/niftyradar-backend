-- research_usdinr_trend (S1 cross-asset trend-following, USDINR leg only - the one S1 instrument that
-- PASSed its train+test backtest, docs/RESEARCH-STRATEGIES-REPORT.md). Own table, separate from
-- paper_trades, same convention as src/paper/bots/ccy_usdinr/schema.sql.
CREATE TABLE IF NOT EXISTS research_usdinr_trend_trades (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  rebalance_period text NOT NULL,          -- 'YYYY-MM', one position per calendar month
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
CREATE UNIQUE INDEX IF NOT EXISTS research_usdinr_trend_period_idx ON research_usdinr_trend_trades (rebalance_period);
CREATE INDEX IF NOT EXISTS research_usdinr_trend_status_idx ON research_usdinr_trend_trades (status);

CREATE TABLE IF NOT EXISTS research_usdinr_trend_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
