'use strict';
// Storage for shadow_setups (docs/BOTS.md "Shadow tracking"): memory for tests / no-database mode, Postgres via a pool.query - same
// duality every other CC3 store module uses (src/paper/bots/exhaustion_only/store.js).
function createMemoryShadowStore() {
  const rows = []; let seq = 0;
  return {
    async insertShadow(s) {
      if (rows.some((r) => r.bot === s.bot && r.symbol === s.symbol && r.trigger_t === s.trigger_t)) return null; // one shadow per candle
      const row = { id: ++seq, status: 'open', ...s };
      rows.push(row);
      return row.id;
    },
    async openShadows(bot) { return rows.filter((r) => r.bot === bot && r.status === 'open').map((r) => ({ ...r })); },
    async resolveShadow(id, patch) { const r = rows.find((x) => x.id === id); if (r) Object.assign(r, { status: 'resolved', ...patch }); },
    async shadowsSince(bot, date) { return rows.filter((r) => r.bot === bot && r.setup_date >= date).map((r) => ({ ...r })); },
    _db: { rows },
  };
}

function createPgShadowStore(pool) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  return {
    async insertShadow(s) {
      const cols = Object.keys(s); const vals = Object.values(s);
      const r = await pool.query(
        `INSERT INTO shadow_setups (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (bot, symbol, trigger_t) DO NOTHING RETURNING id`,
        vals,
      );
      return r.rows[0]?.id ?? null;
    },
    openShadows: (bot) => q("SELECT * FROM shadow_setups WHERE bot = $1 AND status = 'open' ORDER BY id", [bot]),
    async resolveShadow(id, patch) {
      const cols = Object.keys(patch); if (!cols.length) return;
      const sets = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
      await pool.query(`UPDATE shadow_setups SET status = 'resolved', ${sets} WHERE id = $1`, [id, ...Object.values(patch)]);
    },
    shadowsSince: (bot, date) => q('SELECT * FROM shadow_setups WHERE bot = $1 AND setup_date >= $2 ORDER BY id', [bot, date]),
  };
}

module.exports = { createMemoryShadowStore, createPgShadowStore };
