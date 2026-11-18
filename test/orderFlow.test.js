'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderFlow, imbalance } = require('../src/paper/lib/orderFlow');

test('imbalance: all bids = +1, all asks = -1, even book = 0', () => {
  assert.equal(imbalance([['1', '10']], [], 5), 1);
  assert.equal(imbalance([], [['1', '10']], 5), -1);
  assert.equal(imbalance([['1', '10']], [['1', '10']], 5), 0);
});

function fakeAxios(depth, trades) {
  return {
    async get(url) {
      if (url.includes('/depth')) return { data: depth };
      if (url.includes('/trades')) return { data: trades };
      throw new Error('unexpected url ' + url);
    },
  };
}

test('read(): heavy bid-side book + net taker buys -> buy direction with positive strength', async () => {
  let t = 1000000;
  const depth = { bids: [['100', '50'], ['99', '50']], asks: [['101', '5'], ['102', '5']] };
  const trades = [
    { time: t, qty: '2', isBuyerMaker: false }, { time: t, qty: '2', isBuyerMaker: false },
    { time: t, qty: '1', isBuyerMaker: true },
  ];
  const of = createOrderFlow({ axios: fakeAxios(depth, trades), now: () => t + 1000 });
  const r = await of.read('BTCUSDT');
  assert.equal(r.direction, 'buy');
  assert.ok(r.strength > 0);
  assert.ok(r.detail.top5 > 0);
});

test('read(): heavy ask-side book + net taker sells -> sell direction', async () => {
  let t = 2000000;
  const depth = { bids: [['100', '5']], asks: [['101', '50'], ['102', '50']] };
  const trades = [{ time: t, qty: '5', isBuyerMaker: true }, { time: t, qty: '5', isBuyerMaker: true }];
  const of = createOrderFlow({ axios: fakeAxios(depth, trades), now: () => t + 1000 });
  const r = await of.read('ETHUSDT');
  assert.equal(r.direction, 'sell');
});

test('read(): balanced book, no trades -> neutral, strength 0', async () => {
  const depth = { bids: [['100', '10']], asks: [['101', '10']] };
  const of = createOrderFlow({ axios: fakeAxios(depth, []), now: () => Date.now() });
  const r = await of.read('SOLUSDT');
  assert.equal(r.direction, 'neutral');
});

test('read(): a feed failure never throws - degrades to neutral with an error', async () => {
  const axios = { get: async () => { throw new Error('network down'); } };
  const of = createOrderFlow({ axios, log: () => {} });
  const r = await of.read('BTCUSDT');
  assert.equal(r.direction, 'neutral');
  assert.equal(r.strength, 0);
  assert.ok(r.error);
});
