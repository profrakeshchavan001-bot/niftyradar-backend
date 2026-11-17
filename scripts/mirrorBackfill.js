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
const { settle: settleIntraday } = require('../paperbot/engine');
const { loadConfig, DEFAULTS: PAPERBOT_DEFAULTS } = require('../paperbot/config');
const { createPgExhaustionStore } = require('../src/paper/bots/exhaustion_only/store');
const { settle: settleExhaustion } = require('../src/paper/bots/exhaustion_only/engine');
const { loadExhaustionConfig, EXHAUSTION_ONLY_DEFAULTS } = require('../src/paper/bots/exhaustion_only/config');
const { createPgTrendSmcStore } = require('../src/paper/bots/trend_smc/store');
const { settle: settleTrendSmc } = require('../src/paper/bots/trend_smc/engine');
const { loadTrendSmcConfig, TREND_SMC_DEFAULTS } = require('../src/paper/bots/trend_smc/config');
const { settle: settleScalp } = require('../src/paper/scalp/engine');
const { loadScalpConfig, loadScalpWideConfig, SCALP_DEFAULTS, SCALP_WIDE_DEFAULTS } = require('../src/paper/scalp/config');
const { MARKET: SCALP_MARKET, MARKET_WIDE: SCALP_WIDE_MARKET } = require('../src/paper/scalp/bot');
const { createPgMcxStore } = require('../src/paper/lib/mcxStore');
const { loadMcxGoldConfig, MCX_GOLD_DEFAULTS } = require('../src/paper/bots/mcx_gold/config');
const { loadMcxCrudeConfig, MCX_CRUDE_DEFAULTS } = require('../src/paper/bots/mcx_crude/config');
const { createPgMirrorStore } = require('../src/paper/lib/mirrorStore');
const { createMirrorBot } = require('../src/paper/lib/mirrorBot');
const { computeBotStats } = require('../src/paper/bots/leaderboard/stats');
// "Capital used" in the report (Task: add capital to the mirror backfill report - this report never
// showed capital at all before): reuses the SAME pure computeCapitalState() the live Telegram capital
// line uses (src/paper/ops/telegramAlerts/format.js), fed this bot's own currently-open trades, so the
// "locked" math (entry_price x qty, each trade's own fx_rate) is never duplicated or re-invented here.
const { computeCapitalState } = require('../src/paper/ops/telegramAlerts/format');

const REPORT_PATH = path.join(__dirname, '..', 'docs', 'MIRROR-BACKFILL-REPORT.md');

