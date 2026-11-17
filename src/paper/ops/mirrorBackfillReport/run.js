'use strict';
/**
 * Runs the mirror backfill against the live database and turns the result into Telegram messages.
 * Reuses scripts/mirrorBackfill.js's buildJobs()/runJob() UNCHANGED - the exact same createMirrorBot().sync()
 * every live <bot>_mirror/register.js already schedules on a cron (src/paper/lib/mirrorBot.js) - nothing
 * about the replay itself is re-implemented here, only the Telegram report on top of it (report.js).
 * Used by both the one-time startup job and the protected manual re-trigger route (./register.js).
 */
const { buildJobs, runJob } = require('../../../../scripts/mirrorBackfill');
const { buildTelegramMessages } = require('./report');

async function runBackfillAndBuildReport({ mainStore, pool, usdInrFallback }) {
  const jobs = buildJobs({ mainStore, pool, usdInrFallback }).map((j) => ({ ...j, pool }));
  const rows = [];
  for (const job of jobs) rows.push(await runJob(job)); // sequential: a backfill is a one-off, never time-critical
  const generatedAt = new Date().toISOString();
  const messages = buildTelegramMessages(rows, { generatedAt });
  const tradeCount = rows.reduce((s, r) => s + r.original.trades + r.mirror.trades + (r.reverse ? r.reverse.trades : 0), 0);
  return { rows, messages, generatedAt, tradeCount };
}

module.exports = { runBackfillAndBuildReport };
