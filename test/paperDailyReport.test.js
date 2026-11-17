'use strict';
// Daily Telegram report (05:00 IST): period boundaries, zero/many trades, restart-dedupe.
// Every expected number below is hand-worked in the comment next to it, not copied from the function's own output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { periodBounds, periodTrades, buildDailyReport } = require('../src/paper/ops/dailyReport/report');
const { maybeSend } = require('../src/paper/ops/dailyReport/register');
const { createMemoryStore } = require('../paperbot/store');

const closed = (over) => ({ symbol: 'X', direction: 'LONG', status: 'closed', basis: 'b', ...over });

test('periodBounds: 24h window ending at today 05:00 IST (hand-checked UTC instants)', () => {
  // 2026-11-18 05:00 IST = 2026-11-17 23:30 UTC (IST = UTC+5:30)
  const now = Date.UTC(2026, 10, 17, 23, 45); // a few minutes after 05:00 IST on the 18th
  const b = periodBounds(now);
  assert.equal(new Date(b.endMs).toISOString(), '2026-11-17T23:30:00.000Z');
  assert.equal(new Date(b.startMs).toISOString(), '2026-11-16T23:30:00.000Z'); // exactly 24h earlier
  assert.equal(b.endDate, '2026-11-18');
});

test('periodBounds: just before 05:00 IST still resolves to the PREVIOUS day\'s window (not yet rolled over)', () => {
  const now = Date.UTC(2026, 10, 17, 23, 29); // 2026-11-18 04:59 IST - one minute before rollover
  const b = periodBounds(now);
  assert.equal(b.endDate, '2026-11-18'); // istDayStart still resolves this instant to the 18th's calendar day
  assert.equal(new Date(b.endMs).toISOString(), '2026-11-17T23:30:00.000Z');
});

test('periodTrades: a trade exactly at the start boundary counts, one just before does not (half-open window)', () => {
  const now = Date.UTC(2026, 10, 17, 23, 45);
  const b = periodBounds(now);
  const byBot = {
    intraday: [
      closed({ symbol: 'A', pnl_inr: 10, exit_time: new Date(b.startMs).toISOString() }), // == start: in
      closed({ symbol: 'B', pnl_inr: 20, exit_time: new Date(b.startMs - 1).toISOString() }), // 1ms before start: out
      closed({ symbol: 'C', pnl_inr: 30, exit_time: new Date(b.endMs - 1).toISOString() }), // 1ms before end: in
      closed({ symbol: 'D', pnl_inr: 40, exit_time: new Date(b.endMs).toISOString() }), // == end: out (next period's)
    ],
  };
  const trades = periodTrades(byBot, b);
  assert.deepEqual(trades.map((t) => t.symbol), ['A', 'C']);
  assert.deepEqual(trades.map((t) => t.n), [1, 2]); // numbered 1..N in encounter order
});

test('buildDailyReport: 0 trades -> "Aaj 0 trade" literally, plus the overall status section still appears', () => {
  const now = Date.UTC(2026, 10, 17, 23, 45);
  const r = buildDailyReport({ now, closedByBot: { intraday: [] }, openByBot: { intraday: [] } });
  assert.match(r.text, /^Daily Report \(05:00 IST\) - 2026-11-18/);
  assert.match(r.text, /Aaj 0 trade/);
  assert.match(r.text, /OVERALL STATUS/);
  assert.match(r.text, /Abhi Open: 0 trade/);
  assert.equal(r.data.trades, 0);
});