// One row per bot being backfilled: how to read its original trades, its own settle()/cfg, and the
// mirror table it writes to. `originalStore` only ever needs allOpenTrades()/closedTrades() - the same
// minimal interface createMirrorBot() calls (src/paper/lib/mirrorBot.js). `capitalTotal` is each bot's
// own already-configured demo capital - the SAME *_DEFAULTS.capital_usdt convention
// src/paper/ops/telegramAlerts/register.js already uses for the live alert's capital line, never a new
// number invented for this report; a mirror reports the SAME total as the original it mirrors (no
// mirror-specific capital config exists anywhere in this repo, same assumption docs/BOTS.md documents).
function buildJobs({ mainStore, pool, usdInrFallback } = {}) {
  const exhaustionStore = createPgExhaustionStore(pool);
  const trendSmcStore = createPgTrendSmcStore(pool);
  const mcxGoldStore = createPgMcxStore(pool, 'mcx_gold_trades');
  const mcxCrudeStore = createPgMcxStore(pool, 'mcx_crude_trades');
  return [
    {
      // intraday (the main crypto bot, paperbot/bot.js's cryptoScan/cryptoMonitor): no own table, reads
      // the shared paper_trades filtered to the 'crypto' market only, same shape as the scalp/scalp_wide
      // jobs below. settle() is paperbot/engine.js's new export (added for this mirror - see its own
      // comment); loadCfg mirrors what paperbot/bot.js's cryptoScan/cryptoMonitor themselves read
      // ((await loadConfig(mainStore)).crypto), not re-invented here.
      bot: 'intraday', mirrorLabel: 'intraday-MIRROR', mirrorTable: 'intraday_mirror_trades',
      originalStore: { allOpenTrades: () => mainStore.openTrades('crypto'), closedTrades: () => mainStore.closedTrades('crypto') },
      settle: settleIntraday, loadCfg: async () => (await loadConfig(mainStore)).crypto,
      capitalTotal: PAPERBOT_DEFAULTS.crypto.capital_usdt, usdInrFallback,
    },
    {
      bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', mirrorTable: 'exhaustion_only_mirror_trades',
      originalStore: exhaustionStore, settle: settleExhaustion, loadCfg: () => loadExhaustionConfig(mainStore),
      capitalTotal: EXHAUSTION_ONLY_DEFAULTS.capital_usdt, usdInrFallback,
    },
    {
      bot: 'trend_smc', mirrorLabel: 'trend_smc-MIRROR', mirrorTable: 'trend_smc_mirror_trades',
      originalStore: trendSmcStore, settle: settleTrendSmc, loadCfg: () => loadTrendSmcConfig(mainStore),
      capitalTotal: TREND_SMC_DEFAULTS.capital_usdt, usdInrFallback,
    },
    {
      bot: 'scalp', mirrorLabel: 'scalp-MIRROR', mirrorTable: 'scalp_mirror_trades',
      originalStore: { allOpenTrades: () => mainStore.openTrades(SCALP_MARKET), closedTrades: () => mainStore.closedTrades(SCALP_MARKET) },
      settle: settleScalp, loadCfg: () => loadScalpConfig(mainStore),
      capitalTotal: SCALP_DEFAULTS.capital_usdt, usdInrFallback,
    },
    {
      bot: 'scalp_wide', mirrorLabel: 'scalp_wide-MIRROR', mirrorTable: 'scalp_wide_mirror_trades',
      originalStore: { allOpenTrades: () => mainStore.openTrades(SCALP_WIDE_MARKET), closedTrades: () => mainStore.closedTrades(SCALP_WIDE_MARKET) },
      settle: settleScalp, loadCfg: () => loadScalpWideConfig(mainStore),
      capitalTotal: SCALP_WIDE_DEFAULTS.capital_usdt, usdInrFallback,
    },
    // mcx_gold / mcx_crude (this task): own tables (src/paper/bots/mcx_gold, mcx_crude), reuse the same
    // scalp_wide settle() (src/paper/scalp/engine.js) their own bot.js uses. nativeInr: true - their
    // prices/qty are already INR (the proxy source converts before the bot ever sees a candle, fx_rate
    // always 1), so computeCapitalState must not apply a second USD->INR conversion (see sideSummary below).
    {
      bot: 'mcx_gold', mirrorLabel: 'mcx_gold-MIRROR', mirrorTable: 'mcx_gold_mirror_trades',
      originalStore: mcxGoldStore, settle: settleScalp, loadCfg: () => loadMcxGoldConfig(mainStore),
      capitalTotal: MCX_GOLD_DEFAULTS.capital_inr, usdInrFallback, nativeInr: true,
    },
    {
      bot: 'mcx_crude', mirrorLabel: 'mcx_crude-MIRROR', mirrorTable: 'mcx_crude_mirror_trades',
      originalStore: mcxCrudeStore, settle: settleScalp, loadCfg: () => loadMcxCrudeConfig(mainStore),
      capitalTotal: MCX_CRUDE_DEFAULTS.capital_inr, usdInrFallback, nativeInr: true,
    },
  ];
}

// gross/net INR + win rate/fees for one side (original or mirror), from computeBotStats() (pure, already
// unit-tested in test/paperLeaderboard.test.js) - no new stats math here. `open` (that side's own
// currently-open trades) + `capitalTotal` feed computeCapitalState() for the "capital used" (locked)
// figure (Task: add capital to this report) - capitalTotalInr/capitalUsedInr are null, never 0 or
// guessed, when there is no capitalTotal or no USDINR_FALLBACK rate to express it in rupees with.
function sideSummary(closed, open = [], { capitalTotal, usdInrFallback, nativeInr = false } = {}) {
  const s = computeBotStats(closed, 1); // 1, not the usual 20-trade floor: a backfill wants every number, ranked or not
  const fx = nativeInr ? { rate: 1 } : (usdInrFallback ? { rate: Number(usdInrFallback) } : null);
  const capital = computeCapitalState({ capitalTotal, closedTrades: [], openTrades: open, nativeInr, usdInrFallback, fx });
  return {
    trades: s.trades, netPnlInr: s.netPnlInr, grossPnlInr: s.grossPnlInr, feesInr: s.costsInr, winRatePct: s.winRatePct,
    capitalTotalInr: capital ? capital.totalInr : null,
    capitalUsedInr: capital ? capital.lockedInr : null,
  };
}

async function runJob(job) {
  const mirrorStore = createPgMirrorStore(job.pool, job.mirrorTable);
  const bot = createMirrorBot({ originalStore: job.originalStore, mirrorStore, settle: job.settle, loadCfg: job.loadCfg, log: () => {}, label: job.bot });
  const { opened, closed } = await bot.sync(); // walks EVERY trade the original has ever recorded - no sampling
  const [originalClosed, mirrorClosed, originalOpen, mirrorOpen] = await Promise.all([
    job.originalStore.closedTrades(), mirrorStore.closedTrades(),
    job.originalStore.allOpenTrades(), mirrorStore.allOpenTrades(),
  ]);
  const sideOpts = { capitalTotal: job.capitalTotal, usdInrFallback: job.usdInrFallback, nativeInr: job.nativeInr };
  return {
    bot: job.bot, mirrorLabel: job.mirrorLabel, opened, closedThisRun: closed,
    original: sideSummary(originalClosed, originalOpen, sideOpts), mirror: sideSummary(mirrorClosed, mirrorOpen, sideOpts),
  };
}

