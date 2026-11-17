'use strict';
/**
 * Mirror-backfill report (production, one-time): replays EVERY historical closed trade of every original
 * bot into its mirror (reusing scripts/mirrorBackfill.js's buildJobs()/runJob() - the exact sync() every
 * live <bot>_mirror/register.js already schedules on a cron, nothing re-implemented - see ./run.js), then
 * sends a per-bot + "best bot" summary to Telegram using the SAME TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID env
 * vars src/paper/ops/telegramAlerts/register.js already reads. No new credentials, no new service, no new
 * paid tier: a one-time DB read + aggregate + a couple of Telegram HTTP calls.
 *
 * Runs itself ONCE, automatically, the first time the production server boots with PAPER_DATABASE_URL
 * configured. The earlier backfill (PR #65, scripts/mirrorBackfill.js run by hand) could only be run in a
 * sandbox with no database, so every number in docs/MIRROR-BACKFILL-REPORT.md was 0/n-a - this is what
 * actually runs it for real, against the production data, without ever handing a database credential to
 * this session. Guarded by a row in `system_flags` (schema.sql), claimed ATOMICALLY with
 * `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so a server restart - or, in principle, two instances
 * racing to boot at once - can never cause the report to be sent twice. The flag is claimed BEFORE the job
 * runs and is never un-claimed on failure: a run that throws is logged, not silently retried on the next
 * restart (that would risk spamming Telegram with the same half-finished report forever); re-running by
 * hand after fixing whatever broke is exactly what the route below is for.
 *
 * Deployment shape: this app runs as a single Render-free-tier instance (see paperbot/index.js's graceful
 * shutdown comment - briefly two processes during a redeploy, never two LIVE instances serving traffic at
 * once), so the in-process lock below is enough for the manual route's debouncing; the atomic DB claim
 * above is what actually matters for the automatic run, and it is safe even if that assumption ever stops
 * holding.
 *
 * Protected route (manual re-trigger, e.g. once more trading history has accumulated):
 *   GET /api/paper/mirror-backfill-report
 * Auth: same convention as every other ops route in this codebase (e.g.
 * src/paper/ops/dailySummary/register.js) - PAPER_ADMIN_SECRET (or RENEW_SECRET as a fallback, same as
 * paperbot/index.js's own admin routes) must be sent as the `x-paper-secret` header OR the `?key=` query
 * param. A mismatch (or a missing header/param) answers 401 and logs it; no secret configured at all
 * answers 503. This re-run BYPASSES the system_flags "ran once" gate on purpose (it is an explicit,
 * deliberate ask - the whole point is to re-run after the automatic one-time run), but a simple
 * in-process lock refuses a second concurrent call (429) so two overlapping manual calls can never both
 * run and double-send.
 */
const path = require('path');
const crypto = require('crypto');
const { runBackfillAndBuildReport } = require('./run');

const FLAG_KEY = 'mirror_backfill_auto_run_done';
const SEND_GAP_MS = 1200; // stay well under Telegram's own per-chat rate limit when sending 2-3 messages back to back

// Timing-safe secret compare - same approach as server.js's isValidRenewSecret()/paperbot/index.js's okSecret().
function timingSafeEqual(given, secret) {
  if (!secret || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Sends each message in order, with a short gap between them. Telegram's rate limiter
 * (src/paper/ops/telegramAlerts/rateLimit.js) is NOT reused here on purpose: it exists to cap a steady
 * stream of live trade alerts to 30/hour and digest the overflow, which is the wrong tool for "send these
 * 2-3 already-final report messages, in order, right now" - using it would risk the report's own messages
 * being folded into an unrelated digest. A fixed small delay is simpler and correct for this one-off burst.
 */
async function sendTelegramMessages(messages, { axios, token, chat, log }) {
  let sent = 0;
  for (const text of messages) {
    try {
      await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chat, text: text.slice(0, 4096) }, { timeout: 5000 });
      sent += 1;
    } catch (e) {
      log(`[mirror-backfill-report] telegram send failed: ${e.response?.status || (e.code === 'ECONNABORTED' ? 'timeout' : 'network error')}`); // never log the URL (holds the bot token)
    }
    if (messages.length > 1) await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }
  return sent;
}