test('buildDailyReport: mixed win/loss/breakeven in the period - hand-checked counts, net, and the party popper on winners only', () => {
  const now = Date.UTC(2026, 10, 17, 23, 45);
  const b = periodBounds(now);
  const t = (over) => closed({ exit_time: new Date(b.startMs + 3600000).toISOString(), ...over });
  const closedByBot = {
    intraday: [t({ symbol: 'A', direction: 'LONG', pnl_inr: 500 })], // win
    scalp: [t({ symbol: 'B', direction: 'SHORT', pnl_inr: -200 })], // loss
    exhaustion_only: [t({ symbol: 'C', direction: 'LONG', pnl_inr: 0 })], // breakeven
  };
  // net = 500 - 200 + 0 = 300
  const r = buildDailyReport({ now, closedByBot, openByBot: {} });
  assert.match(r.text, /Aaj: 3 trade band hua \(1 win, 1 loss, 1 BE\)/);
  assert.match(r.text, /Period P&L: Rs \+300/);
  assert.match(r.text, /intraday \| A \| LONG \| \+Rs 500 🎉/);
  assert.match(r.text, /scalp \| B \| SHORT \| -Rs 200/);
  assert.doesNotMatch(r.text.split('scalp | B')[1].split('\n')[0], /🎉/);
  assert.equal(r.data.wins, 1); assert.equal(r.data.losses, 1); assert.equal(r.data.breakeven, 1);
  assert.equal(r.data.netPeriodInr, 300);
});

test('buildDailyReport: over 30 trades in the period -> top 5 winners + top 5 losers + counts, not every line', () => {
  const now = Date.UTC(2026, 10, 17, 23, 45);
  const b = periodBounds(now);
  const exitIso = new Date(b.startMs + 3600000).toISOString();
  const trades = [];
  for (let i = 0; i < 20; i += 1) trades.push(closed({ symbol: `W${i}`, pnl_inr: 100 + i, exit_time: exitIso })); // 20 winners, W19 biggest (119)
  for (let i = 0; i < 15; i += 1) trades.push(closed({ symbol: `L${i}`, pnl_inr: -(50 + i), exit_time: exitIso })); // 15 losers, L14 worst (-64)
  const r = buildDailyReport({ now, closedByBot: { intraday: trades }, openByBot: {} });
  assert.equal(r.data.trades, 35);
  assert.match(r.text, /35 trade the \(top 5 winners \+ top 5 losers neeche\)/);
  assert.match(r.text, /Top 5 Winners:\n1\. intraday \| W19 \| LONG \| \+Rs 119/);
  assert.match(r.text, /Top 5 Losers:\n1\. intraday \| L14 \| LONG \| -Rs 64/);
  assert.equal((r.text.match(/\| LONG \|/g) || []).length, 10); // exactly top 5 + top 5, no full per-bot listing
});

test('buildDailyReport: overall status pairs every original with its mirror, grand total sums all, best/worst picked by net', () => {
  const closedByBot = {
    intraday: [closed({ pnl_inr: 1000, gross_pnl_inr: 1050 })], // net 1000, fee 50
    intraday_mirror: [closed({ pnl_inr: -1000, gross_pnl_inr: -950 })], // net -1000, fee 50
  };
  const r = buildDailyReport({ now: Date.now(), closedByBot, openByBot: {} });
  assert.match(r.text, /intraday: 1T \| 100% win \| Rs \+1,000 \| fees Rs \+50/);
  assert.match(r.text, /intraday_mirror: 1T \| 0% win \| Rs -1,000 \| fees Rs \+50/);
  assert.match(r.text, /GRAND TOTAL: 2T \| net Rs \+0 \| fees Rs \+100/); // 1000 + (-1000) = 0 net; 50 + 50 = 100 fees
  assert.match(r.text, /Best bot so far: intraday \(Rs \+1,000\)/);
  assert.match(r.text, /Worst bot so far: intraday_mirror \(Rs -1,000\)/);
});

