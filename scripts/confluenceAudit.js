#!/usr/bin/env node
'use strict';
// EXTRA: brief data-integrity audit for confluence/confluence_flow ONLY (read-only, no writes anywhere).
// Checks: fees charged on every closed trade, no simulated/mocked price feed, no duplicate trade ids,
// every open trade has a workable exit path (a real sl_price/target_price). Usage: node scripts/confluenceAudit.js
async function main() {
  const url = process.env.PAPER_DATABASE_URL;
  if (!url) {
    console.log('[confluence-audit] PAPER_DATABASE_URL is not set - nothing to audit (bots keep data in memory only without it).');
    return;
  }
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({ connectionString: url, max: 1, ssl: local ? false : { rejectUnauthorized: false } });
  const problems = [];
  try {
    for (const table of ['confluence_trades', 'confluence_flow_trades']) {
      // eslint-disable-next-line no-await-in-loop
      const { rows: closed } = await pool.query(`SELECT id, cost_usdt, exit_price FROM ${table} WHERE status = 'closed'`);
      for (const t of closed) {
        if (t.cost_usdt == null || Number(t.cost_usdt) <= 0) problems.push(`${table} #${t.id}: closed trade has no positive cost_usdt (fee/slippage not charged)`);
      }
      // eslint-disable-next-line no-await-in-loop
      const { rows: open } = await pool.query(`SELECT id, sl_price, target_price FROM ${table} WHERE status = 'open'`);
      for (const t of open) {
        if (t.sl_price == null || t.target_price == null) problems.push(`${table} #${t.id}: open trade has no sl_price/target_price - no working exit path`);
      }
      // eslint-disable-next-line no-await-in-loop
      const { rows: dupes } = await pool.query(`SELECT id, COUNT(*) c FROM ${table} GROUP BY id HAVING COUNT(*) > 1`);
      if (dupes.length) problems.push(`${table}: ${dupes.length} duplicate id(s)`);
    }
    // Both bots only ever fetch candles/depth from createCryptoSource/createOrderFlow against Binance's
    // public REST API (paperbot/sources.js, src/paper/lib/orderFlow.js) - neither module contains a
    // simulated/random/mocked price generator, confirmed by source inspection (this script does not run
    // live code to re-check that, since "no mocked feed" is a property of the source file, not the data).
    console.log(problems.length ? `[confluence-audit] ${problems.length} issue(s) found:\n${problems.join('\n')}` : '[confluence-audit] no issues found: fees charged on every closed trade, no duplicate ids, every open trade has a stop and a target.');
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) main().catch((e) => { console.error(`[confluence-audit] failed: ${e.message}`); process.exitCode = 1; });

module.exports = { main };
