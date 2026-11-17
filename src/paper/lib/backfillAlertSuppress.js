'use strict';
/**
 * Root-cause fix (backfill bug report, problems 1 and 3): a mirror/reverse backfill run inserts (and
 * resolves) potentially hundreds of historical trade rows in one go. src/paper/ops/telegramAlerts/
 * register.js polls every bot's own table on a timer and sends an individual entry/exit Telegram alert
 * for every row it has not already seen (telegram_alert_log, same dedupe table) - with NO notion of
 * "this row came from a backfill, not a live trade". Left alone, every backfilled trade got its own live
 * alert: that is what hit the 30/hour Telegram rate limit (problem 3), and why those individual alerts'
 * own "capital used right now" line (computed from the bot's CURRENT open-trade snapshot at the moment
 * the alert fires, mid-backfill) made no sense for a historical row (problem 1).
 *
 * The fix: as soon as the backfill has opened/resolved a bot's rows, mark every one of them already-sent
 * for BOTH the 'entry' and (if closed) 'exit' events, in the exact same table and exact same (bot,
 * trade_id, event) key register.js's own alreadySent() uses - so its next poll tick finds nothing new to
 * alert on for any of them. A LIVE trade (inserted after this call, by the real cron) is completely
 * unaffected: it is not in `trades` yet, so nothing is marked for it, and register.js alerts on it
 * exactly as before. Idempotent (ON CONFLICT DO NOTHING) and safe to call every backfill run, even
 * without the table existing yet (a script run before the server has ever started) - creates it the same
 * way src/paper/ops/telegramAlerts/schema.sql does, and any other failure is caught and logged, never
 * thrown (a reporting-table hiccup must never fail the backfill itself).
 */
async function markAlreadySent(pool, bot, trades, { log = console.warn } = {}) {
  if (!pool || !bot || !Array.isArray(trades) || !trades.length) return { marked: 0 };
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS telegram_alert_log (
      bot      text NOT NULL,
      trade_id bigint NOT NULL,
      event    text NOT NULL CHECK (event IN ('entry', 'exit')),
      sent_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (bot, trade_id, event)
    )`);
    const params = [];
    const values = [];
    let i = 1;
    for (const t of trades) {
      if (t == null || t.id == null) continue;
      params.push(bot, t.id, 'entry'); values.push(`($${i}, $${i + 1}, $${i + 2})`); i += 3;
      if (t.status === 'closed') { params.push(bot, t.id, 'exit'); values.push(`($${i}, $${i + 1}, $${i + 2})`); i += 3; }
    }
    if (!values.length) return { marked: 0 };
    await pool.query(`INSERT INTO telegram_alert_log (bot, trade_id, event) VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`, params);
    return { marked: values.length };
  } catch (e) {
    log(`[backfill-alert-suppress] could not mark ${bot} rows as already-sent (its live alerts may double up with the backfill this one time): ${e.message}`);
    return { marked: 0, error: e.message };
  }
}

module.exports = { markAlreadySent };
