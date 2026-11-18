-- Paper-trading bot tables (demo only, no real orders). Idempotent: safe to run
-- again. The bot runs this file itself at startup when DATABASE_URL is set.

CREATE TABLE IF NOT EXISTS paper_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper_trades (
  id               bigserial PRIMARY KEY,
  market           text NOT NULL CHECK (market IN ('nse', 'crypto', 'nse_scalp', 'crypto_scalp', 'crypto_wide_scalp')),
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

-- Scalp strategy (docs/SCALP.md, src/paper/scalp/). Every trade carries its strategy; old rows are 'intraday'. Scalp trades use their own market key
-- ('crypto_scalp', later 'nse_scalp') so the intraday monitor, the intraday report and the judge never see them.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS strategy       text NOT NULL DEFAULT 'intraday';
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS gross_pnl_usdt numeric;  -- before fees and slippage
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS net_pnl_usdt   numeric;  -- after fees and slippage (pnl_inr is this, in rupees)
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS cost_usdt      numeric;  -- fees + slippage
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS gross_pnl_inr  numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS be_moved       boolean;  -- the stop was moved to breakeven

-- Root-cause fix (15 Nov outage round 3, docs/decisions/CC... write-up): this used to be TWO separate
-- DROP + ADD CONSTRAINT steps, one per market value added historically ('nse_scalp'/'crypto_scalp' here,
-- then 'crypto_wide_scalp' further below). Postgres validates an ADD CONSTRAINT against every EXISTING row
-- immediately, even though the very next statement in this same file replaced it with a wider list - so once
-- any row actually used a later market value (e.g. 'crypto_wide_scalp'), this file re-validating itself on a
-- later run (the bot's own store re-runs this whole file whenever the previous run failed, see
-- paperbot/store.js) hit the FIRST, narrower ADD CONSTRAINT and aborted the script before ever reaching the
-- correct, wider one further down - leaving every job's every write failing with "check constraint ... is
-- violated by some row", forever, until this file itself was fixed.
--
-- Fix: exactly ONE statement, built from the single, superset list of every market value this bot has ever
-- used ('src/paper/lib/paperTradeMarkets.js' is the one JS-side source of truth for that same list - keep
-- both in sync, test/paperTradeMarkets.test.js checks it). ADD CONSTRAINT ... NOT VALID skips checking
-- existing rows at add-time (it is enforced for every new insert/update from now on, which is all that ever
-- mattered - the application code is the only writer and already only ever uses these values), so this can
-- never again fail on data already in the table, however it got there.
ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_market_check;
ALTER TABLE paper_trades ADD CONSTRAINT paper_trades_market_check
  CHECK (market IN ('nse', 'crypto', 'nse_scalp', 'crypto_scalp', 'crypto_wide_scalp')) NOT VALID;

-- EMA crossover confirmation (CC2 item 5, src/paper/lib/emaCross.js): 'fresh_with' / 'fresh_against' /
-- 'confirmed_with' / 'confirmed_against' / 'mixed' / 'unknown'. Informational only - never changes entry/exit.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS ema_cross text;
ALTER TABLE paper_skips  ADD COLUMN IF NOT EXISTS ema_cross text;

-- smc_tags on every skip too (paper_trades already had it): BOS/CHoCH, liquidity pools/sweeps, order
-- blocks, FVG retests, premium/discount, displacement, session - src/paper/lib/smc/, CC2 round 2 item 2.
ALTER TABLE paper_skips ADD COLUMN IF NOT EXISTS smc_tags jsonb;

-- Judge v2 (CC2 round 2 item 3, src/paper/decision/judge2.js): a PARALLEL scorer, stored on every
-- trade AND skip, both markets. NEVER used for a live entry/exit decision - the live judge above
-- still decides NSE entries. judge2_na lists helpers excluded (not applicable / null) and rescaled.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge2_score         numeric;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge2_take          boolean;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge2_contributions jsonb;
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS judge2_basis         text;
ALTER TABLE paper_skips  ADD COLUMN IF NOT EXISTS judge2_score         numeric;
ALTER TABLE paper_skips  ADD COLUMN IF NOT EXISTS judge2_take          boolean;
ALTER TABLE paper_skips  ADD COLUMN IF NOT EXISTS judge2_contributions jsonb;
ALTER TABLE paper_skips  ADD COLUMN IF NOT EXISTS judge2_basis         text;

-- Shadow tracking (CC2 round 2 item 4): a setup the bot REJECTED, followed on paper to its own
-- hypothetical stop/target. Its own table - never joined into paper_trades or counted as a trade.
CREATE TABLE IF NOT EXISTS paper_shadows (
  id           bigserial PRIMARY KEY,
  market       text NOT NULL,
  symbol       text NOT NULL,
  shadow_date  date NOT NULL,
  direction    text NOT NULL,          -- 'up' / 'down'
  reason       text NOT NULL,          -- why the real setup was rejected
  entry_price  numeric NOT NULL,       -- the price it would have entered at
  target_price numeric NOT NULL,
  stop_price   numeric NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  outcome      text,                   -- 'target' / 'stop' / null (still open)
  result_pct   numeric,
  basis        text,
  entry_time   timestamptz NOT NULL,
  exit_time    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_shadows_market_date_idx ON paper_shadows (market, shadow_date);
CREATE INDEX IF NOT EXISTS paper_shadows_open_idx ON paper_shadows (market, status);

-- Judge SMC shadow logging (Task Group B, docs/decisions/GROUP-A-MONDAY-READINESS.md item 3, gated by
-- JUDGE_SMC_LIVE, default off): the real live Judge decision (src/paper/decision/judge.js, completely
-- unchanged) next to a shadow decision that also scores SMC/ICT tags as an added helper
-- (src/paper/decision/judgeSmcShadow.js), for the SAME candidate, both markets. INFORMATIONAL ONLY -
-- never read by any entry/exit decision, and NOT the same table as paper_shadows above (that one is
-- CC2's unrelated rejected-setup-followed-to-its-stop/target tracking).
CREATE TABLE IF NOT EXISTS paper_judge_shadows (
  id                   bigserial PRIMARY KEY,
  market               text NOT NULL,
  symbol               text NOT NULL,
  judge_date           date NOT NULL,
  direction            text,                 -- 'long' / 'short'
  real_score           numeric,              -- judge.js, today's weights, unchanged
  real_take            boolean,
  real_contributions   jsonb,
  real_basis           text,
  shadow_score         numeric,              -- judgeSmcShadow.js: same candidate, smc added as a 7th helper
  shadow_take          boolean,
  shadow_contributions jsonb,
  shadow_basis         text,
  smc_tags             jsonb,                -- src/paper/lib/smc tagSmc() output for this candidate
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_judge_shadows_market_date_idx ON paper_judge_shadows (market, judge_date);

-- CC3 round 3 (restart safety): a restart mid-cycle that re-scans the still-current candle must never double-enter a trade.
-- NULL trigger_t (older rows, option trades that never set it) are not compared by a UNIQUE index, so this changes nothing for them.
CREATE UNIQUE INDEX IF NOT EXISTS paper_trades_once_idx ON paper_trades (market, symbol, trigger_t);

-- Group 3d (2026-11): intraday ('crypto' market) now pays the same fee + slippage model scalp_wide
-- already uses (Group 3a). Every closed intraday trade stored BEFORE this fix has pnl_inr computed
-- WITHOUT that cost - never overwritten (history stays exactly as it was). This column holds the
-- corrected recomputation for those old rows, filled in once by `node scripts/intradayFeeBackfill.js
-- -- --apply` (dry run by default) and left null for every trade closed after the fix, since those
-- already have the correct number in pnl_inr/net_pnl_usdt/cost_usdt/gross_pnl_usdt directly.
ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS net_after_fees_corrected numeric;
