-- nse-REVERSE (Group 4, 2026-11): FULLY SEPARATE trade records from the shared paper_trades table the
-- main NSE bot ("nse" - paperbot/bot.js's nseScan/nseMonitor) uses - its own table, its own balance,
-- never a shared row. original_trade_id ties each mirror row to the one original paper_trades.id it
-- reverses (one reverse per original, enforced below). Unlike every other MIRROR table in this repo, this
-- one stores an OPTION contract (its own strike/expiry/instrument), not a stock/coin price - see
-- src/paper/lib/nseOptionSide.js's file header for why.
CREATE TABLE IF NOT EXISTS nse_reverse_trades (
  id                 bigserial PRIMARY KEY,
  original_trade_id  bigint,
  symbol             text NOT NULL,
  trade_date         date NOT NULL,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  direction          text NOT NULL CHECK (direction IN ('CALL', 'PUT')),
  instrument         text,                        -- e.g. "RELIANCE 2026-11-26 1300 PE"
  strike             numeric,
  expiry             date,
  qty                numeric NOT NULL,
  entry_price        numeric NOT NULL,             -- real Dhan option-chain premium at open
  entry_underlying   numeric,
  entry_time         timestamptz NOT NULL,
  sl_price           numeric NOT NULL,
  target_price       numeric NOT NULL,
  price_source       text NOT NULL DEFAULT 'dhan_option_chain_ltp',
  basis              text,
  exit_price         numeric,
  exit_underlying    numeric,
  exit_time          timestamptz,
  exit_reason        text,
  pnl_inr            numeric,
  max_fav_pct        numeric,
  max_adv_pct        numeric,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nse_reverse_trades_open_idx ON nse_reverse_trades (symbol, status);
CREATE UNIQUE INDEX IF NOT EXISTS nse_reverse_trades_once_idx ON nse_reverse_trades (original_trade_id);

-- liveAnnounce.js's one-time "I am live now" flag (src/paper/lib/nseSideStore.js), same shape as every
-- other own-table bot's *_meta table (research_*_meta, etc).
CREATE TABLE IF NOT EXISTS nse_reverse_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);
