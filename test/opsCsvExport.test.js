'use strict';
// Overnight item 4: GET /api/paper/export.csv (src/paper/ops/csvExport.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { toCsv, csvEscape, exportCsv, attachCsvRoute, ALL_MARKETS } = require('../src/paper/ops/csvExport');
const { createMemoryStore } = require('../paperbot/store');

test('csvEscape: quotes only when needed (comma, quote, newline), doubles inner quotes', () => {
  assert.equal(csvEscape('plain'), 'plain');
  assert.equal(csvEscape('a,b'), '"a,b"');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"');
  assert.equal(csvEscape(null), '');
  assert.equal(csvEscape(undefined), '');
  assert.equal(csvEscape(42), '42');
});

test('toCsv: header + one row per trade, in column order, trailing newline', () => {
  const csv = toCsv([{ symbol: 'RELIANCE', pnl_inr: 4200 }, { symbol: 'TCS', pnl_inr: -1500 }], ['symbol', 'pnl_inr']);
  assert.equal(csv, 'symbol,pnl_inr\nRELIANCE,4200\nTCS,-1500\n');
});

test('exportCsv trades: combines every market in ALL_MARKETS when none is given', async () => {
  const store = createMemoryStore();
  await store.insertTrade({ market: 'nse', symbol: 'RELIANCE', trade_date: '2026-11-14', status: 'closed', direction: 'CALL', entry_price: 20, exit_price: 22, pnl_inr: 4200, exit_reason: 'target', basis: 'b1' });
  await store.insertTrade({ market: 'nse_scalp', symbol: 'TCS', trade_date: '2026-11-14', status: 'open', direction: 'PUT', entry_price: 30, basis: 'b2' });
  await store.insertTrade({ market: 'crypto', symbol: 'BTCUSDT', trade_date: '2026-11-13', status: 'closed', direction: 'LONG', entry_price: 100000, exit_price: 101000, pnl_inr: 880, exit_reason: 'target', basis: 'b3' }); // different day: excluded
  const { filename, csv } = await exportCsv({ store, type: 'trades', date: '2026-11-14' });
  assert.equal(filename, 'paper-trades-2026-11-14.csv');
  const rows = csv.trim().split('\n');
  assert.equal(rows.length, 3); // header + 2 trades on that day
  assert.match(rows[1], /^nse,RELIANCE,2026-11-14,closed,CALL,20,22,4200,target,b1$/);
  assert.match(rows[2], /^nse_scalp,TCS,2026-11-14,open,PUT,30,,,,b2$/);
});

test('exportCsv trades: a market filter narrows to exactly that market', async () => {
  const store = createMemoryStore();
  await store.insertTrade({ market: 'nse', symbol: 'A', trade_date: '2026-11-14', status: 'open', entry_price: 1, basis: 'b' });
  await store.insertTrade({ market: 'nse_scalp', symbol: 'B', trade_date: '2026-11-14', status: 'open', entry_price: 1, basis: 'b' });
  const { filename, csv } = await exportCsv({ store, type: 'trades', date: '2026-11-14', market: 'nse_scalp' });
  assert.equal(filename, 'paper-trades-2026-11-14-nse_scalp.csv');
  assert.equal(csv.trim().split('\n').length, 2); // header + the one nse_scalp row
});

test('exportCsv skips: grouped by exact day, basis columns only (market, symbol, skip_date, reason)', async () => {
  const store = createMemoryStore();
  await store.insertSkip({ market: 'nse', symbol: 'INFY', skip_date: '2026-11-14', reason: 'RSI 71 > 70' });
  await store.insertSkip({ market: 'nse', symbol: 'WIPRO', skip_date: '2026-11-13', reason: 'old' }); // different day: excluded
  const { filename, csv } = await exportCsv({ store, type: 'skips', date: '2026-11-14' });
  assert.equal(filename, 'paper-skips-2026-11-14.csv');
  assert.equal(csv, 'market,symbol,skip_date,reason\nnse,INFY,2026-11-14,RSI 71 > 70\n');
});

test('exportCsv: an empty day still returns a valid header-only CSV (no fabricated rows)', async () => {
  const { csv } = await exportCsv({ store: createMemoryStore(), type: 'trades', date: '2026-11-14' });
  assert.equal(csv, 'market,symbol,trade_date,status,direction,entry_price,exit_price,pnl_inr,exit_reason,basis\n');
});

test('ALL_MARKETS matches the market CHECK constraint families (nse/nse_scalp, crypto/crypto_scalp/crypto_wide_scalp)', () => {
  assert.deepEqual(ALL_MARKETS, ['nse', 'nse_scalp', 'crypto', 'crypto_scalp', 'crypto_wide_scalp']);
});

test('route: 401 without the secret; 400 without a date; 200 with a correct Content-Disposition', async () => {
  const app = express();
  const secret = 'shh';
  const okSecret = (given) => given === secret;
  const store = createMemoryStore();
  await store.insertTrade({ market: 'nse', symbol: 'RELIANCE', trade_date: '2026-11-14', status: 'open', entry_price: 1, basis: 'b' });
  attachCsvRoute(app, { secret, okSecret, state: { store } });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const noKey = await fetch(`http://localhost:${port}/api/paper/export.csv?date=2026-11-14`);
    assert.equal(noKey.status, 401);
    const noDate = await fetch(`http://localhost:${port}/api/paper/export.csv?key=shh`);
    assert.equal(noDate.status, 400);
    const ok = await fetch(`http://localhost:${port}/api/paper/export.csv?key=shh&date=2026-11-14`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.match(ok.headers.get('content-disposition'), /attachment; filename="paper-trades-2026-11-14\.csv"/);
    const body = await ok.text();
    assert.match(body, /RELIANCE/);
  } finally { server.close(); }
});

test('route: 503 when the bot has not started yet (no store), never a crash', async () => {
  const app = express();
  attachCsvRoute(app, { secret: 'shh', okSecret: () => true, state: { store: null } });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/export.csv?key=shh&date=2026-11-14`);
    assert.equal(res.status, 503);
  } finally { server.close(); }
});
