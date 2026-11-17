'use strict';
// src/paper/ops/mirrorBackfillReport/: the production mirror-backfill job + its protected manual
// re-trigger route (docs/BOTS.md "Mirror bots"). No real database, no real Telegram API - every boundary
// is a small fake, following the same convention test/paperWatchdog.test.js and test/opsCookieAuth.test.js
// already use (fakes passed in directly, a real express app only for the route-level tests).
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  botBlock, bestBotLine, buildReportBlocks, packIntoMessages, buildTelegramMessages, TELEGRAM_MESSAGE_LIMIT,
} = require('../src/paper/ops/mirrorBackfillReport/report');
const registerPlugin = require('../src/paper/ops/mirrorBackfillReport/register');

// ---------- fixtures ----------

function row({ bot, mirrorLabel, trades = 0, netPnlInr = 0, mirrorTrades = trades, mirrorNetPnlInr = 0, winRatePct = null, mirrorWinRatePct = null, feesInr = 0, mirrorFeesInr = 0 } = {}) {
  return {
    bot, mirrorLabel, opened: 0, closedThisRun: 0,
    original: { trades, netPnlInr, grossPnlInr: netPnlInr, feesInr, winRatePct },
    mirror: { trades: mirrorTrades, netPnlInr: mirrorNetPnlInr, grossPnlInr: mirrorNetPnlInr, feesInr: mirrorFeesInr, winRatePct: mirrorWinRatePct },
  };
}

// ---------- report.js: pure aggregation/formatting ----------

test('botBlock: a bot with zero trades on both sides renders "no trades yet", never NaN/blank', () => {
  const text = botBlock(row({ bot: 'scalp_wide', mirrorLabel: 'scalp_wide-MIRROR', trades: 0, mirrorTrades: 0 }));
  assert.match(text, /no trades yet/);
  assert.ok(!/NaN/.test(text));
  assert.match(text, /scalp_wide/);
});

test('botBlock: a bot with real trades prints trade counts, PnL, win rate and fees for both sides', () => {
  const text = botBlock(row({
    bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', trades: 10, netPnlInr: 5000, winRatePct: 60,
    mirrorTrades: 10, mirrorNetPnlInr: -4800, mirrorWinRatePct: 40, feesInr: 120, mirrorFeesInr: 125,
  }));
  assert.match(text, /10 original, 10 mirror/);
  assert.match(text, /\+₹5,000/);
  assert.match(text, /-₹4,800/);
  assert.match(text, /60%/);
  assert.match(text, /40%/);
});

test('bestBotLine: picks the bot with the highest COMBINED original+mirror net P&L, and names the metric', () => {
  const rows = [
    row({ bot: 'a', trades: 5, netPnlInr: 1000, mirrorTrades: 5, mirrorNetPnlInr: -900 }), // combined 100
    row({ bot: 'b', trades: 5, netPnlInr: 2000, mirrorTrades: 5, mirrorNetPnlInr: -500 }), // combined 1500 - best
    row({ bot: 'c', trades: 0, mirrorTrades: 0 }), // no trades at all - never eligible
  ];
  const line = bestBotLine(rows);
  assert.match(line, /^Best bot: b/);
  assert.match(line, /combined/i);
});

test('bestBotLine: every bot has zero trades -> says so instead of naming an arbitrary winner', () => {
  const rows = [row({ bot: 'a' }), row({ bot: 'b' })];
  assert.match(bestBotLine(rows), /n\/a.*no bot has any trades/i);
});

