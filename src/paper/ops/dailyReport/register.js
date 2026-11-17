'use strict';
/**
 * Daily Telegram report, sent once a day at 05:00 IST to the same channel the trade alerts already use
 * (src/paper/ops/telegramAlerts/ - NOT edited here, and NOT reused for sending: this plugin calls
 * paperbot/report.js's own sendTelegram() directly, the plain TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID HTTP
 * call every report in this repo already uses, not the entry/exit formatter). Auto-loaded by
 * src/paper/pluginLoader.js - nothing in paperbot/index.js or server.js needed to change.
 *
 * Idempotent across restarts: the IST date already reported is stored via the main store's
 * getConfig/setConfig (the same key-value store every bot's own config already uses - no new table).
 * A cron tick fires once at 05:00 IST; on top of that, register() itself checks ONCE at startup so a
 * restart around 05:00 (or a restart up to 6 hours after a missed 05:00, e.g. the process was asleep -
 * see README's keep-alive note) still sends that day's report exactly once, never twice.
 *
 * Manual trigger for testing (same owner-only secret-key pattern every /api/paper/ report route in this
 * repo already uses - there is no Telegram bot-command listener in this codebase to reuse instead):
 *   GET /api/paper/daily-report?key=<PAPER_ADMIN_SECRET>            -> builds, sends to Telegram (if not already sent today), HTML back
 *   GET /api/paper/daily-report?key=...&format=json                -> JSON back instead of HTML
 *   GET /api/paper/daily-report?key=...&dryRun=1                   -> builds and returns the text WITHOUT sending or marking the day sent (safe to test with, any time of day)
 *   GET /api/paper/daily-report?key=...&force=1                    -> sends to Telegram right now regardless of time-of-day or whether today was already sent (for testing the real send path)
 */
const { istParts } = require('../../../../paperbot/time');
const { sendTelegram } = require('../../../../paperbot/report');
const { closedTradesByBot, openTradesByBot } = require('./fetch');
const { buildDailyReport } = require('./report');

const CATCHUP_WINDOW_MIN = 6 * 60; // "send on next start within 6 hours" of the missed 05:00
const LAST_SENT_KEY = 'dailyReportLastSentDate';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Builds the report from live data. Exposed separately from send() so the manual ?dryRun=1 route never marks the day sent. */
async function build(ctx, now = Date.now()) {
  const [closedByBot, openByBot] = await Promise.all([closedTradesByBot(ctx), openTradesByBot(ctx)]);
  return buildDailyReport({ now, closedByBot, openByBot });
}

/**
 * Sends today's report if it has not already gone out today, honouring the catch-up window on a
 * startup check. Returns { sent, reason, report? }. Never throws - a Telegram or database failure is
 * logged and reported back, same as every other publish() in paperbot/report.js.
 */
async function maybeSend(ctx, { now = Date.now(), isStartup = false, force = false } = {}) {
  const { store, env, axios, log } = ctx;
  const p = istParts(now);
  const minutesPast5am = p.minutes - 5 * 60;
  if (!force) {
    const cfg = await store.getConfig().catch(() => ({}));
    if (cfg[LAST_SENT_KEY] === p.date) return { sent: false, reason: 'already sent today' };
    if (minutesPast5am < 0) return { sent: false, reason: 'before 05:00 IST' };
    if (isStartup && minutesPast5am > CATCHUP_WINDOW_MIN) return { sent: false, reason: 'missed catch-up window (>6h past 05:00)' };
  }
  const report = await build(ctx, now);
  const sent = await sendTelegram(axios, env, report.text, log);
  try { await store.setConfig(LAST_SENT_KEY, p.date); } catch (e) { log(`[daily-report] could not store last-sent date: ${e.message}`); }
  log(`[daily-report] ${p.date}: ${sent ? 'sent to Telegram' : 'Telegram not sent (missing env or request failed)'}`);
  return { sent, reason: sent ? 'sent' : 'telegram send failed', report };
}

function renderHtml(report) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Paper: Daily report</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:12px;color:#1c1f24;background:#fff;white-space:pre-wrap}</style></head><body>${esc(report.text)}</body></html>`;
}

module.exports = {
  name: 'daily-report',
  buildDailyReport: build, maybeSend, // reused directly by tests
  async register(ctx) {
    const { app, env, log, cron, tz, guarded } = ctx;
    const job = guarded ? (fn) => guarded('daily report', fn, log) : (fn) => fn;
    if (cron) cron.schedule('0 5 * * *', job(() => maybeSend(ctx)), tz);
    // Startup catch-up check (file header above) - fire-and-forget like every other plugin's startup work.
    maybeSend(ctx, { isStartup: true }).catch((e) => log(`[daily-report] startup check failed: ${e.message}`));

    app.get('/api/paper/daily-report', async (req, res) => {
      res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' });
      const secret = env.PAPER_ADMIN_SECRET || env.RENEW_SECRET;
      if (!secret) return res.status(503).type('text').send('PAPER_ADMIN_SECRET not configured');
      if ((req.get('x-paper-secret') || req.query.key) !== secret) return res.status(401).type('text').send('Unauthorized');
      try {
        if (req.query.dryRun) {
          const report = await build(ctx);
          if (req.query.format === 'json') return res.json(report);
          return res.type('html').send(renderHtml(report));
        }
        const result = await maybeSend(ctx, { now: Date.now(), isStartup: false, force: !!req.query.force });
        const report = result.report || await build(ctx);
        if (req.query.format === 'json') return res.json({ ...report, sent: result.sent, reason: result.reason });
        return res.type('html').send(renderHtml(report));
      } catch (e) {
        log(`[daily-report] could not build the report: ${e.message}`);
        return res.status(500).type('text').send('could not read paper bot data');
      }
    });
    log('[daily-report] ready (PAPER ONLY; sends at 05:00 IST; manual: GET /api/paper/daily-report?key=...)');
  },
};
