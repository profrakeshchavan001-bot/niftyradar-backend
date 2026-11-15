'use strict';
// Root-cause fix (15 Nov outage round 3): sql/paper_bot.sql's paper_trades_market_check CHECK constraint used to
// be re-added TWICE, each time with a hand-typed, growing list - the first (narrower) ADD CONSTRAINT validated
// against every existing row immediately, so once a row already carried a later market value, re-running this
// file (which paperbot/store.js did on every query, once it had failed once) aborted before ever reaching the
// correct, wider constraint. Every job's every write then failed forever with "check constraint ... is violated
// by some row" - this is exactly the live Supabase failure on paper_trades id=2 (market 'crypto_wide_scalp').
//
// The second test below reproduces that failure against a REAL Postgres (set PAPER_DATABASE_URL to a throwaway
// instance; skipped otherwise, same convention as tools/stability-check.js) and proves today's sql/paper_bot.sql
// no longer hits it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PAPER_TRADES_MARKETS } = require('../src/paper/lib/paperTradeMarkets');

const sqlPath = path.join(__dirname, '..', 'sql', 'paper_bot.sql');
const sql = () => fs.readFileSync(sqlPath, 'utf8');

test('sql/paper_bot.sql: exactly ONE paper_trades_market_check statement, built from the full PAPER_TRADES_MARKETS list', () => {
  const text = sql();
  const adds = [...text.matchAll(/ADD CONSTRAINT paper_trades_market_check\s+CHECK \(market IN \(([^)]+)\)\)/g)];
  assert.equal(adds.length, 1, 'there must be exactly one ADD CONSTRAINT for this check - two is how the live outage happened');
  const list = adds[0][1];
  for (const m of PAPER_TRADES_MARKETS) assert.match(list, new RegExp(`'${m}'`), `market '${m}' (src/paper/lib/paperTradeMarkets.js) is missing from the SQL constraint`);
  assert.match(text.slice(adds[0].index, adds[0].index + 300), /NOT VALID/, 'the ADD CONSTRAINT must be NOT VALID so it can never fail against existing rows again');
});

test('sql/paper_bot.sql: the CREATE TABLE inline CHECK (fresh databases) also carries every market value', () => {
  const text = sql();
  const create = text.match(/CREATE TABLE IF NOT EXISTS paper_trades[\s\S]*?market\s+text NOT NULL CHECK \(market IN \(([^)]+)\)\)/);
  assert.ok(create, 'paper_trades.market must still have its inline CHECK on a fresh database');
  for (const m of PAPER_TRADES_MARKETS) assert.match(create[1], new RegExp(`'${m}'`));
});

const dbUrl = process.env.PAPER_DATABASE_URL;
(dbUrl ? test : test.skip)('real Postgres: a pre-existing crypto_wide_scalp row no longer breaks re-running the migration (set PAPER_DATABASE_URL to run this)', async (t) => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: dbUrl });
  const schema = `paper_markets_test_${Date.now()}`;
  try {
    await pool.query(`CREATE SCHEMA "${schema}"`);
    await pool.query(`SET search_path TO "${schema}"`);
    await pool.query(sql()); // first run: fresh tables
    await pool.query(
      `INSERT INTO paper_trades (market, symbol, trade_date, direction, patterns, trigger_candles, qty, entry_price, entry_time, basis)
       VALUES ('crypto_wide_scalp', 'ETHUSDT', CURRENT_DATE, 'LONG', '[]', '[]', 1, 1782.67, now(), 'x')`,
    );
    // The live failure: re-running the same migration file once a row already uses a market value a narrower,
    // earlier ADD CONSTRAINT in the file does not list. Must NOT throw.
    await assert.doesNotReject(() => pool.query(sql()));
    const row = (await pool.query(
      `SELECT conkey, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'paper_trades_market_check' AND connamespace = $1::regnamespace`,
      [schema],
    )).rows[0];
    assert.match(row.def, /crypto_wide_scalp/);
    const still = (await pool.query('SELECT market FROM paper_trades')).rows;
    assert.equal(still.length, 1, 'the pre-existing row must never be dropped by schema setup');
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await pool.end();
  }
});