test('buildReportBlocks: one block per bot (in order) plus a header first and the best-bot line last', () => {
  const rows = [row({ bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR' }), row({ bot: 'trend_smc', mirrorLabel: 'trend_smc-MIRROR', trades: 3, netPnlInr: 10, mirrorTrades: 3 })];
  const blocks = buildReportBlocks(rows, { generatedAt: '2026-11-17T00:00:00.000Z' });
  assert.equal(blocks.length, rows.length + 2); // header + 2 bots + best-bot line
  assert.match(blocks[0], /Mirror backfill report/);
  assert.match(blocks[0], /2026-11-17/);
  assert.match(blocks[1], /no trades yet/);
  assert.match(blocks[blocks.length - 1], /^Best bot:/);
});

// ---------- packIntoMessages / buildTelegramMessages: the Telegram 4096-char limit ----------

test('packIntoMessages: small blocks are combined into a single message', () => {
  const messages = packIntoMessages(['one', 'two', 'three'], 4096);
  assert.equal(messages.length, 1);
  assert.equal(messages[0], 'one\n\ntwo\n\nthree');
});

test('packIntoMessages: never produces a message longer than the given limit', () => {
  const limit = 100;
  const blocks = Array.from({ length: 10 }, (_, i) => `block-${i}-`.padEnd(40, 'x')); // 40 chars each, 10 of them
  const messages = packIntoMessages(blocks, limit);
  assert.ok(messages.length > 1); // must have split into more than one message
  for (const m of messages) assert.ok(m.length <= limit, `message of length ${m.length} exceeds limit ${limit}`);
  // every block's own text must still appear somewhere, unsplit, across the messages (nothing dropped)
  for (const b of blocks) assert.ok(messages.some((m) => m.includes(b)));
});

test('packIntoMessages: a single block bigger than the limit is sent alone, truncated, never dropped', () => {
  const huge = 'x'.repeat(150);
  const messages = packIntoMessages(['short', huge], 100);
  assert.equal(messages.length, 2);
  assert.equal(messages[0], 'short');
  assert.equal(messages[1].length, 100);
});

test('buildTelegramMessages: a realistic 4-bot report with real numbers stays under the Telegram limit per message', () => {
  const rows = [
    row({ bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', trades: 42, netPnlInr: 15000, winRatePct: 55, mirrorTrades: 42, mirrorNetPnlInr: -14200, mirrorWinRatePct: 45, feesInr: 900, mirrorFeesInr: 910 }),
    row({ bot: 'trend_smc', mirrorLabel: 'trend_smc-MIRROR', trades: 30, netPnlInr: 8000, winRatePct: 50, mirrorTrades: 30, mirrorNetPnlInr: -7500, mirrorWinRatePct: 50, feesInr: 600, mirrorFeesInr: 610 }),
    row({ bot: 'scalp', mirrorLabel: 'scalp-MIRROR', trades: 0, mirrorTrades: 0 }),
    row({ bot: 'scalp_wide', mirrorLabel: 'scalp_wide-MIRROR', trades: 0, mirrorTrades: 0 }),
  ];
  const messages = buildTelegramMessages(rows, { generatedAt: new Date().toISOString() });
  assert.ok(messages.length >= 1 && messages.length <= 3, `expected 1-3 messages, got ${messages.length}`);
  for (const m of messages) assert.ok(m.length <= TELEGRAM_MESSAGE_LIMIT);
  assert.ok(messages.some((m) => m.includes('no trades yet')));
  assert.ok(messages.some((m) => m.includes('Best bot:')));
});

// ---------- register.js: the "ran once" startup guard + the protected manual route ----------

function createFakePool() {
  const flags = new Map();
  const queries = [];
  return {
    flags, queries,
    async query(sql, params = []) {
      queries.push(sql);
      if (/INSERT INTO system_flags/.test(sql)) {
        const [key, value] = params;
        if (flags.has(key)) return { rows: [] }; // already claimed - ON CONFLICT DO NOTHING
        flags.set(key, value);
        return { rows: [{ x: 1 }] };
      }
      if (/UPDATE system_flags/.test(sql)) {
        const [key, value] = params;
        flags.set(key, value);
        return { rows: [] };
      }
      return { rows: [] }; // every original-bot table: no trades to replay in this test
    },
  };
}

function createFakeMainStore() {
  return {
    openTrades: async () => [],
    closedTrades: async () => [],
    getConfig: async () => ({}),
    setConfigIfMissing: async () => {},
  };
}

function createFakeAxios() {
  const posts = [];
  return { posts, post: async (url, body) => { posts.push({ url, body }); return { data: { ok: true } }; } };
}

test('startup run: with PAPER_DATABASE_URL (a pool) configured, it runs once and sends one telegram report', async () => {
  const pool = createFakePool();
  const axios = createFakeAxios();
  const env = { PAPER_ADMIN_SECRET: 'shh', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' };
  const fakeApp = { get: () => {} };
  await registerPlugin.register({ app: fakeApp, env, log: () => {}, pool, store: createFakeMainStore(), axios });
  assert.equal(axios.posts.length, 1);
  assert.ok(pool.flags.has(registerPlugin.FLAG_KEY));
});

test('"ran once" flag: a second register() call (simulating a server restart) never resends the report', async () => {
  const pool = createFakePool();
  const axios = createFakeAxios();
  const env = { PAPER_ADMIN_SECRET: 'shh', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' };
  const fakeApp = { get: () => {} };
  const mainStore = createFakeMainStore();

  await registerPlugin.register({ app: fakeApp, env, log: () => {}, pool, store: mainStore, axios });
  assert.equal(axios.posts.length, 1, 'first boot sends exactly one report');

  await registerPlugin.register({ app: fakeApp, env, log: () => {}, pool, store: mainStore, axios });
  assert.equal(axios.posts.length, 1, 'second boot (restart) must not send a second report');
});

test('no PAPER_DATABASE_URL (no pool): the startup run is skipped entirely, nothing sent, no crash', async () => {
  const axios = createFakeAxios();
  const env = { PAPER_ADMIN_SECRET: 'shh', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' };
  const fakeApp = { get: () => {} };
  await assert.doesNotReject(registerPlugin.register({ app: fakeApp, env, log: () => {}, pool: null, store: createFakeMainStore(), axios }));
  assert.equal(axios.posts.length, 0);
});

function buildTestApp(ctxOverrides = {}) {
  const pool = createFakePool();
  const axios = createFakeAxios();
  const env = { PAPER_ADMIN_SECRET: 'shh', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat', ...ctxOverrides.env };
  const app = express();
  const ctx = { app, env, log: () => {}, pool, store: createFakeMainStore(), axios, ...ctxOverrides };
  return { app, pool, axios, ctx };
}

test('protected route: a request with no/wrong secret is rejected with 401, no run is triggered', async () => {
  const built = buildTestApp();
  await registerPlugin.register(built.ctx);
  const server = built.app.listen(0);
  try {
    const port = server.address().port;
    const before = built.axios.posts.length; // the startup auto-run already sent 1 report by this point
    const res = await fetch(`http://localhost:${port}/api/paper/mirror-backfill-report?key=wrong`);
    assert.equal(res.status, 401);
    assert.equal(built.axios.posts.length, before); // unauthorized call never triggers a run
  } finally { server.close(); }
});

test('protected route: a request with the correct secret (?key=) is accepted and runs a manual backfill', async () => {
  const { app, pool, axios, ctx } = buildTestApp();
  await registerPlugin.register(ctx);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const beforeSends = axios.posts.length; // 1, from the automatic startup run inside register()
    const res = await fetch(`http://localhost:${port}/api/paper/mirror-backfill-report?key=shh`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(axios.posts.length > beforeSends, 'the manual re-run must send its own report even though the startup flag is already set');
  } finally { server.close(); }
});

test('protected route: the correct secret also works via the x-paper-secret header', async () => {
  const { app, ctx } = buildTestApp();
  await registerPlugin.register(ctx);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/mirror-backfill-report`, { headers: { 'x-paper-secret': 'shh' } });
    assert.equal(res.status, 200);
  } finally { server.close(); }
});

test('protected route: no PAPER_ADMIN_SECRET/RENEW_SECRET configured at all answers 503, never leaks a 200', async () => {
  const { app, ctx } = buildTestApp({ env: { PAPER_ADMIN_SECRET: '', TELEGRAM_BOT_TOKEN: 'tok', TELEGRAM_CHAT_ID: 'chat' } });
  await registerPlugin.register(ctx);
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/mirror-backfill-report?key=anything`);
    assert.equal(res.status, 503);
  } finally { server.close(); }
});
