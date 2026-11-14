'use strict';
// Live-bot safety guard (round 2, item 2): replay must never slow the live bot on Render Free (512 MB).
// Automatic runs (the 02:00 IST cron) are skipped -- never started -- when the live bot's own health page
// (src/paper/ops/health.js) reports PROBLEM, or when this process's own memory is already high. A manual
// run (?key=... /api/paper/replay/run) is never blocked by this: the owner asked for it directly.
const { buildHealth, defaultTracker } = require('../ops/health');

const DEFAULT_MEMORY_CAP_MB = 400; // Render Free is 512 MB; leave headroom for the live bot and its own jobs

// `liveState`/`liveStore` are the main paperbot state/store (the same ones passed to attachReplay as
// `liveStore`); without them (e.g. the live bot could not build its store) this never blocks -- an unchecked
// condition is never treated as a problem, it is just not checked, and that is logged.
async function shouldSkipAutoRun({ liveState = null, liveStore = null, tracker = null, memoryCapMb = DEFAULT_MEMORY_CAP_MB, now = Date.now, log = () => {} } = {}) {
  let health;
  try {
    health = await buildHealth({ tracker: tracker || defaultTracker(), store: liveStore, state: liveState, now: now() });
  } catch (e) {
    log(`[replay] safety check could not read the live bot's health; proceeding (unchecked, not treated as a problem): ${e.message}`);
    return { skip: false, reason: null, health: null };
  }
  if (health.status === 'PROBLEM') return { skip: true, reason: `live bot health is PROBLEM: ${health.reason}`, health };
  const rssMb = health.memory ? health.memory.rssMb : null;
  if (rssMb != null && rssMb > memoryCapMb) return { skip: true, reason: `memory ${rssMb} MB is over the ${memoryCapMb} MB cap (Render Free is 512 MB)`, health };
  return { skip: false, reason: null, health };
}

module.exports = { shouldSkipAutoRun, DEFAULT_MEMORY_CAP_MB };
