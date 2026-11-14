'use strict';
// CC3 round 3 item 2 (stability): 8 s timeout (was 15 s) and one backoff pass across both hosts before giving up on a fetch.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCryptoSource } = require('../paperbot/sources');

function fakeAxios(failTimes) {
  let calls = 0;
  return {
    calls: () => calls,
    timeouts: [],
    async get(url, opt) {
      calls += 1;
      this.timeouts.push(opt.timeout);
      if (calls <= failTimes) throw new Error('down');
      return { data: [[1, '1', '2', '0.5', '1.5', '10']] };
    },
  };
}

test('createCryptoSource: 8 s timeout on every request (not 15 s)', async () => {
  const axios = fakeAxios(0);
  const src = createCryptoSource({ axios, now: () => 1 });
  await src.candles('BTCUSDT');
  assert.ok(axios.timeouts.every((t) => t === 8000));
});

test('createCryptoSource: both hosts failing once still recovers on the backoff pass, no network call delayed by more than one short sleep', async () => {
  const axios = fakeAxios(2); // fails exactly twice = both hosts on the first pass, succeeds on the first host of the backoff pass
  const sleeps = [];
  const src = createCryptoSource({ axios, now: () => 1, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  const rows = await src.candles('BTCUSDT');
  assert.equal(rows.length, 1); assert.deepEqual(sleeps, [400]); assert.equal(axios.calls(), 3);
});

test('createCryptoSource: both hosts failing on both passes gives up and records the failure (never hangs, never retries forever)', async () => {
  const axios = fakeAxios(99);
  const src = createCryptoSource({ axios, now: () => 1, sleep: () => Promise.resolve() });
  await assert.rejects(src.candles('BTCUSDT'));
  assert.equal(src.stats.fail, 1); assert.equal(axios.calls(), 4); // 2 hosts x 2 passes, then stop
});