module.exports = {
  name: 'mirror-backfill-report',
  schemaSql: path.join(__dirname, 'schema.sql'),
  FLAG_KEY,
  async register(ctx) {
    const { app, env, log, pool, store: mainStore, axios = require('axios') } = ctx;
    const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET || '';
    const okSecret = (given) => timingSafeEqual(given, secret);
    const token = env.TELEGRAM_BOT_TOKEN;
    const chat = env.TELEGRAM_CHAT_ID;

    let running = false; // in-process debounce: a manual re-run while one is already in flight is refused outright, never queued

    async function doRun({ trigger }) {
      running = true;
      try {
        const { rows, messages, tradeCount } = await runBackfillAndBuildReport({ mainStore, pool });
        let sent = 0;
        if (token && chat) {
          sent = await sendTelegramMessages(messages, { axios, token, chat, log });
        } else {
          log('[mirror-backfill-report] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set - report computed but not sent');
        }
        log(`[mirror-backfill-report] ${trigger} run done: ${rows.length} bot(s), ${tradeCount} trade(s) total (original+mirror), ${sent}/${messages.length} telegram message(s) sent`);
        return { ok: true, rows, tradeCount, messagesSent: sent, messageCount: messages.length };
      } catch (e) {
        log(`[mirror-backfill-report] ${trigger} run failed: ${e.message}`);
        return { ok: false, error: e.message };
      } finally {
        running = false;
      }
    }

    app.get('/api/paper/mirror-backfill-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if (!okSecret(req.get('x-paper-secret') || req.query.key)) {
        log('[mirror-backfill-report] rejected a request with a missing or wrong secret (expected the x-paper-secret header or ?key=)');
        return res.status(401).type('text').send('Unauthorized');
      }
      if (!pool) return res.status(503).type('text').send('PAPER_DATABASE_URL not set - nothing to backfill');
      if (running) return res.status(429).json({ ok: false, error: 'a backfill run is already in progress - try again shortly' });
      const result = await doRun({ trigger: 'manual' });
      res.status(result.ok ? 200 : 500).json(result);
    });

    if (!pool) { log('[mirror-backfill-report] PAPER_DATABASE_URL not set - nothing to backfill, skipping the one-time startup run (the manual route above still answers 503)'); return; }

    // One-time automatic run: claim the flag FIRST and atomically - see file header for why a throw after
    // this point is never retried on its own.
    let claimed;
    try {
      const claim = await pool.query(
        'INSERT INTO system_flags (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING 1',
        [FLAG_KEY, JSON.stringify({ claimedAt: new Date().toISOString() })],
      );
      claimed = claim.rows.length > 0;
    } catch (e) {
      log(`[mirror-backfill-report] could not claim the startup-run flag: ${e.message} - skipping the automatic run to be safe (the manual route still works)`);
      return;
    }
    if (!claimed) { log('[mirror-backfill-report] startup run already done before (system_flags) - skipping, use the manual route to re-run'); return; }

    // Awaited, not fire-and-forget: this is a ONE-TIME job (unlike a bot's own recurring cron sync), so a
    // few extra seconds before pluginLoader moves on to the next plugin is an acceptable, bounded, one-off
    // cost - and it makes the claim -> run -> record sequence fully deterministic (no dangling promise).
    // doRun() never throws (it catches its own errors), so this can never fail pluginLoader's own try/catch.
    const result = await doRun({ trigger: 'startup' });
    await pool.query(
      'UPDATE system_flags SET value = $2, set_at = now() WHERE key = $1',
      [FLAG_KEY, JSON.stringify({ ranAt: new Date().toISOString(), ok: result.ok, tradeCount: result.tradeCount ?? null, error: result.error ?? null })],
    ).catch((e) => log(`[mirror-backfill-report] could not record the startup-run result: ${e.message}`));

    log('[mirror-backfill-report] ready (PAPER ONLY, read-only on every original bot; manual re-run: GET /api/paper/mirror-backfill-report with the x-paper-secret header or ?key=)');
  },
};
