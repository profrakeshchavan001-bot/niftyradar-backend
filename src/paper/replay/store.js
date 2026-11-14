'use strict';
// Replay engine storage. PAPER_DATABASE_URL only, never DATABASE_URL (rule from the overnight brief).
// Two stores with the same methods: createPgReplayStore(getPool) and createMemoryReplayStore() (used by tests
// and as a fallback when PAPER_DATABASE_URL is not set).
const fs = require('fs');
const path = require('path');

function createMemoryReplayStore() {
  const db = { candles: new Map(), progress: new Map(), runs: [], results: [], trades: [] };
  const key = (symbol, interval) => `${symbol}|${interval}`;
  let runSeq = 0; let resultSeq = 0; let tradeSeq = 0;
  return {
    kind: 'memory',
    async init() {},
    async upsertCandles(symbol, interval, rows) {
      const k = key(symbol, interval);
      if (!db.candles.has(k)) db.candles.set(k, new Map());
      const m = db.candles.get(k);
      for (const r of rows) m.set(r.t, r);
    },
    async getCandles(symbol, interval, { fromT = -Infinity, toT = Infinity } = {}) {
      const m = db.candles.get(key(symbol, interval));
      if (!m) return [];
      return [...m.values()].filter((r) => r.t >= fromT && r.t <= toT).sort((a, b) => a.t - b.t);
    },
    async lastCandleT(symbol, interval) {
      return db.progress.get(key(symbol, interval)) ?? null;
    },
    async setLastCandleT(symbol, interval, t) {
      const cur = db.progress.get(key(symbol, interval));
      if (cur == null || t > cur) db.progress.set(key(symbol, interval), t);
    },
    async createRun({ trigger, codeVersion, params }) {
      const row = { id: ++runSeq, started_at: new Date().toISOString(), finished_at: null, status: 'running', trigger, code_version: codeVersion, params, error: null };
      db.runs.push(row);
      return row.id;
    },
    async finishRun(id, { status, error = null, candlesLoaded = null, runtimeMs = null }) {
      const row = db.runs.find((r) => r.id === id);
      if (row) {
        row.status = status; row.error = error; row.finished_at = new Date().toISOString();
        row.params = { ...(row.params || {}), ...(candlesLoaded != null ? { candlesLoaded } : {}), ...(runtimeMs != null ? { runtimeMs } : {}) };
      }
    },
    async saveResult({ runId, strategy, variant, segment, scope, metrics }) {
      db.results.push({ id: ++resultSeq, run_id: runId, strategy, variant, segment, scope, metrics, created_at: new Date().toISOString() });
    },
    async saveTrades(runId, rows) {
      for (const r of rows) db.trades.push({ id: ++tradeSeq, run_id: runId, ...r });
    },
    async latestRun() {
      return db.runs.length ? db.runs[db.runs.length - 1] : null;
    },
    async resultsForRun(runId) {
      return db.results.filter((r) => r.run_id === runId);
    },
    async tradesForRun(runId) {
      return db.trades.filter((t) => t.run_id === runId);
    },
    _db: db,
  };
}

