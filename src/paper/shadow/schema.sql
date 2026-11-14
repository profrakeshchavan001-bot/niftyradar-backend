-- Shadow tracking (docs/BOTS.md): a skipped setup that DID have a full entry/stop/target plan (only the reward/risk gate turned it
-- down) is followed on paper to its would-be stop or target here, in its OWN table, never counted as a trade. Shared by every CC3 bot
-- (scalp, scalp_wide, exhaustion_only), not the shared paper_trades table - same reasoning as exhaustion_only's own tables: a plugin
-- brings its own idempotent schema rather than widening a table another window's PR might be touching the same night.
CREATE TABLE IF NOT EXISTS shadow_setups (
  id              bigserial PRIMARY KEY,
  bot             text NOT NULL,                 -- 'scalp' | 'scalp_wide' | 'exhaustion_only'
  symbol          text NOT NULL,
  setup_date      date NOT NULL,
  trigger_t       bigint NOT NULL,                -- the candle's own open time (ms); one shadow per bot+symbol+candle
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  direction       text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  entry_price     numeric NOT NULL,
  sl_price        numeric NOT NULL,
  target_price    numeric NOT NULL,
  skip_reason     text NOT NULL,
  resolved_reason text,                           -- target | stop | breakeven | time (same wording the real exit uses)
  resolved_price  numeric,
  resolved_time   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS shadow_setups_once_idx ON shadow_setups (bot, symbol, trigger_t); -- the same skip logged twice is still one shadow
CREATE INDEX IF NOT EXISTS shadow_setups_open_idx ON shadow_setups (bot, status);
CREATE INDEX IF NOT EXISTS shadow_setups_date_idx ON shadow_setups (bot, setup_date);
