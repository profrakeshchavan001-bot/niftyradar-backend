-- Overnight ops alerts (idempotent). Applied by src/paper/pluginLoader.js on startup
-- when a database pool is available; never run by hand.
CREATE TABLE IF NOT EXISTS paper_alerts (
  id         bigserial PRIMARY KEY,
  kind       text NOT NULL,          -- 'stale_job' | 'consecutive_failures'
  subject    text NOT NULL,          -- job name (nseScan, nseMonitor, cryptoScan, cryptoMonitor)
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS paper_alerts_created_idx ON paper_alerts (created_at DESC);
