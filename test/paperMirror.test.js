'use strict';
// MIRROR bots (docs/BOTS.md "Mirror bots"): the exact opposite of an original bot's own trade - same
// entry price/time and qty, direction flipped, target/stop SWAPPED (mirror target = original's own stop
// price, mirror stop = original's own target price), closed at the SAME exit price/time as the original,
// settled with the SAME settle() the original bot uses (never a sign-flip hack). Covers the pure mirror
// math (src/paper/lib/mirror.js), the generic mirror store (mirrorStore.js) and the sync loop that wires
// them to any original bot's own store (mirrorBot.js), plus that every <bot>_mirror plugin is
// auto-discovered the same way every other bots/ plugin is (src/paper/pluginLoader.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { invertDirection, invertExitReason, buildMirrorEntry, buildMirrorExitPatch } = require('../src/paper/lib/mirror');
const { createMemoryMirrorStore } = require('../src/paper/lib/mirrorStore');
const { createMirrorBot } = require('../src/paper/lib/mirrorBot');
const { settle } = require('../src/paper/bots/exhaustion_only/engine');
const { findPluginDirs } = require('../src/paper/pluginLoader');

test('invertDirection: LONG<->SHORT, up<->down, CALL<->PUT; an unknown value passes through unchanged', () => {
  assert.equal(invertDirection('LONG'), 'SHORT');
  assert.equal(invertDirection('SHORT'), 'LONG');
  assert.equal(invertDirection('up'), 'down');
  assert.equal(invertDirection('down'), 'up');
  assert.equal(invertDirection('CALL'), 'PUT');
  assert.equal(invertDirection('PUT'), 'CALL');
  assert.equal(invertDirection('sideways'), 'sideways');
});

test('invertExitReason: target<->stop (which barrier was hit); breakeven/time are not a barrier, left as-is', () => {
  assert.equal(invertExitReason('target'), 'stop');
  assert.equal(invertExitReason('stop'), 'target');
  assert.equal(invertExitReason('breakeven'), 'breakeven');
  assert.equal(invertExitReason('breakeven_stop'), 'breakeven_stop');
  assert.equal(invertExitReason('time'), 'time');
});

