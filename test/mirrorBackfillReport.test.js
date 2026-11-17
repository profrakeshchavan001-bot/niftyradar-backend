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
const { buildJobs, runJob, toMarkdown } = require('../scripts/mirrorBackfill');

// ---------- fixtures ----------

function row({
  bot, mirrorLabel, trades = 0, netPnlInr = 0, mirrorTrades = trades, mirrorNetPnlInr = 0, winRatePct = null, mirrorWinRatePct = null,
  feesInr = 0, mirrorFeesInr = 0, capitalTotalInr = null, capitalUsedInr = null, mirrorCapitalTotalInr = capitalTotalInr, mirrorCapitalUsedInr = capitalUsedInr,
} = {}) {
  return {
    bot, mirrorLabel, opened: 0, closedThisRun: 0,
    original: { trades, netPnlInr, grossPnlInr: netPnlInr, feesInr, winRatePct, capitalTotalInr, capitalUsedInr },
    mirror: { trades: mirrorTrades, netPnlInr: mirrorNetPnlInr, grossPnlInr: mirrorNetPnlInr, feesInr: mirrorFeesInr, winRatePct: mirrorWinRatePct, capitalTotalInr: mirrorCapitalTotalInr, capitalUsedInr: mirrorCapitalUsedInr },
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

test('botBlock: shows "capital used" for both sides (Task: add capital to this report - it never showed any before)', () => {
  const text = botBlock(row({
    bot: 'scalp', mirrorLabel: 'scalp-MIRROR', trades: 5, netPnlInr: 1000, mirrorTrades: 5, mirrorNetPnlInr: -900,
    capitalTotalInr: 90000, capitalUsedInr: 18000, mirrorCapitalTotalInr: 90000, mirrorCapitalUsedInr: 22500,
  }));
  assert.match(text, /Capital used: original ₹18,000 of ₹90,000, mirror ₹22,500 of ₹90,000/);
});

test('botBlock: no capitalTotalInr/capitalUsedInr known (no USDINR_FALLBACK rate) -> "n/a", never 0 or blank', () => {
  const text = botBlock(row({ bot: 'trend_smc', mirrorLabel: 'trend_smc-MIRROR', trades: 3, netPnlInr: 100, mirrorTrades: 3 }));
  assert.match(text, /Capital used: original n\/a of n\/a, mirror n\/a of n\/a/);
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

// ---------- REVERSE (this task): botBlock/bestBotLine, 3-way with original/MIRROR/REVERSE ----------

function reverseRow(overrides = {}) {
  const r = row(overrides);
  const { reverseLabel = 'intraday-REVERSE', reverseTrades = 0, reverseNetPnlInr = 0, reverseWinRatePct = null, reverseFeesInr = 0, leftOpen = 0 } = overrides;
  r.reverse = { reverseLabel, trades: reverseTrades, netPnlInr: reverseNetPnlInr, grossPnlInr: reverseNetPnlInr, winRatePct: reverseWinRatePct, feesInr: reverseFeesInr, leftOpen, capitalTotalInr: null, capitalUsedInr: null };
  return r;
}

test('botBlock: a bot with a reverse side shows 3 sets of numbers (original/mirror/reverse) and the reverse label', () => {
  const text = botBlock(reverseRow({ bot: 'intraday', mirrorLabel: 'intraday-MIRROR', trades: 10, netPnlInr: 1000, winRatePct: 60, mirrorTrades: 10, mirrorNetPnlInr: -900, mirrorWinRatePct: 40, reverseTrades: 8, reverseNetPnlInr: 1600, reverseWinRatePct: 62.5, leftOpen: 2 }));
  assert.match(text, /intraday-REVERSE/);
  assert.match(text, /8 reverse \(2 left open\)/);
  assert.match(text, /reverse \+?₹1,600/);
  assert.match(text, /reverse 62\.5%/);
});

test('botBlock: a bot with no reverse configured (every other bot) renders exactly as before - no "reverse" text at all', () => {
  const text = botBlock(row({ bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', trades: 5, mirrorTrades: 5 }));
  assert.ok(!/reverse/i.test(text));
});

test('bestBotLine: combined P&L includes the reverse side when present, and names it in the metric', () => {
  const rows = [
    row({ bot: 'scalp', trades: 5, netPnlInr: 1000, mirrorTrades: 5, mirrorNetPnlInr: -900 }), // combined 100, no reverse
    reverseRow({ bot: 'intraday', trades: 5, netPnlInr: 100, mirrorTrades: 5, mirrorNetPnlInr: -50, reverseTrades: 5, reverseNetPnlInr: 2000 }), // combined 2050 - best, thanks to reverse
  ];
  const line = bestBotLine(rows);
  assert.match(line, /^Best bot: intraday/);
  assert.match(line, /original\+mirror\+reverse/);
});

test('toMarkdown (scripts/mirrorBackfill.js): adds a 3-way comparison section only for bots with a reverse side', () => {
  const rows = [
    row({ bot: 'exhaustion_only', mirrorLabel: 'exhaustion_only-MIRROR', trades: 3, mirrorTrades: 3 }), // no reverse
    reverseRow({ bot: 'intraday', mirrorLabel: 'intraday-MIRROR', trades: 5, netPnlInr: 100, mirrorTrades: 5, mirrorNetPnlInr: -50, winRatePct: 60, mirrorWinRatePct: 40, reverseTrades: 4, reverseNetPnlInr: 900, reverseWinRatePct: 75, leftOpen: 1 }),
  ];
  const md = toMarkdown(rows, { generatedAt: '2026-11-17T00:00:00Z', dbConfigured: true });
  assert.match(md, /## 3-way comparison: original vs MIRROR vs REVERSE/);
  assert.match(md, /\| intraday \| 5 \/ 5 \/ 4 \(1 open\) \|/);
  assert.doesNotMatch(md, /\| exhaustion_only \|/); // only bots with a reverse side appear in the 3-way table
  assert.match(md, /conservative estimate, not a live replay/); // the honesty note about the backfill approximation
});

test('toMarkdown: no bot has a reverse side -> no 3-way section at all', () => {
  const rows = [row({ bot: 'scalp', mirrorLabel: 'scalp-MIRROR', trades: 1, mirrorTrades: 1 })];
  const md = toMarkdown(rows, { generatedAt: '2026-11-17T00:00:00Z', dbConfigured: true });
  assert.ok(!/3-way comparison/.test(md));
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

// ---------- Task 1 + Task 3 proof: the real backfill path (buildJobs/runJob), against a fake
// Postgres-like pool that returns every NUMERIC column as a STRING, exactly like real node-pg. Before the
// mirrorStore.js fix, `mirror.netPnlInr`/`winRatePct` below would be null/NaN (the exact
// "mirror n/a" bug docs/BOTS.md describes) - this proves runJob() now produces real numbers.

// A fake pool shared by the intraday job's own store (paperbot/store.js's createPgStore, which already
// casts NUMERIC columns via its own NUM_COLS - see paperbot/store.js) AND the intraday-MIRROR store
// (mirrorStore.js, the file this task fixes) - the same way one real `pool` serves both in production
// (src/paper/ops/mirrorBackfillReport/run.js). Every numeric value given is a STRING on purpose.
function createFakeStringNumericPool({ originalRows, mirrorRows }) {
  return {
    async query(sql, params = []) {
      if (/FROM paper_trades/.test(sql)) {
        if (/status = 'closed'/.test(sql)) return { rows: originalRows.filter((r) => r.status === 'closed') };
        if (/status = 'open'/.test(sql)) return { rows: originalRows.filter((r) => r.status === 'open') };
        return { rows: originalRows };
      }
      if (/FROM intraday_mirror_trades/.test(sql)) {
        if (/original_trade_id = \$1/.test(sql)) {
          const id = params[0];
          return { rows: mirrorRows.filter((r) => String(r.original_trade_id) === String(id)) };
        }
        if (/status = 'closed'/.test(sql)) return { rows: mirrorRows.filter((r) => r.status === 'closed') };
        if (/status = 'open'/.test(sql)) return { rows: mirrorRows.filter((r) => r.status === 'open') };
        return { rows: mirrorRows };
      }
      return { rows: [] }; // paper_config, schema setup, exhaustion_only/trend_smc tables (unused by this job): nothing to replay
    },
  };
}

test('runJob() (scripts/mirrorBackfill.js): mirror P&L/win-rate are REAL numbers against a fake Postgres returning string numerics, not null/NaN', async () => {
  // The original intraday trade: a real win, +₹500 net (already closed, already mirrored below - sync()
  // has nothing new to open/close, so this test is purely about reading and casting existing rows).
  const originalRows = [{
    id: '1', market: 'crypto', symbol: 'BTCUSDT', status: 'closed', trade_date: '2026-11-10',
    entry_price: '100', qty: '1', pnl_inr: '500', fx_rate: '90',
    entry_time: new Date('2026-11-10T10:00:00Z'), exit_time: new Date('2026-11-10T10:30:00Z'),
  }];
  // Its mirror: the exact opposite side, a loss, -₹430 net - every NUMERIC column a STRING, exactly as
  // real node-pg hands back exhaustion_only_mirror/trend_smc_mirror/scalp_mirror/scalp_wide_mirror/
  // intraday_mirror_trades' own `numeric` columns (src/paper/bots/intraday_mirror/schema.sql).
  const mirrorRows = [{
    id: '1', original_trade_id: '1', symbol: 'BTCUSDT', status: 'closed', trade_date: '2026-11-10',
    direction: 'SHORT', entry_price: '100', qty: '1', sl_price: '105', target_price: '95',
    pnl_inr: '-430', gross_pnl_inr: '-400', fx_rate: '90',
    entry_time: new Date('2026-11-10T10:00:00Z'), exit_time: new Date('2026-11-10T10:30:00Z'),
  }];
  const pool = createFakeStringNumericPool({ originalRows, mirrorRows });
  const mainStore = require('../paperbot/store').createPgStore(() => pool, () => {});
  const [intradayJob] = buildJobs({ mainStore, pool }).map((j) => ({ ...j, pool }));

  const result = await runJob(intradayJob);

  assert.equal(result.bot, 'intraday');
  // original side (paperbot/store.js already casts - unaffected by this fix, used here as a sanity check)
  assert.equal(result.original.trades, 1);
  assert.equal(result.original.netPnlInr, 500);
  // mirror side: THE BUG - before the fix, pnl_inr stayed the string '-430', and computeBotStats's
  // `closed.reduce((s, t) => s + netOf(t), 0)` on a single-element array returns the STRING '-430'
  // unchanged (0 + '-430' === '-430' in JS), which `round()` then turns into NaN - never a real number.
  assert.equal(result.mirror.trades, 1);
  assert.equal(result.mirror.netPnlInr, -430);
  assert.ok(Number.isFinite(result.mirror.netPnlInr), 'mirror netPnlInr must be a real finite number, not NaN/null - the exact "mirror n/a" bug');
  assert.equal(result.mirror.winRatePct, 0); // the one mirror trade lost -> 0% win rate, not null

  // And the report block built from this row never prints "n/a" for the mirror's P&L/win rate (it may
  // still say "n/a" for capital - no USDINR_FALLBACK was given to this job, which is a separate, honest
  // "no rate" case, not the bug this test targets).
  const block = botBlock({ bot: result.bot, mirrorLabel: result.mirrorLabel, original: result.original, mirror: result.mirror });
  assert.doesNotMatch(block, /PnL:.*n\/a/);
  assert.doesNotMatch(block, /Win rate:.*n\/a/);
  assert.match(block, /-₹430/);
});

// ---------- backfill bug report problem 3: wins/losses/best-worst + per-trade table in the ONE summary ----------

test('botBlock: shows wins/losses/best/worst for the mirror and reverse sides when sideSummary() provides them', () => {
  const r = reverseRow({
    bot: 'intraday', mirrorLabel: 'intraday-MIRROR', trades: 10, mirrorTrades: 10, reverseTrades: 8, leftOpen: 2,
  });
  r.mirror.wins = 4; r.mirror.losses = 6; r.mirror.bestTradeInr = 900; r.mirror.bestSymbol = 'BTCUSDT'; r.mirror.worstTradeInr = -300; r.mirror.worstSymbol = 'ETHUSDT';
  r.reverse.wins = 5; r.reverse.losses = 3; r.reverse.bestTradeInr = 1600; r.reverse.bestSymbol = 'SOLUSDT'; r.reverse.worstTradeInr = -400; r.reverse.worstSymbol = 'ETHUSDT';
  const text = botBlock(r);
  assert.match(text, /Mirror: 4 wins, 6 losses, best \+₹900 \(BTCUSDT\), worst -₹300 \(ETHUSDT\)/);
  assert.match(text, /Reverse: 5 wins, 3 losses, best \+₹1,600 \(SOLUSDT\), worst -₹400 \(ETHUSDT\)/);
});

test('botBlock: renders the per-trade table (#, symbol, direction, net) for mirror/reverse when sideSummary() provides tradeTable, no sampling', () => {
  const r = reverseRow({ bot: 'intraday', mirrorLabel: 'intraday-MIRROR', trades: 2, mirrorTrades: 2, reverseTrades: 2 });
  r.mirror.tradeTable = [{ id: 1, symbol: 'BTCUSDT', direction: 'SHORT', netPnlInr: -300 }, { id: 2, symbol: 'ETHUSDT', direction: 'LONG', netPnlInr: 900 }];
  r.reverse.tradeTable = [{ id: 1, symbol: 'BTCUSDT', direction: 'SHORT', netPnlInr: 1600 }];
  const text = botBlock(r);
  assert.match(text, /Mirror trades:\n#1 BTCUSDT SHORT -₹300\n#2 ETHUSDT LONG \+₹900/);
  assert.match(text, /Reverse trades:\n#1 BTCUSDT SHORT \+₹1,600/);
});

test('botBlock: no wins/losses or tradeTable given (older/fixture rows) -> no such lines at all, never a blank/NaN section', () => {
  const r = reverseRow({ bot: 'intraday', mirrorLabel: 'intraday-MIRROR', trades: 2, mirrorTrades: 2, reverseTrades: 2 });
  const text = botBlock(r);
  assert.ok(!/wins/.test(text));
  assert.ok(!/trades:\n#/.test(text));
});
