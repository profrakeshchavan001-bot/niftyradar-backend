-- mirror-backfill-report: a tiny, generic key/value table for one-time "has this already run" flags -
-- the production backfill job (register.js) claims the key 'mirror_backfill_auto_run_done' here, ATOMICALLY
-- (INSERT ... ON CONFLICT DO NOTHING), the first time the server boots with a database configured, so a
-- restart never re-sends the Telegram report. Not specific to this one job: any future one-time startup
-- job can reuse this same table with its own key.
CREATE TABLE IF NOT EXISTS system_flags (
  key     text PRIMARY KEY,
  value   jsonb NOT NULL DEFAULT '{}'::jsonb,
  set_at  timestamptz NOT NULL DEFAULT now()
);
