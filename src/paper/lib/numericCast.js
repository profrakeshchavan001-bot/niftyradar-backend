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
function castNumericColumns(row, columns) {
  if (!row) return row;
  const out = { ...row };
  for (const c of columns) if (out[c] != null) out[c] = Number(out[c]);
  return out;
}

module.exports = { castNumericColumns };
