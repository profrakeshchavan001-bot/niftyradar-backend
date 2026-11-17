'use strict';
/**
 * Overnight brief item 7: when a module has not scanned for 15 minutes, or a job has failed 3 times in a
 * row, store an alert row and send Telegram if configured. Nothing here changes settings automatically.
 *
 * Auto-loaded by src/paper/pluginLoader.js (folder convention: src/paper/ops/alerts/register.js +
 * schema.sql). Shares the same tracker as GET /api/paper/health and GET /api/paper/home
 * (src/paper/ops/health.js's defaultTracker()), so "15 minutes" here is exactly what those pages show.
 *
 * Honesty note: the overnight brief also asks for an alert when "a data source fails 3 times in a row".
 * There is no per-source (Binance/Yahoo/Dhan) failure count yet (see src/paper/ops/health.js's file
 * header) - only per-JOB failures are tracked. The alert below fires on 3 consecutive job failures, which
 * is related but not the same thing; real per-source alerting needs the same follow-up hook into
 * paperbot/sources.js / paperbot/yahoo.js that health.js's dataSources section is waiting on.
 *
 * Root-cause fix (night/weekend false alerts): nseScan/nseMonitor are CORRECTLY idle outside NSE market
 * hours (paperbot/time.js's nseSession - same gate src/paper/ops/health.js already uses for ALIVE vs
 * DEGRADED). Before this fix, `check()` judged every job's staleness the same way regardless of the
 * time of day, so it paged "nseScan/nseMonitor has not scanned in 15+ minutes" every night and every
 * weekend. Now an NSE job's staleness is only even looked at while the market is open; outside that
 * window nothing is raised and nothing is sent, for that job, full stop. Crypto jobs are unaffected -
 * no session gate, 24x7 as before.
 */
const path = require('path');
const { defaultTracker, JOB_NAMES, NSE_JOBS, STALE_MS } = require('../health');
const { nseSession } = require('../../../../paperbot/time');

const CONSEC_FAIL_THRESHOLD = 3;
const DEDUPE_MS = 15 * 60 * 1000; // never store/send the same alert more than once per 15 min

// `tracker` defaults to the shared singleton (same one GET /api/paper/health and /home read); tests pass
// their own createHealthTracker() instance instead so they never interfere with each other.
// `state` is the mutable paperbot state object (holds state.holidays, kept current by onConfig in
// paperbot/index.js); optional so a caller/test with no NSE holidays to report can omit it entirely.
function register({ cron, env, log, pool, tracker = defaultTracker(), state }) {
  const lastRaised = new Map(); // "kind:subject" -> ms, in-memory guard (works even without a database)

  async function raise(kind, subject, message, now) {
    const key = `${kind}:${subject}`;
    if (lastRaised.has(key) && now - lastRaised.get(key) < DEDUPE_MS) return;
    lastRaised.set(key, now);
    log(`[paper-alerts] ${kind} ${subject}: ${message}`);
    if (pool) {
      try { await pool.query('INSERT INTO paper_alerts (kind, subject, message) VALUES ($1, $2, $3)', [kind, subject, message]); }
      catch (e) { log(`[paper-alerts] could not store alert: ${e.message}`); }
    }
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      try {
        const { sendTelegram } = require('../../../../paperbot/report');
        await sendTelegram(require('axios'), env, `⚠️ Paper bot alert: ${message}`, log);
      } catch (e) { log(`[paper-alerts] Telegram send failed: ${e.message}`); }
    }
  }

  async function check(now = Date.now()) {
    const snap = tracker.snapshot();
    const session = nseSession(now, (state && state.holidays) || []);
    for (const name of JOB_NAMES) {
      // NSE closed (night, weekend, or a listed holiday): nseScan/nseMonitor are expected to be idle,
      // not stuck - send nothing for them. Crypto jobs (not in NSE_JOBS) are never gated: 24x7.
      if (NSE_JOBS.includes(name) && !session.open) continue;
      const j = snap.jobs[name];
      const staleFor = j ? now - j.lastRunAt : null;
      if (j == null || staleFor > STALE_MS) await raise('stale_job', name, `${name} has not scanned in 15+ minutes${j ? ` (last scan ${Math.round(staleFor / 60000)}m ago)` : ' (never scanned)'}`, now);
      const consec = snap.consecFailures[name] || 0;
      if (consec >= CONSEC_FAIL_THRESHOLD) await raise('consecutive_failures', name, `${name} failed ${consec} times in a row${j && j.error ? ` (last error: ${j.error})` : ''}`, now);
    }
  }

  cron.schedule('*/5 * * * *', () => check().catch((e) => log(`[paper-alerts] check failed: ${e.message}`)));
  return { check }; // exposed for tests
}

module.exports = { name: 'alerts', schemaSql: path.join(__dirname, 'schema.sql'), register, CONSEC_FAIL_THRESHOLD, DEDUPE_MS };
