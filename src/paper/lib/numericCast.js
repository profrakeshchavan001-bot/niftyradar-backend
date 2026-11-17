'use strict';
// Shared cast for a Postgres NUMERIC/DECIMAL column, which node-pg always returns as a STRING (never a
// JS number, to avoid silently losing precision on a value the driver cannot represent exactly). Every
// store that declares price/qty/pnl columns `numeric` needs the exact same fix - first found and fixed
// for the 5 mirror tables (src/paper/lib/mirrorStore.js, PR #69: "mirror n/a" on every bot's stats
// because plain `+`/`-` on a string either concatenates or silently produces NaN, never a thrown error).
// One helper, reused everywhere a store reads real Postgres `numeric` columns, instead of a bespoke copy
// per store.

/**
 * Casts every column named in `columns` to a real JS number when present and non-null; every other
 * field (status, symbol, direction, exit_reason, basis, timestamps, bigint ids, ...) passes through
 * unchanged. A null/undefined numeric column stays null/undefined - never coerced into 0 or NaN. Safe
 * on a row that lacks some columns (a partial SELECT).
 */
function castNumericColumns(row, columns = TRADE_NUMERIC_COLUMNS) {
  if (!row) return row;
  const out = { ...row };
  for (const c of columns) if (out[c] != null) out[c] = Number(out[c]);
  return out;
}

/**
 * Superset of every numeric column across every bot's trades table (original and mirror, every
 * schema.sql in src/paper/bots/ and the shared sql/paper_bot.sql): price/qty/pnl/fee/fx columns. Safe to
 * use against ANY of these tables - a column this list names that a given table does not have is simply
 * absent from the row and skipped (see castNumericColumns above). Reused by every reader of a Postgres
 * trade row that does not already have its own narrower list (src/paper/bots/leaderboard/register.js,
 * src/paper/lib/mcxStore.js, src/paper/ops/dailyReport/fetch.js) - one list, not a bespoke copy each time.
 */
const TRADE_NUMERIC_COLUMNS = [
  'entry_price', 'exit_price', 'sl_price', 'target_price', 'qty', 'rr', 'r_factor',
  'gross_pnl_usdt', 'cost_usdt', 'net_pnl_usdt', 'gross_pnl_inr', 'pnl_inr', 'net_pnl_inr', 'cost_inr', 'fx_rate',
];

module.exports = { castNumericColumns, TRADE_NUMERIC_COLUMNS };
