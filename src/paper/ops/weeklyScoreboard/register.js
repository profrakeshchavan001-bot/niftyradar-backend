'use strict';
/**
 * GROUP 7: weekly Telegram scoreboard, sent once a week (Sunday 09:00 IST) to the same channel the daily
 * report already uses. Covers EVERY demo bot (existing ones included) via a READ-ONLY aggregation -
 * reuses src/paper/ops/dailyReport/fetch.js's closedTradesByBot() exactly as written, never alters any
 * bot's data, and never disables any bot. Auto-loaded by src/paper/pluginLoader.js.
 *
 * Idempotent across restarts, same mechanism as the daily report: the IST date already reported is stored
 * via the main store's getConfig/setConfig (no new table). A cron tick fires once at 09:00 IST on Sundays;
 * register() also checks once at startup so a restart around that time still sends exactly once.
 *
 * Manual trigger (same owner-only secret pattern as every other /api/paper/ report route):
 *   GET /api/paper/weekly-scoreboard?key=...                 -> builds, sends if not already sent this week, HTML back
 *   GET /api/paper/weekly-scoreboard?key=...&format=json      -> JSON back instead of HTML
 *   GET /api/paper/weekly-scoreboard?key=...&dryRun=1          -> builds and returns the text WITHOUT sending or marking sent
 *   GET /api/paper/weekly-scoreboard?key=...&force=1           -> sends right now regardless of day/time or already-sent
 */
const { istParts } = require('../../../../paperbot/time');
const { sendTelegram } = require('../../../../paperbot/report');
const { closedTradesByBot } = require('../dailyReport/fetch');
const { buildWeeklyScoreboard } = require('./report');

const CATCHUP_WINDOW_MIN = 6 * 60;
const LAST_SENT_KEY = 'weeklyScoreboardLastSentWeek'; // ISO week-ending date (the Sunday), so it only ever fires once per week

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function build(ctx, now = Date.now()) {
  const closedByBot = await closedTradesByBot(ctx);
  return buildWeeklyScoreboard({ now, closedByBot });
}

async function maybeSend(ctx, { now = Date.now(), isStartup = false, force = false } = {}) {
  const { store, env, axios, log } = ctx;
  const p = istParts(now);
  const minutesPast9am = p.minutes - 9 * 60;
  const isSunday = p.dow === 0;
  if (!force) {
    if (!isSunday) return { sent: false, reason: 'not Sunday' };
    const cfg = await store.getConfig().catch(() => ({}));
    if (cfg[LAST_SENT_KEY] === p.date) return { sent: false, reason: 'already sent this week' };
    if (minutesPast9am < 0) return { sent: false, reason: 'before 09:00 IST' };
    if (isStartup && minutesPast9am > CATCHUP_WINDOW_MIN) return { sent: false, reason: 'missed catch-up window (>6h past 09:00)' };
  }
  const report = await build(ctx, now);
  const sent = await sendTelegram(axios, env, report.text, log);
  try { await store.setConfig(LAST_SENT_KEY, p.date); } catch (e) { log(`[weekly-scoreboard] could not store last-sent week: ${e.message}`); }
  log(`[weekly-scoreboard] ${p.date}: ${sent ? 'sent to Telegram' : 'Telegram not sent (missing env or request failed)'}`);
  return { sent, reason: sent ? 'sent' : 'telegram send failed', report };
}

function renderHtml(report) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Paper: Weekly scoreboard</title>
<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:12px;color:#1c1f24;background:#fff;white-space:pre-wrap}</style></head><body>${esc(report.text)}</body></html>`;
}

module.exports = {
  name: 'weekly-scoreboard',
  buildWeeklyScoreboard: build, maybeSend,
  async register(ctx) {
    const { app, env, log, cron, tz, guarded } = ctx;
    const job = guarded ? (fn) => guarded('weekly scoreboard', fn, log) : (fn) => fn;
    if (cron) cron.schedule('0 9 * * 0', job(() => maybeSend(ctx)), tz); // Sunday 09:00 IST
    maybeSend(ctx, { isStartup: true }).catch((e) => log(`[weekly-scoreboard] startup check failed: ${e.message}`));

    app.get('/api/paper/weekly-scoreboard', async (req, res) => {
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
        log(`[weekly-scoreboard] could not build the report: ${e.message}`);
        return res.status(500).type('text').send('could not read paper bot data');
      }
    });
    log('[weekly-scoreboard] ready (PAPER ONLY, report-only; sends Sunday 09:00 IST; manual: GET /api/paper/weekly-scoreboard?key=...)');
  },
};
