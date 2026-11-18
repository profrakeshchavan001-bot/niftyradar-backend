#!/usr/bin/env node
'use strict';
// Group 3d (2026-11): backfills `net_after_fees_corrected` for every CLOSED intraday ('crypto' market,
// paper_trades), intraday-MIRROR (intraday_mirror_trades) and intraday-REVERSE (intraday_reverse_trades)
// trade that was closed BEFORE the Group 3a fee fix (paperbot/engine.js's settle() now charges the same
// per-side fee + slippage model scalp_wide already uses). Those old rows have cost_usdt/gross_pnl_usdt
// NULL (the fee-less booking never set them) and pnl_inr computed WITHOUT any cost - this script NEVER
// touches pnl_inr/cost_usdt/gross_pnl_usdt/net_pnl_usdt on an existing row; it only fills in the new
// net_after_fees_corrected column (sql/paper_bot.sql, src/paper/bots/intraday_mirror|intraday_reverse/
// schema.sql - idempotent ALTER ... ADD COLUMN IF NOT EXISTS), computed via the SAME settle() the live
// bot now calls, using each row's own stored entry_price/exit_price/qty/direction/fx_rate.
//
// DRY RUN by default (prints what it would write, writes nothing). `-- --apply` actually writes.
// Idempotent either way: a row with net_after_fees_corrected already set is left alone (its own field
// never changes on a second run), so this can be re-run safely (e.g. after a later batch of trades
// closes, though those will already carry the real number directly and need no backfill at all).
//
// Usage: node scripts/intradayFeeBackfill.js [--apply]
// Needs PAPER_DATABASE_URL (the paper bot's OWN Postgres, never DATABASE_URL/Neon).
const { Pool } = require('pg');
const { settle } = require('../paperbot/engine');

const APPLY = process.argv.includes('--apply');
const HARD_FALLBACK_FX = 88; // same last-resort rate src/paper/ops/telegramAlerts/format.js uses when a row has none

async function backfillTable(pool, table, { marketFilter = false } = {}) {
  // paper_trades holds every market (nse/crypto/...) - restrict to 'crypto' (intraday), the only one
  // this fee fix touches; LONG/SHORT direction only, never CALL/PUT. The two dedicated mirror/reverse
  // tables hold intraday rows exclusively already, so they need no such filter.
  const { rows } = await pool.query(
    `SELECT id, direction, entry_price, exit_price, qty, fx_rate FROM ${table}
     WHERE status = 'closed' AND exit_price IS NOT NULL AND cost_usdt IS NULL AND net_after_fees_corrected IS NULL
     ${marketFilter ? "AND market = 'crypto'" : ''}`,
  );
  let wouldWrite = 0;
  for (const r of rows) {
    const trade = { direction: r.direction, entry_price: Number(r.entry_price), qty: Number(r.qty) };
    const fxRate = r.fx_rate != null && Number(r.fx_rate) > 0 ? Number(r.fx_rate) : HARD_FALLBACK_FX;
    const s = settle({ trade, exitPrice: Number(r.exit_price), cfg: {}, fxRate });
    wouldWrite += 1;
    if (APPLY) {
      await pool.query(`UPDATE ${table} SET net_after_fees_corrected = $1 WHERE id = $2`, [s.pnl_inr, r.id]);
    } else {
      console.log(`[dry-run] ${table}#${r.id}: pnl_inr stays ${r.exit_price != null ? 'unchanged' : 'n/a'}; net_after_fees_corrected would be set to ${s.pnl_inr}`);
    }
  }
  console.log(`${table}: ${rows.length} row(s) ${APPLY ? 'updated' : 'would be updated'}`);
  return wouldWrite;
}

async function main() {
  const url = process.env.PAPER_DATABASE_URL;
  if (!url) { console.error('PAPER_DATABASE_URL is not set - refusing to run (this backfill only ever touches the paper bot\'s own database).'); process.exitCode = 1; return; }
  const pool = new Pool({ connectionString: url, max: 2, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
  try {
    console.log(APPLY ? 'APPLYING backfill (writes net_after_fees_corrected; pnl_inr/cost_usdt/gross_pnl_usdt are never touched).' : 'DRY RUN (nothing is written - pass --apply to write).');
    let total = 0;
    total += await backfillTable(pool, 'paper_trades', { marketFilter: true });
    total += await backfillTable(pool, 'intraday_mirror_trades');
    total += await backfillTable(pool, 'intraday_reverse_trades');
    console.log(`Total: ${total} row(s) ${APPLY ? 'updated' : 'would be updated'}.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exitCode = 1; });

module.exports = { backfillTable };
