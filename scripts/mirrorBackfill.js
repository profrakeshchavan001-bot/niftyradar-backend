#!/usr/bin/env node
'use strict';
// Mirror backfill (docs/BOTS.md "Mirror bots"): replays EVERY historical closed trade of every
// original bot as a mirror trade - no sampling. This reuses the EXACT SAME createMirrorBot().sync()
// every live <bot>_mirror/register.js schedules on a cron (src/paper/lib/mirrorBot.js): sync() already
// walks ALL of a bot's trades (open + closed), not only new ones, so running it once here against the
// production database backfills every trade that predates the mirror bots' own first cron tick -
// nothing is re-implemented, nothing is sampled. READ-ONLY on every ORIGINAL table; writes only to each
// bot's own *_mirror_trades table (via the same createPgMirrorStore() the live mirror bots use).
//
// Produces a per-bot summary (total trades replayed, original vs mirror INR P&L, win rate, fees impact)
// as markdown, written to docs/MIRROR-BACKFILL-REPORT.md and printed to the console.
//
// Usage: node scripts/mirrorBackfill.js [--json]
const fs = require('fs');
const path = require('path');

const { createPgStore } = require('../paperbot/store');
const { createPgExhaustionStore } = require('../src/paper/bots/exhaustion_only/store');
const { settle: settleExhaustion } = require('../src/paper/bots/exhaustion_only/engine');
const { loadExhaustionConfig } = require('../src/paper/bots/exhaustion_only/config');
const { createPgTrendSmcStore } = require('../src/paper/bots/trend_smc/store');
const { settle: settleTrendSmc } = require('../src/paper/bots/trend_smc/engine');
const { loadTrendSmcConfig } = require('../src/paper/bots/trend_smc/config');
const { settle: settleScalp } = require('../src/paper/scalp/engine');
const { loadScalpConfig, loadScalpWideConfig } = require('../src/paper/scalp/config');
const { MARKET: SCALP_MARKET, MARKET_WIDE: SCALP_WIDE_MARKET } = require('../src/paper/scalp/bot');
const { createPgMirrorStore } = require('../src/paper/lib/mirrorStore');
const { createMirrorBot } = require('../src/paper/lib/mirrorBot');
const { computeBotStats } = require('../src/paper/bots/leaderboard/stats');

const REPORT_PATH = path.join(__dirname, '..', 'docs', 'MIRROR-BACKFILL-REPORT.md');

// One row per bot being backfilled: how to read its original trades, its own settle()/cfg, and the
// mirror table it writes to. `originalStore` only ever needs allOpenTrades()/closedTrades() - the same
// minimal interface createMirrorBot() calls (src/paper/lib/mirrorBot.js).
function buildJobs({ mainStore, pool }) {
  const exhaustionStore = createPgExhaustionStore(pool);
  const trendSmcStore = createPgTrendSmcStore(pool);
  return [
    {
      bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', mirrorTable: 'exhaustion_only_mirror_trades',
      originalStore: exhaustionStore, settle: settleExhaustion, loadCfg: () => loadExhaustionConfig(mainStore),
    },
    {
      bot: 'trend_smc', mirrorLabel: 'trend_smc-MIRROR', mirrorTable: 'trend_smc_mirror_trades',
      originalStore: trendSmcStore, settle: settleTrendSmc, loadCfg: () => loadTrendSmcConfig(mainStore),
    },
    {
      bot: 'scalp', mirrorLabel: 'scalp-MIRROR', mirrorTable: 'scalp_mirror_trades',
      originalStore: { allOpenTrades: () => mainStore.openTrades(SCALP_MARKET), closedTrades: () => mainStore.closedTrades(SCALP_MARKET) },
      settle: settleScalp, loadCfg: () => loadScalpConfig(mainStore),
    },
    {
      bot: 'scalp_wide', mirrorLabel: 'scalp_wide-MIRROR', mirrorTable: 'scalp_wide_mirror_trades',
      originalStore: { allOpenTrades: () => mainStore.openTrades(SCALP_WIDE_MARKET), closedTrades: () => mainStore.closedTrades(SCALP_WIDE_MARKET) },
      settle: settleScalp, loadCfg: () => loadScalpWideConfig(mainStore),
    },
  ];
}

// gross/net INR + win rate/fees for one side (original or mirror), from computeBotStats() (pure, already
// unit-tested in test/paperLeaderboard.test.js) - no new stats math here.
function sideSummary(closed) {
  const s = computeBotStats(closed, 1); // 1, not the usual 20-trade floor: a backfill wants every number, ranked or not
  return { trades: s.trades, netPnlInr: s.netPnlInr, grossPnlInr: s.grossPnlInr, feesInr: s.costsInr, winRatePct: s.winRatePct };
}

async function runJob(job) {
  const mirrorStore = createPgMirrorStore(job.pool, job.mirrorTable);
  const bot = createMirrorBot({ originalStore: job.originalStore, mirrorStore, settle: job.settle, loadCfg: job.loadCfg, log: () => {}, label: job.bot });
  const { opened, closed } = await bot.sync(); // walks EVERY trade the original has ever recorded - no sampling
  const [originalClosed, mirrorClosed] = await Promise.all([job.originalStore.closedTrades(), mirrorStore.closedTrades()]);
  return {
    bot: job.bot, mirrorLabel: job.mirrorLabel, opened, closedThisRun: closed,
    original: sideSummary(originalClosed), mirror: sideSummary(mirrorClosed),
  };
}

