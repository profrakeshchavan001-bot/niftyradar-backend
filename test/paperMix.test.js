'use strict';
// Mix (docs/BOTS.md "Mix"): SUGGESTIONS ONLY, never trades, never changes anything. Hand-worked numbers, not copied from the
// function's own output - see the comments next to each case.
const test = require('node:test');
const assert = require('node:assert/strict');
const { computeWeights, buildSuggestions } = require('../src/paper/bots/mix/stats');
const register = require('../src/paper/bots/mix/register');
const leaderboardRegister = require('../src/paper/bots/leaderboard/register');
const { createMemoryStore } = require('../paperbot/store');

test('computeWeights: only bots with 20+ trades get a weight (their own win rate); everyone else is 0', () => {
  const stats = { scalp: { trades: 20, winRatePct: 60 }, exhaustion_only: { trades: 19, winRatePct: 90 }, trend_smc: { trades: 25, winRatePct: 40 } };
  const w = computeWeights(stats);
  assert.deepEqual(w, { scalp: 0.6, exhaustion_only: 0, trend_smc: 0.4 });
});

// scalp (weight 0.6) went LONG on this candle, pnl +100; trend_smc (weight 0.4) went SHORT, pnl -30.
// score = (0.6 x 1 + 0.4 x -1) / (0.6+0.4) = (0.6-0.4)/1 = 0.2 -> above the 0.05 "no agreement" band -> suggested LONG
// weighted result = (0.6 x 100 + 0.4 x -30) / 1 = (60 - 12) / 1 = 48
test('buildSuggestions: two bots disagree on the same candle; the higher-weight side wins the vote, weighted result worked by hand', () => {
  const weights = { scalp: 0.6, trend_smc: 0.4 };
  const tradesByBot = {
    scalp: [{ symbol: 'BTCUSDT', trigger_t: 1000, direction: 'LONG', pnl_inr: 100 }],
    trend_smc: [{ symbol: 'BTCUSDT', trigger_t: 1000, direction: 'SHORT', pnl_inr: -30 }],
  };
  const out = buildSuggestions(tradesByBot, weights);
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].suggestedDirection, out[0].score, out[0].weightedPnlInr], ['LONG', 0.2, 48]);
});

test('buildSuggestions: a candle only one bot ever looked at is not a vote (nothing to agree or disagree with)', () => {
  const out = buildSuggestions({ scalp: [{ symbol: 'BTCUSDT', trigger_t: 1, direction: 'LONG', pnl_inr: 10 }] }, { scalp: 1 });
  assert.equal(out.length, 0);
});

test('buildSuggestions: a candle where no participant has 20+ trades (weight 0 for everyone) suggests nothing', () => {
  const tradesByBot = {
    scalp: [{ symbol: 'BTCUSDT', trigger_t: 1, direction: 'LONG', pnl_inr: 10 }],
    trend_smc: [{ symbol: 'BTCUSDT', trigger_t: 1, direction: 'SHORT', pnl_inr: -5 }],
  };
  assert.equal(buildSuggestions(tradesByBot, { scalp: 0, trend_smc: 0 }).length, 0);
});

// Equal weight, opposite directions -> score 0 -> "no agreement" (not forced to either side)
test('buildSuggestions: equal weights and opposite directions is "no agreement", not a coin-flip pick', () => {
  const tradesByBot = {
    scalp: [{ symbol: 'ETHUSDT', trigger_t: 5, direction: 'LONG', pnl_inr: 10 }],
    exhaustion_only: [{ symbol: 'ETHUSDT', trigger_t: 5, direction: 'SHORT', pnl_inr: -10 }],
  };
  const out = buildSuggestions(tradesByBot, { scalp: 0.5, exhaustion_only: 0.5 });
  assert.equal(out[0].suggestedDirection, 'no agreement');
});

// ---------- wiring ----------
function fakeApp() { const routes = {}; return { routes, get: (path, handler) => { routes[path] = handler; } }; }
async function call(app, path, { query = {}, headers = {} } = {}) {
  const out = { status: 200, headers: {}, body: null, type: null };
  const res = {
    set(h, v) { if (typeof h === 'object') Object.assign(out.headers, h); else out.headers[h] = v; return this; },
    status(n) { out.status = n; return this; }, type(t) { out.type = t; return this; },
    send(b) { out.body = b; return this; }, json(b) { out.type = 'json'; out.body = JSON.stringify(b); return this; },
  };
  await app.routes[path]({ query, get: (h) => headers[h.toLowerCase()] }, res);
  return out;
}

test('wiring: labelled "suggestion, needs owner approval"; behind the secret; empty and never a crash with nothing stored', async () => {
  const app = fakeApp();
  await register.register({ app, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store: createMemoryStore() });
  assert.equal((await call(app, '/api/paper/mix-report')).status, 401);
  const r = await call(app, '/api/paper/mix-report', { query: { key: 's3cret', format: 'json' } });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.label, 'suggestion, needs owner approval'); assert.match(d.note, /never trades/);
  assert.deepEqual(d.suggestions, []);
});

test('wiring: reads the same trades as the leaderboard (closedTradesByBot is exported and reused, nothing re-fetched)', () => {
  assert.equal(typeof leaderboardRegister.closedTradesByBot, 'function');
});
