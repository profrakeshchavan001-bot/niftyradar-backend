-- Add-on v2: dedupe log so a trade's entry/exit alert is never sent twice, even across a redeploy.
-- Idempotent; applied by src/paper/pluginLoader.js.
CREATE TABLE IF NOT EXISTS telegram_alert_log (
  bot      text NOT NULL,
  trade_id bigint NOT NULL,
  event    text NOT NULL CHECK (event IN ('entry', 'exit')),
  sent_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot, trade_id, event)
);
