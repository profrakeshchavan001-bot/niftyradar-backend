'use strict';
// Generic REVERSE bot wrapper (src/paper/lib/reverseBot.js): sync() opens a reverse trade for every
// original trade not reversed yet (mirrorBot.js's own sync() pattern, reused as-is for the open side);
// monitor() is the real difference from MIRROR - REVERSE has its own independent levels, so it needs its
// own candle-by-candle exit check, reusing the ORIGINAL bot's own evaluateExit/settle() shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReverseBot, FIVE_MIN_MONITOR_GAP_MS } = require('../src/paper/lib/reverseBot');
const { createMemoryMirrorStore } = require('../src/paper/lib/mirrorStore');

function originalStoreOf(trades) {
  return {
    allOpenTrades: async () => trades.filter((t) => t.status === 'open'),
    closedTrades: async () => trades.filter((t) => t.status === 'closed'),
  };
}

test('sync: opens exactly one reverse trade per original, idempotent on a second call', async () => {
  const originals = [{ id: 1, symbol: 'BTCUSDT', trade_date: '2026-11-01', trigger_t: 1, direction: 'LONG', entry_price: 100, entry_time: 't', qty: 1, sl_price: 95, target_price: 110, status: 'open' }];
  const reverseStore = createMemoryMirrorStore();
  const bot = createReverseBot({ originalStore: originalStoreOf(originals), reverseStore, fetchCandles: async () => [], evaluateExitFn: () => ({ exit: false }), settle: () => ({}), loadCfg: () => ({}), log: () => {} });
  const r1 = await bot.sync();
  assert.equal(r1.opened, 1);
  const open = await reverseStore.allOpenTrades();
  assert.equal(open.length, 1);
  assert.equal(open[0].direction, 'SHORT');
  assert.equal(open[0].original_trade_id, 1);
  const r2 = await bot.sync();
  assert.equal(r2.opened, 0, 'the second sync is a no-op (unique original_trade_id index)');
});

test('monitor: closes a reverse trade when evaluateExitFn says its OWN target/stop was hit, settling with the given settle()', async () => {
  const originals = [{ id: 1, symbol: 'BTCUSDT', trade_date: '2026-11-01', trigger_t: 1, direction: 'LONG', entry_price: 100, entry_time: '2026-11-01T00:00:00.000Z', qty: 2, sl_price: 95, target_price: 110, status: 'closed', exit_price: 95, exit_reason: 'stop', exit_time: '2026-11-01T01:00:00.000Z' }];
  const reverseStore = createMemoryMirrorStore();
  let settleCalls = 0;
  const settle = ({ trade, exitPrice }) => { settleCalls += 1; return { gross_pnl_usdt: (exitPrice - trade.entry_price) * trade.qty * -1, net_pnl_usdt: 0, pnl_inr: 0 }; };
  const bot = createReverseBot({
    originalStore: originalStoreOf(originals), reverseStore, settle,
    fetchCandles: async () => [{ t: 0, h: 91, l: 89, o: 90, c: 90 }], // SHORT reverse: target 90 is hit
    evaluateExitFn: (trade) => ({ exit: true, reason: 'target', price: trade.target_price }),
    loadCfg: () => ({}), log: () => {},
  });
  await bot.sync();
  const r = await bot.monitor(Date.parse('2026-11-01T02:00:00.000Z'));
  assert.deepEqual([r.checked, r.closed], [1, 1]);
  assert.equal(settleCalls, 1);
  const closed = await reverseStore.closedTrades();
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exit_reason, 'target');
  assert.equal(closed[0].exit_price, 90); // reverse's own target, not the original's
});

test('monitor: a reverse trade still open (evaluateExitFn says no exit) stays open, and a candle-fetch failure for one symbol never stops the others', async () => {
  const originals = [
    { id: 1, symbol: 'BTCUSDT', trade_date: '2026-11-01', trigger_t: 1, direction: 'LONG', entry_price: 100, entry_time: 't1', qty: 1, sl_price: 95, target_price: 110, status: 'open' },
    { id: 2, symbol: 'ETHUSDT', trade_date: '2026-11-01', trigger_t: 1, direction: 'SHORT', entry_price: 200, entry_time: 't2', qty: 1, sl_price: 210, target_price: 180, status: 'open' },
  ];
  const reverseStore = createMemoryMirrorStore();
  const bot = createReverseBot({
    originalStore: originalStoreOf(originals), reverseStore, settle: () => ({}),
    fetchCandles: async (symbol) => { if (symbol === 'BTCUSDT') throw new Error('feed down'); return [{ t: 0, h: 1, l: 1, o: 1, c: 1 }]; },
    evaluateExitFn: () => ({ exit: false }),
    loadCfg: () => ({}), log: () => {},
  });
  await bot.sync();
  const r = await bot.monitor();
  assert.equal(r.checked, 2);
  assert.equal(r.closed, 0);
  const open = await reverseStore.allOpenTrades();
  assert.equal(open.length, 2, 'both reverse trades remain open - neither bad-feed nor no-exit closes anything');
});

