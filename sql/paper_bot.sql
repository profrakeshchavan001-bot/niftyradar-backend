-- Paper-trading bot tables (demo only, no real orders). Idempotent: safe to run
-- again. The bot runs this file itself at startup when DATABASE_URL is set.

CREATE TABLE IF NOT EXISTS paper_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id               bigserial PRIMARY KEY,
  market           text NOT NULL CHECK (market IN ('nse', 'crypto')),
  symbol           text NOT NULL,
  trade_date       date NOT NULL,               -- IST date of the entry
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  r_factor         numeric,                     -- R-factor (nse) or momentum score (crypto) at entry
  score_source     text,
  direction        text NOT NULL,               -- CALL / PUT (nse), LONG / SHORT (crypto)
  patterns         jsonb NOT NULL,              -- pattern names
  trigger_candles  jsonb NOT NULL,              -- OHLC of the candles that fired, per pattern
  trigger_t        bigint,                      -- open time (ms) of the last trigger candle
  trend_state      jsonb,                       -- 15-min trend, VWAP, EMA20, price
  smc_tags         jsonb,
  news_filter      text,
  instrument       text,                        -- e.g. RELIANCE 2026-11-26 1300 CE
  simulated_option boolean NOT NULL DEFAULT false,
  price_source     text,
  candle_source    text,
  qty              numeric NOT NULL,
  entry_price      numeric NOT NULL,
  entry_time       timestamptz NOT NULL,
  entry_underlying numeric,
  exit_price       numeric,
  exit_time        timestamptz,
  exit_underlying  numeric,
  exit_reason      text,
  pnl_inr          numeric,
  fx_rate          numeric,                     -- USDT/INR used (crypto)
  fx_source        text,
  max_fav_pct      numeric,
  max_adv_pct      numeric,
  basis            text NOT NULL,               -- plain-English reason
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Follow-up: real risk-reward R factor. r_factor = R of the traded direction,
-- legacy_rf = the old size-of-move value (|% change| x 1.8 + 0.5), r_detail =
-- both directions, ATR, levels and both ranks, so the two rankings can be compared.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS legacy_rf numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS r_detail jsonb;
CREATE INDEX IF NOT EXISTS paper_trades_market_date_idx ON paper_trades (market, trade_date);
CREATE INDEX IF NOT EXISTS paper_trades_open_idx ON paper_trades (market, status);

CREATE TABLE IF NOT EXISTS paper_skips (
  id          bigserial PRIMARY KEY,
  market      text NOT NULL,
  symbol      text NOT NULL,
  skip_date   date NOT NULL,
  reason      text NOT NULL,
  r_factor    numeric,
  patterns    jsonb,
  trend_state jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_skips_date_idx ON paper_skips (market, skip_date);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,                  -- nse_daily / crypto_daily / weekly_suggestions
  summary_date  date NOT NULL,
  body          text NOT NULL,
  data          jsonb,
  telegram_sent boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS daily_summaries_kind_date_idx ON daily_summaries (kind, summary_date);

-- Judge (docs/JUDGE.md): the score and the points of every helper are stored with each trade, so the weekly ablation report can measure which
-- helper adds value. judge_contributions = {"r_factor": 25, "pattern": 22.5, "sector": 16, "news": 7.5, "market_trend": 10, "time": 10}.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge_score         numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge_take          boolean;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge_contributions jsonb;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge_basis         text;

-- NSE candle feed of each trade: "dhan" or "yahoo" (free fallback, paperbot/yahoo.js), and the observed data delay in seconds
-- (how long ago the latest closed candle ended when the trade was decided).
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS data_source    text;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS data_delay_sec numeric;

-- Report page and delayed-feed labels: exit levels fixed at entry, and the candle feed + its delay on skip rows too.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS sl_price     numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS target_price numeric;
ALTER TABLE paper_skips  ADD COLUMN IF NOT EXISTS data_source    text;
ALTER TABLE paper_skips  ADD COLUMN IF NOT EXISTS data_delay_sec numeric;

-- Crypto level-based exits. sl_price / target_price = the levels set at entry; stop_active = the stop in force now
-- (moves to the entry price at breakeven); target_type / stop_type say what the level is (for example "swing low 1h at 3012.5").
-- legacy_* = the old fixed +2% / -1% rule, followed in parallel for comparison only, never used for an exit.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS stop_active    numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS breakeven_time timestamptz;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS target_type    text;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS stop_type      text;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS rr             numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS legacy_target  numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS legacy_stop    numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS legacy_result  text;

