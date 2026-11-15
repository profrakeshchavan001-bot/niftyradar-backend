'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { formatEntry, formatExit, istTime } = require('../src/paper/ops/telegramAlerts/format');

const base = { id: 42, symbol: 'ETHUSDT', direction: 'LONG', entry_price: 100, target_price: 110, sl_price: 95, qty: 1, basis: 'b', entry_time: '2026-11-15T17:11:00Z', exit_time: '2026-11-15T17:41:00Z' };

test('istTime converts UTC to IST and never throws', () => {
  assert.strictEqual(istTime('2026-11-15T17:11:00Z'), '15-Nov 10:41 PM IST');
  assert.strictEqual(istTime(null), 'n/a');
  assert.strictEqual(istTime('garbage'), 'n/a');
});

test('entry alert carries Trade #id, bot and IST entry time', () => {
  const t = formatEntry(base, 'intraday', {});
  assert.match(t.split('\n')[0], /^Trade #42 \| intraday$/);
  assert.match(t, /Entry time: 15-Nov 10:41 PM IST/);
});

test('exit alert carries the same Trade #id and both times', () => {
  const t = formatExit({ ...base, status: 'closed', exit_reason: 'stop', pnl_inr: -330 }, 'intraday');
  assert.match(t.split('\n')[0], /^EXIT Trade #42 \| intraday$/);
  assert.match(t, /Entry time: 15-Nov 10:41 PM IST/);
  assert.match(t, /Exit time: 15-Nov 11:11 PM IST/);
  assert.match(t, /STOP hit/);
});

test('missing id or times still produce a message', () => {
  const t = formatExit({ symbol: 'X', exit_reason: 'target' }, 'nse');
  assert.match(t, /EXIT Trade \| nse/);
  assert.match(t, /Entry time: n\/a/);
});
