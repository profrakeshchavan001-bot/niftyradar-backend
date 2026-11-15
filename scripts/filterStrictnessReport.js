#!/usr/bin/env node
'use strict';
// Task Group B CLI: prints the filter-strictness report (src/paper/decision/filterStrictness.js) as
// markdown. READ-ONLY - connects to the paper bot's own database (PAPER_DATABASE_URL), reads
// paper_skips and closed paper_trades through the existing store, writes nothing anywhere.
// Usage: node scripts/filterStrictnessReport.js [--json]
const { createPgStore } = require('../paperbot/store');
const { buildFilterStrictnessReport, toMarkdown } = require('../src/paper/decision/filterStrictness');

async function main() {
  const url = process.env.PAPER_DATABASE_URL;
  if (!url) {
    console.error('[filter-strictness-report] PAPER_DATABASE_URL is not set. The live bot keeps its data in '
      + 'memory only without it, which this script cannot read from outside the running process. Set '
      + 'PAPER_DATABASE_URL (same free Supabase project the bot uses) and run again.');
    process.exitCode = 1;
    return;
  }
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({ connectionString: url, max: 1, ssl: local ? false : { rejectUnauthorized: false } });
  const store = createPgStore(() => pool);
  try {
    // No limit cap (unlike listSkips/listTrades, which clamp to 500) - skipsSince/closedTrades(null)
    // return every stored row in range, which is what a strictness tally needs.
    const [skips, closedTrades] = await Promise.all([store.skipsSince('2000-01-01'), store.closedTrades()]);
    const report = buildFilterStrictnessReport({ skips, closedTrades });
    if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else console.log(toMarkdown(report));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error('[filter-strictness-report] failed:', e && e.message ? e.message : e);
  process.exitCode = 1;
});