test('monitor: exit_time uses evaluateExitFn\'s own timeMs (scalp/scalp_wide convention) when given, else the monitor tick\'s own clock (intraday convention)', async () => {
  const originals = [{ id: 1, symbol: 'BTCUSDT', trade_date: '2026-11-01', trigger_t: 1, direction: 'LONG', entry_price: 100, entry_time: 't', qty: 1, sl_price: 95, target_price: 110, status: 'open' }];

  const withTimeMs = createMemoryMirrorStore();
  const bot1 = createReverseBot({ originalStore: originalStoreOf(originals), reverseStore: withTimeMs, settle: () => ({}), fetchCandles: async () => [1], evaluateExitFn: () => ({ exit: true, reason: 'target', price: 90, timeMs: Date.parse('2026-06-01T00:00:00.000Z') }), loadCfg: () => ({}), log: () => {} });
  await bot1.sync(); await bot1.monitor(Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal((await withTimeMs.closedTrades())[0].exit_time, '2026-06-01T00:00:00.000Z');

  const withoutTimeMs = createMemoryMirrorStore();
  const bot2 = createReverseBot({ originalStore: originalStoreOf(originals), reverseStore: withoutTimeMs, settle: () => ({}), fetchCandles: async () => [1], evaluateExitFn: () => ({ exit: true, reason: 'target', price: 90 }), loadCfg: () => ({}), log: () => {} });
  await bot2.sync(); await bot2.monitor(Date.parse('2026-11-01T00:00:00.000Z'));
  assert.equal((await withoutTimeMs.closedTrades())[0].exit_time, '2026-11-01T00:00:00.000Z');
});

// --- root-cause fix (backfill bug report problem 4): monitor() must never resolve a trade against
// candles that cannot actually reach back to its own entry - that produced absurd "time in trade"
// durations (exit_time stamped from a real but unrelated recent candle, entry_time stays old). ---

test('monitor: a trade whose earliest available candle is well after its own entry is skipped, not resolved on unrelated data', async () => {
  const entryTime = '2026-01-01T00:00:00.000Z'; // weeks before any candle this fetch can actually return
  const originals = [{ id: 1, symbol: 'BTCUSDT', trade_date: '2026-01-01', trigger_t: 1, direction: 'LONG', entry_price: 100, entry_time: entryTime, qty: 1, sl_price: 95, target_price: 110, status: 'open' }];
  const reverseStore = createMemoryMirrorStore();
  let evaluated = 0;
  const bot = createReverseBot({
    originalStore: originalStoreOf(originals), reverseStore, settle: () => ({}),
    // earliest candle is weeks after entry_time - no real history for this trade
    fetchCandles: async () => [{ t: Date.parse('2026-02-01T00:00:00.000Z'), h: 200, l: 1, o: 1, c: 1 }],
    evaluateExitFn: () => { evaluated += 1; return { exit: true, reason: 'target', price: 90 }; },
    loadCfg: () => ({}), log: () => {},
  });
  await bot.sync();
  const r = await bot.monitor(Date.parse('2026-02-01T00:10:00.000Z'));
  assert.equal(r.checked, 1);
  assert.equal(r.closed, 0, 'never closed on candles that do not cover its own entry');
  assert.equal(evaluated, 0, 'evaluateExitFn is never even called for this trade');
  const open = await reverseStore.allOpenTrades();
  assert.equal(open.length, 1, 'stays open rather than resolving on unrelated recent candles');
});

test('monitor: a trade whose earliest candle is within the normal fetch/alignment gap of its own entry is still evaluated', async () => {
  const entryTime = '2026-01-01T00:00:00.000Z';
  const originals = [{ id: 1, symbol: 'BTCUSDT', trade_date: '2026-01-01', trigger_t: 1, direction: 'LONG', entry_price: 100, entry_time: entryTime, qty: 1, sl_price: 95, target_price: 110, status: 'open' }];
  const reverseStore = createMemoryMirrorStore();
  let evaluated = 0;
  const bot = createReverseBot({
    originalStore: originalStoreOf(originals), reverseStore, settle: () => ({}),
    // earliest candle just 1 interval after entry - well inside the allowed gap
    fetchCandles: async () => [{ t: Date.parse(entryTime) + 300000, h: 1, l: 1, o: 1, c: 1 }],
    evaluateExitFn: () => { evaluated += 1; return { exit: false }; },
    loadCfg: () => ({}), log: () => {},
  });
  await bot.sync();
  await bot.monitor(Date.parse(entryTime) + 600000);
  assert.equal(evaluated, 1);
});

test('FIVE_MIN_MONITOR_GAP_MS: exactly 2 five-minute candles (10 minutes), the documented tolerance', () => {
  assert.equal(FIVE_MIN_MONITOR_GAP_MS, 10 * 60000);
});