test('buildMirrorEntry: BUY original -> SHORT mirror, same entry price/time/qty, target/stop swapped', () => {
  const original = {
    id: 42, symbol: 'BTCUSDT', trade_date: '2026-11-01', trigger_t: 1000, direction: 'LONG',
    entry_price: 100, entry_time: '2026-11-01T00:00:00.000Z', qty: 2,
    sl_price: 95, target_price: 110, stop_type: 'pattern low', target_type: 'swing high', rr: 2.1, basis: 'LONG because X',
  };
  const m = buildMirrorEntry(original);
  assert.equal(m.direction, 'SHORT');
  assert.equal(m.entry_price, 100);
  assert.equal(m.entry_time, original.entry_time);
  assert.equal(m.qty, 2);
  // the SWAP: mirror's target is the original's stop, mirror's stop is the original's target
  assert.equal(m.target_price, 95);
  assert.equal(m.sl_price, 110);
  assert.equal(m.status, 'open');
  assert.equal(m.original_trade_id, 42);
  assert.match(m.basis, /MIRROR of trade #42/);
});

test('buildMirrorEntry: SELL/SHORT original -> LONG mirror, target/stop swapped the same way', () => {
  const original = { id: 7, symbol: 'ETHUSDT', direction: 'SHORT', entry_price: 200, entry_time: 't', qty: 1, sl_price: 210, target_price: 180 };
  const m = buildMirrorEntry(original);
  assert.equal(m.direction, 'LONG');
  assert.equal(m.target_price, 210); // original's stop
  assert.equal(m.sl_price, 180); // original's target
});

// Invariant required by the task brief: for a BUY, target > entry > stop; for a SELL, target < entry < stop.
// Proves the SWAP preserves that invariant on the mirror's own (now opposite) side.
test('invariant: mirror of a BUY (target>entry>stop) is a SELL with target<entry<stop, and vice versa', () => {
  const buyOriginal = { id: 1, direction: 'LONG', entry_price: 100, sl_price: 90, target_price: 120, entry_time: 't', qty: 1, symbol: 'X' };
  assert.ok(buyOriginal.target_price > buyOriginal.entry_price && buyOriginal.entry_price > buyOriginal.sl_price);
  const mirrorOfBuy = buildMirrorEntry(buyOriginal);
  assert.equal(mirrorOfBuy.direction, 'SHORT');
  assert.ok(mirrorOfBuy.target_price < mirrorOfBuy.entry_price && mirrorOfBuy.entry_price < mirrorOfBuy.sl_price);

  const sellOriginal = { id: 2, direction: 'SHORT', entry_price: 100, sl_price: 110, target_price: 80, entry_time: 't', qty: 1, symbol: 'X' };
  assert.ok(sellOriginal.target_price < sellOriginal.entry_price && sellOriginal.entry_price < sellOriginal.sl_price);
  const mirrorOfSell = buildMirrorEntry(sellOriginal);
  assert.equal(mirrorOfSell.direction, 'LONG');
  assert.ok(mirrorOfSell.target_price > mirrorOfSell.entry_price && mirrorOfSell.entry_price > mirrorOfSell.sl_price);
});

test('buildMirrorExitPatch: original hit its TARGET (won) -> mirror is recorded as hitting its STOP (lost), same exit price/time', () => {
  const mirrorTrade = { direction: 'SHORT', entry_price: 100, qty: 2 };
  const original = { exit_price: 110, exit_time: 'T2', exit_reason: 'target', fx_rate: 88, fx_source: 'trade row' };
  const cfg = { fee_pct_per_side: 0.1, slippage_pct: 0.03 };
  const patch = buildMirrorExitPatch({ mirrorTrade, original, settleFn: settle, cfg, fxRateFallback: 88 });
  assert.equal(patch.status, 'closed');
  assert.equal(patch.exit_price, 110);
  assert.equal(patch.exit_time, 'T2');
  assert.equal(patch.exit_reason, 'stop'); // inverted: the original's target is the mirror's stop
  // settle() on the mirror's SHORT direction with price rising 100 -> 110 is a LOSS, confirming the sign is never flipped by hand
  assert.ok(patch.net_pnl_usdt < 0);
  assert.ok(patch.pnl_inr < 0);
});

test('buildMirrorExitPatch: original (SHORT) hit its STOP above entry (lost) -> mirror (LONG) hits its TARGET, with a positive net P&L', () => {
  const mirrorTrade = { direction: 'LONG', entry_price: 100, qty: 2 }; // mirror of a SHORT original that entered at 100
  const original = { exit_price: 110, exit_time: 'T3', exit_reason: 'stop', fx_rate: 88 }; // a SHORT's stop sits ABOVE its entry
  const cfg = { fee_pct_per_side: 0.1, slippage_pct: 0.03 };
  const patch = buildMirrorExitPatch({ mirrorTrade, original, settleFn: settle, cfg });
  assert.equal(patch.exit_reason, 'target'); // original's stop -> mirror's target
  assert.ok(patch.net_pnl_usdt > 0); // LONG mirror, price rose 100 -> 110: a real profit, not a sign-flip
});

test('mirror bot sync(): opens a mirror for every original trade, closes it when the original closes, never touches the original store', () => {
  const originalTrades = []; let seq = 0;
  const originalStore = {
    async allOpenTrades() { return originalTrades.filter((t) => t.status === 'open').map((t) => ({ ...t })); },
    async closedTrades() { return originalTrades.filter((t) => t.status === 'closed').map((t) => ({ ...t })); },
  };
  const open = (t) => { const row = { id: ++seq, status: 'open', ...t }; originalTrades.push(row); return row; };
  const close = (row, patch) => Object.assign(originalTrades.find((t) => t.id === row.id), { status: 'closed', ...patch });

  const mirrorStore = createMemoryMirrorStore();
  const cfg = { fee_pct_per_side: 0.1, slippage_pct: 0.03 };
  const bot = createMirrorBot({ originalStore, mirrorStore, settle, loadCfg: () => cfg, log: () => {}, label: 'test_mirror' });

  const t1 = open({ symbol: 'BTCUSDT', direction: 'LONG', entry_price: 100, entry_time: 't0', qty: 1, sl_price: 90, target_price: 120 });
  return bot.sync().then(async (r1) => {
    assert.deepEqual(r1, { opened: 1, closed: 0 });
    const openedMirror = (await mirrorStore.allOpenTrades())[0];
    assert.equal(openedMirror.direction, 'SHORT');
    assert.equal(openedMirror.original_trade_id, t1.id);
    assert.equal(openedMirror.status, 'open');

    // the original is still open: a second sync must not open a duplicate or close anything
    const r2 = await bot.sync();
    assert.deepEqual(r2, { opened: 0, closed: 0 });
    assert.equal((await mirrorStore.allOpenTrades()).length, 1);

    // original closes at its target (a win for the LONG) - the mirror must close too, at the same price/time
    close(t1, { exit_price: 120, exit_time: 't1', exit_reason: 'target', fx_rate: 88 });
    const r3 = await bot.sync();
    assert.deepEqual(r3, { opened: 0, closed: 1 });
    const closedMirror = (await mirrorStore.closedTrades())[0];
    assert.equal(closedMirror.exit_price, 120);
    assert.equal(closedMirror.exit_reason, 'stop'); // original's target -> mirror's stop
    assert.ok(closedMirror.net_pnl_usdt < 0); // mirror (SHORT) lost when price rose to the original's target

    // never writes anything back to the original's own store (sync() calls neither insertTrade nor updateTrade on it)
    assert.equal(originalTrades.length, 1);
    assert.equal(originalTrades[0].direction, 'LONG');
  });
});

test('mirror store: fully separate from any original - its own in-memory table, own ids, own balance', () => {
  const mirrorStore = createMemoryMirrorStore();
  return mirrorStore.insertTrade({ original_trade_id: 1, symbol: 'X', status: 'open', direction: 'SHORT', entry_price: 1, entry_time: 't', qty: 1, sl_price: 2, target_price: 0.5 }).then(async (id) => {
    assert.ok(id != null);
    // inserting a second mirror for the SAME original is a no-op (never a duplicate mirror of one original trade)
    const dupeId = await mirrorStore.insertTrade({ original_trade_id: 1, symbol: 'X', direction: 'SHORT', entry_price: 1, entry_time: 't', qty: 1, sl_price: 2, target_price: 0.5 });
    assert.equal(dupeId, null);
    assert.equal((await mirrorStore.allOpenTrades()).length, 1);
  });
});

for (const name of ['exhaustion_only_mirror', 'trend_smc_mirror', 'scalp_mirror']) {
  test(`plugin: ${name} is auto-discovered by src/paper/pluginLoader.js under bots/`, () => {
    const found = findPluginDirs(path.join(__dirname, '..', 'src', 'paper'), () => {});
    assert.ok(found.some((p) => p.root === 'bots' && p.name === name));
  });
}
