-- ccy_gbpinr (NSE currency futures, PAPER ONLY): one bot's own tables, separate from paper_trades / paper_skips
-- (that table's CHECK constraint lists every market by name - see docs/decisions/CC3.md), same convention
-- src/paper/bots/exhaustion_only/schema.sql already uses. Prices/qty/P&L are already in rupees (no fx_rate column -
-- see src/paper/lib/currencyEngine.js's settleInr()).
CREATE TABLE IF NOT EXISTS ccy_gbpinr_trades (
  id              bigserial PRIMARY KEY,
  symbol          text NOT NULL,
  trade_date      date NOT NULL,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  trigger_t       bigint NOT NULL,          -- open time (ms) of the 5-min candle that triggered entry; one trade per trigger candle
  entry_price     numeric NOT NULL,
  entry_time      timestamptz NOT NULL,
  sl_price        numeric NOT NULL,
  target_price    numeric NOT NULL,
  stop_type       text,
  target_type     text,
  qty             numeric NOT NULL,         -- lots x lot_units (units of the base currency)
  rr              numeric,                  -- reward / risk AFTER costs, at entry
  basis           text NOT NULL,
  exit_price      numeric,
  exit_time       timestamptz,
  exit_reason     text,                     -- target | stop | time
  gross_pnl_inr   numeric,
  cost_inr        numeric,
  net_pnl_inr     numeric,
  pnl_inr         numeric,                  -- net, in rupees (= net_pnl_inr; no fx step, already rupees)
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ccy_gbpinr_trades_open_idx ON ccy_gbpinr_trades (symbol, status);
CREATE INDEX IF NOT EXISTS ccy_gbpinr_trades_date_idx ON ccy_gbpinr_trades (trade_date);
-- Restart safety: a restart mid-cycle re-scanning the still-current candle must never double-enter.
CREATE UNIQUE INDEX IF NOT EXISTS ccy_gbpinr_trades_once_idx ON ccy_gbpinr_trades (symbol, trigger_t);

CREATE TABLE IF NOT EXISTS ccy_gbpinr_skips (
  id          bigserial PRIMARY KEY,
  symbol      text NOT NULL,
  skip_date   date NOT NULL,
  reason      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ccy_gbpinr_skips_date_idx ON ccy_gbpinr_skips (skip_date);