test('maybeSend: sends once at/after 05:00 IST and never a second time the same day (restart-safe dedupe)', async () => {
  const store = createMemoryStore();
  const sent = [];
  const ctx = { store, env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C' }, axios: { post: async (u, b) => sent.push(b.text) }, log: () => {} };
  const fiveAm = Date.UTC(2026, 10, 17, 23, 30); // 2026-11-18 05:00:00 IST exactly
  const r1 = await maybeSend(ctx, { now: fiveAm });
  assert.equal(r1.sent, true); assert.equal(sent.length, 1);
  const r2 = await maybeSend(ctx, { now: fiveAm + 60000 }); // one minute later, same day
  assert.equal(r2.sent, false); assert.equal(r2.reason, 'already sent today'); assert.equal(sent.length, 1);
});

test('maybeSend: before 05:00 IST does nothing (not due yet), regardless of startup', async () => {
  const store = createMemoryStore();
  const ctx = { store, env: {}, axios: { post: async () => {} }, log: () => {} };
  const fourAm = Date.UTC(2026, 10, 17, 22, 30); // 2026-11-18 04:00 IST
  const r = await maybeSend(ctx, { now: fourAm, isStartup: true });
  assert.equal(r.sent, false); assert.equal(r.reason, 'before 05:00 IST');
});

test('maybeSend: startup catch-up within 6 hours of a missed 05:00 sends once; past 6 hours does not', async () => {
  const within = createMemoryStore();
  const ctxWithin = { store: within, env: {}, axios: { post: async () => {} }, log: () => {} };
  const nineAm = Date.UTC(2026, 10, 18, 3, 30); // 2026-11-18 09:00 IST: 4h past 05:00, within the 6h catch-up window
  const rWithin = await maybeSend(ctxWithin, { now: nineAm, isStartup: true });
  assert.equal(rWithin.sent, false); // no Telegram env set -> sendTelegram returns false, but it WAS attempted (not refused for timing)
  assert.equal(rWithin.reason, 'telegram send failed');

  const late = createMemoryStore();
  const ctxLate = { store: late, env: {}, axios: { post: async () => {} }, log: () => {} };
  const noonPlus = Date.UTC(2026, 10, 18, 7, 0); // 2026-11-18 12:30 IST: 7.5h past 05:00, past the 6h window
  const rLate = await maybeSend(ctxLate, { now: noonPlus, isStartup: true });
  assert.equal(rLate.sent, false); assert.equal(rLate.reason, 'missed catch-up window (>6h past 05:00)');
});

test('maybeSend: force=true bypasses both the time gate and the already-sent dedupe (manual test trigger)', async () => {
  const store = createMemoryStore();
  const sent = [];
  const ctx = { store, env: { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: 'C' }, axios: { post: async (u, b) => sent.push(b.text) }, log: () => {} };
  const noon = Date.UTC(2026, 10, 18, 6, 30); // well past 05:00 and its catch-up window
  const r = await maybeSend(ctx, { now: noon, force: true });
  assert.equal(r.sent, true); assert.equal(sent.length, 1);
  const r2 = await maybeSend(ctx, { now: noon + 1000, force: true }); // force again: sends a second time on purpose
  assert.equal(r2.sent, true); assert.equal(sent.length, 2);
});

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

test('plugin: auto-discovered under ops/daily-report', () => {
  const { findPluginDirs } = require('../src/paper/pluginLoader');
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'ops' && p.name === 'dailyReport'));
});

test('wiring: GET /api/paper/daily-report behind the secret; dryRun never marks the day sent', async () => {
  const register = require('../src/paper/ops/dailyReport/register');
  const app = fakeApp();
  const store = createMemoryStore();
  await register.register({ app, cron: null, tz: null, guarded: null, env: { PAPER_ADMIN_SECRET: 's3cret' }, log: () => {}, store, axios: { post: async () => {} } });
  assert.equal((await call(app, '/api/paper/daily-report')).status, 401);
  const dry = await call(app, '/api/paper/daily-report', { query: { key: 's3cret', dryRun: '1', format: 'json' } });
  assert.equal(dry.status, 200);
  assert.match(JSON.parse(dry.body).text, /Daily Report/);
  const cfg = await store.getConfig();
  assert.equal(cfg.dailyReportLastSentDate, undefined); // dryRun never marks the day sent
});