function createPgReplayStore(getPool) {
  let conn = null;
  let ready = null;
  const db = () => { if (!conn) conn = typeof getPool === 'function' ? getPool() : getPool; return conn; };
  const ensure = () => {
    if (!ready) {
      ready = db().query(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'sql', 'replay.sql'), 'utf8')).catch((e) => { ready = null; throw e; });
    }
    return ready;
  };
  const pool = { query: async (text, params) => { await ensure(); return db().query(text, params); } };
  return {
    kind: 'postgres',
    init: ensure,
    async upsertCandles(symbol, interval, rows) {
      if (!rows.length) return;
      await upsertCandlesReal(pool, symbol, interval, rows);
    },
    async getCandles(symbol, interval, { fromT = -Infinity, toT = Infinity } = {}) {
      const r = await pool.query('SELECT t, o, h, l, c, v FROM replay_candles WHERE symbol = $1 AND interval = $2 AND t >= $3 AND t <= $4 ORDER BY t',
        [symbol, interval, Number.isFinite(fromT) ? fromT : 0, Number.isFinite(toT) ? toT : Number.MAX_SAFE_INTEGER]);
      return r.rows.map((row) => ({ t: Number(row.t), o: Number(row.o), h: Number(row.h), l: Number(row.l), c: Number(row.c), v: Number(row.v) }));
    },
    async lastCandleT(symbol, interval) {
      const r = await pool.query('SELECT last_open_t FROM replay_history_progress WHERE symbol = $1 AND interval = $2', [symbol, interval]);
      return r.rows.length ? Number(r.rows[0].last_open_t) : null;
    },
    async setLastCandleT(symbol, interval, t) {
      await pool.query(`INSERT INTO replay_history_progress (symbol, interval, last_open_t) VALUES ($1, $2, $3)
        ON CONFLICT (symbol, interval) DO UPDATE SET last_open_t = GREATEST(replay_history_progress.last_open_t, EXCLUDED.last_open_t), updated_at = now()`, [symbol, interval, t]);
    },
    async createRun({ trigger, codeVersion, params }) {
      const r = await pool.query('INSERT INTO replay_runs (trigger, code_version, params) VALUES ($1, $2, $3) RETURNING id', [trigger, codeVersion, JSON.stringify(params || {})]);
      return r.rows[0].id;
    },
    async finishRun(id, { status, error = null, candlesLoaded = null, runtimeMs = null }) {
      const extra = { ...(candlesLoaded != null ? { candlesLoaded } : {}), ...(runtimeMs != null ? { runtimeMs } : {}) };
      await pool.query('UPDATE replay_runs SET status = $2, error = $3, finished_at = now(), params = params || $4::jsonb WHERE id = $1', [id, status, error, JSON.stringify(extra)]);
    },
    async saveResult({ runId, strategy, variant, segment, scope, metrics }) {
      await pool.query('INSERT INTO replay_results (run_id, strategy, variant, segment, scope, metrics) VALUES ($1, $2, $3, $4, $5, $6)',
        [runId, strategy, variant, segment, JSON.stringify(scope || {}), JSON.stringify(metrics)]);
    },
    async saveTrades(runId, rows) {
      for (const batch of chunk(rows, 200)) {
        for (const r of batch) {
          await pool.query(`INSERT INTO replay_trades (run_id, strategy, variant, segment, symbol, direction, entry_t, exit_t, entry_price, exit_price, exit_reason, stop_pct, target_pct, rr, pnl_inr, patterns)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [runId, r.strategy, r.variant, r.segment, r.symbol, r.direction, r.entry_t, r.exit_t, r.entry_price, r.exit_price, r.exit_reason, r.stop_pct, r.target_pct, r.rr, r.pnl_inr, JSON.stringify(r.patterns || [])]);
        }
      }
    },
    async latestRun() {
      const r = await pool.query('SELECT * FROM replay_runs ORDER BY id DESC LIMIT 1');
      return r.rows[0] || null;
    },
    async resultsForRun(runId) {
      const r = await pool.query('SELECT * FROM replay_results WHERE run_id = $1', [runId]);
      return r.rows.map((row) => ({ ...row, scope: row.scope, metrics: row.metrics }));
    },
    async tradesForRun(runId) {
      const r = await pool.query('SELECT * FROM replay_trades WHERE run_id = $1 ORDER BY entry_t', [runId]);
      return r.rows;
    },
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// symbol, interval, t, o, h, l, c, v = 8 columns -> 8 placeholders per row.
async function upsertCandlesReal(pool, symbol, interval, rows) {
  for (const batch of chunk(rows, 500)) {
    const values = [];
    const params = [];
    batch.forEach((r, i) => {
      const base = i * 8;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`);
      params.push(symbol, interval, r.t, r.o, r.h, r.l, r.c, r.v);
    });
    await pool.query(`INSERT INTO replay_candles (symbol, interval, t, o, h, l, c, v) VALUES ${values.join(', ')}
      ON CONFLICT (symbol, interval, t) DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v`, params);
  }
}

module.exports = { createMemoryReplayStore, createPgReplayStore };
