'use strict';
// CC2 overnight item 1: shared lib re-exports and the plugin loader never crash the server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const lib = require('../src/paper/lib');
const { createCandleCache, keyOf } = require('../src/paper/lib/candleCache');
const { loadPlugins, findPluginDirs } = require('../src/paper/pluginLoader');

test('lib re-exports the same indicator functions, unchanged', () => {
  const P = require('../paperbot/patterns');
  assert.equal(lib.ema, P.ema);
  assert.equal(lib.atr, P.atr);
  assert.equal(lib.vwap, P.vwap);
  assert.equal(lib.trendOf, P.trendOf);
});

test('lib re-exports the same level-planning functions, unchanged', () => {
  const CL = require('../paperbot/cryptoLevels');
  const { swingLevels } = require('../paperbot/rfactor');
  assert.equal(lib.planTrade, CL.planTrade);
  assert.equal(lib.manageTrade, CL.manageTrade);
  assert.equal(lib.swingLevels, swingLevels);
});

test('ema on a hand-worked series: 1,2,3,4,5 with n=3 (seed = avg(1,2,3)=2, k=0.5)', () => {
  // step1: 4*0.5 + 2*0.5 = 3; step2: 5*0.5 + 3*0.5 = 4
  assert.equal(lib.ema([1, 2, 3, 4, 5], 3), 4);
});

test('candle cache: two concurrent callers for the same key share one fetch', async () => {
  let calls = 0;
  const cache = createCandleCache({ ttlMs: 60000 });
  const fetcher = async () => { calls += 1; await new Promise((r) => setTimeout(r, 10)); return [1, 2, 3]; };
  const [a, b] = await Promise.all([cache.get(keyOf('BTCUSDT', '5m'), fetcher), cache.get(keyOf('BTCUSDT', '5m'), fetcher)]);
  assert.deepEqual(a, [1, 2, 3]);
  assert.deepEqual(b, [1, 2, 3]);
  assert.equal(calls, 1, 'fetcher must run once for two callers in the same cycle');
});

test('candle cache: refetches once the TTL has passed', async () => {
  let t = 0;
  let calls = 0;
  const cache = createCandleCache({ ttlMs: 1000, now: () => t });
  const fetcher = async () => { calls += 1; return calls; };
  assert.equal(await cache.get('k', fetcher), 1);
  t = 500;
  assert.equal(await cache.get('k', fetcher), 1, 'still within ttl');
  t = 1500;
  assert.equal(await cache.get('k', fetcher), 2, 'ttl passed, refetched');
});

test('candle cache: a failed fetch is never cached and does not poison the next call', async () => {
  const cache = createCandleCache({ ttlMs: 60000 });
  let fail = true;
  const fetcher = async () => { if (fail) throw new Error('down'); return ['ok']; };
  await assert.rejects(cache.get('k', fetcher));
  fail = false;
  assert.deepEqual(await cache.get('k', fetcher), ['ok']);
});

test('plugin loader: an empty bots/ops/replay tree is a safe no-op', async () => {
  // An isolated empty temp tree, not the live src/paper/ directory: a real plugin now lives there
  // (src/paper/ops/alerts/, overnight item 7) and finding it there would be the loader working as
  // designed, not a bug - this test is about the empty case, which belongs in its own fixture.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-plugins-empty-'));
  fs.mkdirSync(path.join(tmp, 'bots'), { recursive: true });
  const dirs = findPluginDirs(tmp, () => {});
  assert.deepEqual(dirs, []);
  const logs = [];
  const result = await loadPlugins({ log: (m) => logs.push(m), baseDir: tmp });
  assert.deepEqual(result.loaded, []);
});

test('plugin loader: loads register.js, runs schema.sql once (via the pool), never crashes on a throwing plugin', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-plugins-'));
  const okDir = path.join(tmp, 'bots', 'ok-bot');
  const badDir = path.join(tmp, 'bots', 'bad-bot');
  fs.mkdirSync(okDir, { recursive: true });
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(okDir, 'register.js'), 'module.exports = { register(ctx) { ctx.state.okLoaded = true; } };');
  fs.writeFileSync(path.join(okDir, 'schema.sql'), 'CREATE TABLE IF NOT EXISTS ok_bot_demo (id int);');
  fs.writeFileSync(path.join(badDir, 'register.js'), 'module.exports = { register() { throw new Error("boom"); } };');

  const queries = [];
  const pool = { query: async (sql) => { queries.push(sql); return {}; } };
  const state = {};
  const logs = [];
  const result = await loadPlugins({ baseDir: tmp, pool, state, log: (m) => logs.push(m) });

  assert.ok(result.loaded.includes('bots/ok-bot'));
  assert.equal(state.okLoaded, true);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /CREATE TABLE IF NOT EXISTS ok_bot_demo/);
  assert.ok(logs.some((l) => l.includes('bad-bot failed to load')), 'the throwing plugin is logged, not thrown');

  fs.rmSync(tmp, { recursive: true, force: true });
});
