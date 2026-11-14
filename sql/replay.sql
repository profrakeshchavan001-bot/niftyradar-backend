-- Replay engine tables (src/paper/replay/). PAPER ONLY, own database (PAPER_DATABASE_URL), never DATABASE_URL.
-- Idempotent: safe to run on every start. Separate file from sql/paper_bot.sql to stay in the replay lane.

CREATE TABLE IF NOT EXISTS replay_candles (
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL, -- '1m' | '5m' | '15m' | '1h'
  t BIGINT NOT NULL, -- candle open time, ms since epoch (Binance kline open time)
  o DOUBLE PRECISION NOT NULL,
  h DOUBLE PRECISION NOT NULL,
  l DOUBLE PRECISION NOT NULL,
  c DOUBLE PRECISION NOT NULL,
  v DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (symbol, interval, t)
);

CREATE TABLE IF NOT EXISTS replay_runs (
  id SERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running', -- running | done | failed
  trigger TEXT NOT NULL DEFAULT 'manual', -- manual | scheduled | code_change
  code_version TEXT,
  params JSONB,
  error TEXT
);

CREATE TABLE IF NOT EXISTS replay_results (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES replay_runs(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL, -- 'scalp' today; more as adapters are added
  variant TEXT NOT NULL DEFAULT 'base', -- base | random_baseline | double_cost
  segment TEXT NOT NULL, -- in_sample | out_sample | full
  scope JSONB NOT NULL DEFAULT '{}'::jsonb, -- {} = all coins/hours; {coin:'BTCUSDT'} / {hour:14} / {session:'asia'} / {filter:'min_rr', on:true}
  metrics JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replay_results_run_id ON replay_results (run_id);

CREATE TABLE IF NOT EXISTS replay_trades (
  id SERIAL PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES replay_runs(id) ON DELETE CASCADE,
  strategy TEXT NOT NULL,
  variant TEXT NOT NULL DEFAULT 'base',
  segment TEXT NOT NULL,
  symbol TEXT NOT NULL,
  direction TEXT NOT NULL,
  entry_t BIGINT NOT NULL,
  exit_t BIGINT,
  entry_price DOUBLE PRECISION NOT NULL,
  exit_price DOUBLE PRECISION,
  exit_reason TEXT,
  stop_pct DOUBLE PRECISION,
  target_pct DOUBLE PRECISION,
  rr DOUBLE PRECISION,
  pnl_inr DOUBLE PRECISION,
  patterns JSONB
);
CREATE INDEX IF NOT EXISTS replay_trades_run_id ON replay_trades (run_id);

CREATE TABLE IF NOT EXISTS replay_history_progress (
  symbol TEXT NOT NULL,
  interval TEXT NOT NULL,
  last_open_t BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, interval)
);
