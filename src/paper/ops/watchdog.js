'use strict';
/**
 * Self-healing backstop for the cron scheduler (root-cause fix, 14 Nov outage round 2).
 *
 * Every job already catches its own errors and times itself out (paperbot/index.js's `guarded()`), and every
 * job records its last run into the shared health tracker. Neither of those helps if the cron tick itself stops
 * firing - this has one job: every `checkEveryMs`, look at the tracker for every 24/7 job in `jobRegistry` and,
 * if one has not ticked in over `staleMs`, call that job's own guarded+tracked function directly. The call goes
 * through the exact same function cron would have called, so it is still error-caught, still timed-out, still
 * recorded - this only supplies the missing tick, never bypasses the safety nets already wrapped around it.
 *
 * What this does NOT fix: a process that is fully asleep (Render free tier, no inbound traffic) runs no
 * JavaScript at all, this watchdog included. That half of the root cause is fixed by the external keep-alive
 * pinger (README, GET /health) which keeps the process awake in the first place; this watchdog is the second
 * half, for an awake process whose own scheduler stops advancing for any other reason.
 */
function createWatchdog({ tracker, jobRegistry, log = console.log, staleMs = 3 * 60 * 1000, checkEveryMs = 60 * 1000, now = Date.now, skipNames = [] }) {
  let timer = null;

  function checkOnce() {
    const snap = tracker.snapshot();
    const t = now();
    for (const [name, fn] of Object.entries(jobRegistry || {})) {
      if (skipNames.includes(name) || typeof fn !== 'function') continue;
      const j = snap.jobs[name];
      const age = j ? t - j.lastRunAt : Infinity;
      if (age > staleMs) {
        const ageMin = Number.isFinite(age) ? Math.round(age / 60000) : null;
        log(`[watchdog] ${name}: no tick in ${ageMin == null ? 'any recorded time' : `${ageMin} min`} - forcing a run now`);
        Promise.resolve().then(fn).catch((e) => log(`[watchdog] ${name} forced run failed: ${e && e.message ? e.message : e}`));
      }
    }
  }

  return {
    checkOnce,
    start() {
      if (!timer) {
        timer = setInterval(checkOnce, checkEveryMs);
        if (timer.unref) timer.unref();
      }
      return this;
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = { createWatchdog };
