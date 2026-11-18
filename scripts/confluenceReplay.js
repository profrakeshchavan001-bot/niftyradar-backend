#!/usr/bin/env node
'use strict';
// GROUP 5: replay/backtest for confluence (Bot A) ONLY, using the existing replay/candle framework
// (src/paper/replay/) and the replay_candles store - READ-ONLY, this script never writes a candle row.
// Chronological 60% train / 40% test split, no parameter tuning on the test split (CONFLUENCE_DEFAULTS run
// unchanged against both), fees included via Bot A's own settle() (the same fee+slippage model
// src/paper/scalp/engine.js's settle() uses, mirrored exactly - see src/paper/bots/confluence/engine.js).
//
// confluence_flow (Bot B) has NO replay and cannot be backtested here: its decide() needs a live
// bid/ask-depth + recent-trades order-flow reading, and this repo stores no historical order-book data,
// only candles (see src/paper/replay/store.js). This script says so plainly below rather than silently
// only covering Bot A.
//
// Usage: node scripts/confluenceReplay.js [--json]
//   PAPER_DATABASE_URL must be set (same database the live replay history job already fills via
//   src/paper/replay/history.js) - without it there is no stored candle history to replay, and this
//   script says so and exits cleanly rather than inventing a result.
const { createPgReplayStore } = require('../src/paper/replay/store');
const { replayConfluence } = require('../src/paper/replay/adapters/confluence');
const { CONFLUENCE_DEFAULTS } = require('../src/paper/bots/confluence/config');
const { buildReport } = require('../src/paper/replay/stats');

const FIVE_MIN = 5 * 60000;
const TRAIN_FRACTION = 0.6;

function round2(x) { return Number.isFinite(x) ? Math.round(x * 100) / 100 : null; }

function avgRr(trades) {
  const withRr = trades.filter((t) => Number.isFinite(t.rr));
  return withRr.length ? round2(withRr.reduce((s, t) => s + t.rr, 0) / withRr.length) : null;
}

// Splits a chronologically-sorted candle array at the 60/40 boundary BY TIME (not by trade count), so the
// split is a real "first 60% of the calendar window", decided before a single trade is simulated - no
// parameter tuning on the test split follows: CONFLUENCE_DEFAULTS is the one config run against both.
function splitCandles(candles) {
  if (!candles.length) return { train: [], test: [], cutoffT: null };
  const start = candles[0].t; const end = candles[candles.length - 1].t;
  const cutoffT = start + (end - start) * TRAIN_FRACTION;
  return { train: candles.filter((k) => k.t <= cutoffT), test: candles.filter((k) => k.t > cutoffT), cutoffT };
}

function summarise(trades) {
  const o = buildReport(trades).overall;
  return {
    trades: o.trades,
    tooFew: !!o.tooFew,
    winRatePct: o.winRatePct ?? null,
    netInr: o.netInr ?? null,
    avgRr: avgRr(trades),
    maxDrawdownInr: o.maxDrawdownInr ?? null,
    note: o.note,
  };
}

async function main() {
  const asJson = process.argv.includes('--json');
  const url = process.env.PAPER_DATABASE_URL;
  const out = { botA: 'confluence', botB: 'confluence_flow', botBNote: 'confluence_flow (Bot B) cannot be replayed here: it needs a live bid/ask order-book + recent-trades reading, and no historical order-book is stored in this repo - only candles. See docs/CONFLUENCE-BOT.md.' };
  if (!url) {
    out.error = 'PAPER_DATABASE_URL is not set - no stored replay candle history to read. Set it (the same database the live replay history job fills) and run again.';
    console.log(asJson ? JSON.stringify(out, null, 2) : out.error);
    process.exitCode = 1;
    return;
  }
  const { Pool } = require('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new Pool({ connectionString: url, max: 1, ssl: local ? false : { rejectUnauthorized: false } });
  const store = createPgReplayStore(() => pool);
  try {
    out.symbols = {};
    const allTrain = []; const allTest = [];
    for (const symbol of CONFLUENCE_DEFAULTS.symbols) {
      // eslint-disable-next-line no-await-in-loop
      const candles = await store.getCandles(symbol, '5m', {});
      if (candles.length < 60) { out.symbols[symbol] = { error: `not enough stored 5-min candles (${candles.length}) to replay` }; continue; }
      const { train, test, cutoffT } = splitCandles(candles);
      const trainTrades = replayConfluence({ symbol, candles5m: train });
      const testTrades = replayConfluence({ symbol, candles5m: test }); // CONFLUENCE_DEFAULTS unchanged - no tuning on the test split
      allTrain.push(...trainTrades); allTest.push(...testTrades);
      out.symbols[symbol] = { candles: candles.length, cutoffAt: cutoffT ? new Date(cutoffT).toISOString() : null, train: summarise(trainTrades), test: summarise(testTrades) };
    }
    out.combined = { train: summarise(allTrain), test: summarise(allTest) };
    console.log(asJson ? JSON.stringify(out, null, 2) : [
      `confluence (Bot A) replay - train/test split at ${Math.round(TRAIN_FRACTION * 100)}%/${Math.round((1 - TRAIN_FRACTION) * 100)}%, no tuning on the test split`,
      ...Object.entries(out.symbols).map(([s, r]) => (r.error ? `${s}: ${r.error}` : `${s}: train ${JSON.stringify(r.train)} | test ${JSON.stringify(r.test)}`)),
      `COMBINED train: ${JSON.stringify(out.combined.train)}`,
      `COMBINED test:  ${JSON.stringify(out.combined.test)}`,
      '',
      out.botBNote,
    ].join('\n'));
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(`[confluence-replay] failed: ${e.message}`); process.exitCode = 1; });
}

module.exports = { splitCandles, summarise, main };