function toMarkdown(rows, { generatedAt, dbConfigured }) {
  const inr = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
  const pct = (v) => (v == null ? 'n/a' : `${v}%`);
  let out = '# Mirror backfill report\n\n';
  out += `Generated: ${generatedAt}\n\n`;
  out += 'Every MIRROR bot (docs/BOTS.md "Mirror bots") takes the exact opposite side of its original bot\'s '
    + 'trade - same entry price/time and qty, direction flipped, target/stop swapped (mirror target = the '
    + 'original\'s own stop price, mirror stop = the original\'s own target price) - and settles with the '
    + 'SAME settle()/cost model as the original (src/paper/lib/mirror.js). This report replays EVERY '
    + 'historical closed trade of every original bot into its mirror, with no sampling, by running the '
    + 'same sync() the live mirror bots schedule on a cron (src/paper/lib/mirrorBot.js), then compares the '
    + 'two sides.\n\n';
  if (!dbConfigured) {
    out += '> **PAPER_DATABASE_URL was not set when this report was generated**, so there is no live trade '
      + 'history to read in this environment - every number below is 0. The backfill mechanism itself '
      + '(src/paper/lib/mirror.js, mirrorStore.js, mirrorBot.js and scripts/mirrorBackfill.js) is fully '
      + 'implemented and unit-tested (test/paperMirror.test.js, test/paperMirrorBot.test.js); re-run '
      + '`node scripts/mirrorBackfill.js` with `PAPER_DATABASE_URL` set to the production database to '
      + 'populate this report with real numbers.\n\n';
  }
  out += '| Bot | Trades replayed | Original net P&L | Mirror net P&L | Win rate (orig vs mirror) | Fees (orig vs mirror) |\n';
  out += '|---|---|---|---|---|---|\n';
  for (const r of rows) {
    out += `| ${r.bot} (mirror: ${r.mirrorLabel}) | ${r.original.trades} | ${inr(r.original.netPnlInr)} | ${inr(r.mirror.netPnlInr)} | `
      + `${pct(r.original.winRatePct)} vs ${pct(r.mirror.winRatePct)} | ${inr(r.original.feesInr)} vs ${inr(r.mirror.feesInr)} |\n`;
  }
  out += '\n## Per-bot detail\n\n';
  for (const r of rows) {
    out += `### ${r.bot}\n\n`;
    out += `- Mirror opened this run: ${r.opened}, mirror closed this run: ${r.closedThisRun}\n`;
    out += `- Original: ${r.original.trades} closed trades, gross ${inr(r.original.grossPnlInr)}, net ${inr(r.original.netPnlInr)}, `
      + `fees ${inr(r.original.feesInr)}, win rate ${pct(r.original.winRatePct)}\n`;
    out += `- Mirror: ${r.mirror.trades} closed trades, gross ${inr(r.mirror.grossPnlInr)}, net ${inr(r.mirror.netPnlInr)}, `
      + `fees ${inr(r.mirror.feesInr)}, win rate ${pct(r.mirror.winRatePct)}\n\n`;
  }
  return out;
}

async function main() {
  const url = process.env.PAPER_DATABASE_URL;
  const generatedAt = new Date().toISOString();
  if (!url) {
    const md = toMarkdown([
      { bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', opened: 0, closedThisRun: 0, original: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null }, mirror: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null } },
      { bot: 'trend_smc', mirrorLabel: 'trend_smc-MIRROR', opened: 0, closedThisRun: 0, original: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null }, mirror: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null } },
      { bot: 'scalp', mirrorLabel: 'scalp-MIRROR', opened: 0, closedThisRun: 0, original: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null }, mirror: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null } },
      { bot: 'scalp_wide', mirrorLabel: 'scalp_wide-MIRROR', opened: 0, closedThisRun: 0, original: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null }, mirror: { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null } },
    ], { generatedAt, dbConfigured: false });
    fs.writeFileSync(REPORT_PATH, md);
    console.log(`[mirror-backfill] PAPER_DATABASE_URL is not set - wrote a zero-trade report to ${REPORT_PATH}. `
      + 'Set PAPER_DATABASE_URL to the production database and run again for real numbers.');
    return;
  }
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({ connectionString: url, max: 1, ssl: local ? false : { rejectUnauthorized: false } });
  const mainStore = createPgStore(() => pool);
  try {
    const jobs = buildJobs({ mainStore, pool }).map((j) => ({ ...j, pool }));
    const rows = [];
    for (const job of jobs) rows.push(await runJob(job)); // sequential: a backfill is a one-off, never time-critical
    if (process.argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
    const md = toMarkdown(rows, { generatedAt, dbConfigured: true });
    fs.writeFileSync(REPORT_PATH, md);
    console.log(md);
    console.log(`[mirror-backfill] report written to ${REPORT_PATH}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('[mirror-backfill] failed:', e && e.message ? e.message : e);
  process.exitCode = 1;
});

module.exports = { buildJobs, sideSummary, toMarkdown };