function toMarkdown(rows, { generatedAt, dbConfigured }) {
  const inr = (v) => (v == null ? 'n/a' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);
  const pct = (v) => (v == null ? 'n/a' : `${v}%`);
  const inrPlain = (v) => (v == null ? 'n/a' : `₹${Math.round(v).toLocaleString('en-IN')}`); // a plain amount, never signed (capital, not P&L)
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
  out += '| Bot | Trades replayed | Original net P&L | Mirror net P&L | Win rate (orig vs mirror) | Fees (orig vs mirror) | Capital used (orig vs mirror) |\n';
  out += '|---|---|---|---|---|---|---|\n';
  for (const r of rows) {
    out += `| ${r.bot} (mirror: ${r.mirrorLabel}) | ${r.original.trades} | ${inr(r.original.netPnlInr)} | ${inr(r.mirror.netPnlInr)} | `
      + `${pct(r.original.winRatePct)} vs ${pct(r.mirror.winRatePct)} | ${inr(r.original.feesInr)} vs ${inr(r.mirror.feesInr)} | `
      + `${inrPlain(r.original.capitalUsedInr)} vs ${inrPlain(r.mirror.capitalUsedInr)} |\n`;
  }
  out += '\n## Per-bot detail\n\n';
  for (const r of rows) {
    out += `### ${r.bot}\n\n`;
    out += `- Mirror opened this run: ${r.opened}, mirror closed this run: ${r.closedThisRun}\n`;
    out += `- Original: ${r.original.trades} closed trades, gross ${inr(r.original.grossPnlInr)}, net ${inr(r.original.netPnlInr)}, `
      + `fees ${inr(r.original.feesInr)}, win rate ${pct(r.original.winRatePct)}, capital used ${inrPlain(r.original.capitalUsedInr)} of ${inrPlain(r.original.capitalTotalInr)}\n`;
    out += `- Mirror: ${r.mirror.trades} closed trades, gross ${inr(r.mirror.grossPnlInr)}, net ${inr(r.mirror.netPnlInr)}, `
      + `fees ${inr(r.mirror.feesInr)}, win rate ${pct(r.mirror.winRatePct)}, capital used ${inrPlain(r.mirror.capitalUsedInr)} of ${inrPlain(r.mirror.capitalTotalInr)}\n\n`;
  }
  return out;
}

async function main() {
  const url = process.env.PAPER_DATABASE_URL;
  const usdInrFallback = process.env.USDINR_FALLBACK;
  const generatedAt = new Date().toISOString();
  const zeroSide = { trades: 0, netPnlInr: 0, grossPnlInr: 0, feesInr: 0, winRatePct: null, capitalTotalInr: null, capitalUsedInr: null };
  if (!url) {
    const md = toMarkdown([
      { bot: 'intraday', mirrorLabel: 'intraday-MIRROR', opened: 0, closedThisRun: 0, original: zeroSide, mirror: zeroSide },
      { bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', opened: 0, closedThisRun: 0, original: zeroSide, mirror: zeroSide },
      { bot: 'trend_smc', mirrorLabel: 'trend_smc-MIRROR', opened: 0, closedThisRun: 0, original: zeroSide, mirror: zeroSide },
      { bot: 'scalp', mirrorLabel: 'scalp-MIRROR', opened: 0, closedThisRun: 0, original: zeroSide, mirror: zeroSide },
      { bot: 'scalp_wide', mirrorLabel: 'scalp_wide-MIRROR', opened: 0, closedThisRun: 0, original: zeroSide, mirror: zeroSide },
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
    const jobs = buildJobs({ mainStore, pool, usdInrFallback }).map((j) => ({ ...j, pool }));
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

// Only run main() when this file is actually executed as the CLI script (`node scripts/mirrorBackfill.js`
// / `npm run report:mirror-backfill`) - NOT merely required as a library. src/paper/ops/mirrorBackfillReport/
// (the production, DB-backed, Telegram-reporting job added after this script) reuses buildJobs()/runJob()
// by requiring this file; without this guard that require() would ALSO fire this script's own main() as a
// side effect - on a server with PAPER_DATABASE_URL set, that means a second, unflagged, unreported
// backfill run (and its own fresh `pg.Pool`) on every single `require()`, completely outside the one-time
// guard and Telegram report that job is responsible for.
if (require.main === module) {
  main().catch((e) => {
    console.error('[mirror-backfill] failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
  });
}

module.exports = { buildJobs, sideSummary, toMarkdown, runJob };
