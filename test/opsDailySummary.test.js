'use strict';
// Overnight item 2: daily summary extension (net INR per bot, best/worst trade, skips grouped by reason,
// "what to learn" suggestions) + the 04:45 IST morning brief (paperbot/report.js). Every expected number
// below is worked out by hand in the comment next to it, not copied from the function's own output.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dailySummary, morningBrief, groupSkipsByReason, perBotBreakdown, bestWorstTrade, whatToLearn, createReporter, VARIANT_MARKETS } = require('../paperbot/report');
const { createMemoryStore } = require('../paperbot/store');

const closed = (over) => ({ market: 'nse', symbol: 'X', trade_date: '2026-11-14', status: 'closed', patterns: [], entry_price: 1, exit_price: 1, basis: 'b', ...over });
const open = (over) => ({ market: 'nse', symbol: 'X', trade_date: '2026-11-14', status: 'open', patterns: [], entry_price: 1, basis: 'b', ...over });

test('groupSkipsByReason: normalizes numbers/quotes and counts, sorted by count desc, capped at `top`', () => {
  const skips = [
    { reason: 'RSI 71.3 > 70' }, { reason: 'RSI 68.9 > 70' }, { reason: 'RSI 90.0 > 70' }, // 3x the same normalized reason
    { reason: 'news filter: news today: "Big headline here"' }, { reason: 'news filter: news today: "Other headline"' }, // 2x
    { reason: 'F&O ban' }, // 1x
  ];
  const groups = groupSkipsByReason(skips);
  assert.deepEqual(groups, [
    { reason: 'RSI N > N', count: 3 },
    { reason: 'news filter: news today: "..."', count: 2 },
    { reason: 'F&O ban', count: 1 },
  ]);
});

test('groupSkipsByReason: caps at `top` (hand-picked 2 of 3 distinct reasons, by count)', () => {
  const skips = [{ reason: 'A' }, { reason: 'A' }, { reason: 'B' }, { reason: 'C' }];
  assert.deepEqual(groupSkipsByReason(skips, 2), [{ reason: 'A', count: 2 }, { reason: 'B', count: 1 }]);
});

test('perBotBreakdown: net INR, wins/losses, open count per bot (hand-checked)', () => {
  // nse: 4200 - 1500 = 2700 net, 1 win 1 loss, 0 open
  // nse_scalp: 1 open trade, no closed trades -> net 0, 0 wins, 0 losses, 1 open
  const byBot = perBotBreakdown({
    nse: [closed({ pnl_inr: 4200 }), closed({ pnl_inr: -1500 })],
    nse_scalp: [open({ market: 'nse_scalp' })],
  });
  assert.deepEqual(byBot, [
    { bot: 'nse', trades: 2, closed: 2, open: 0, wins: 1, losses: 1, netInr: 2700 },
    { bot: 'nse_scalp', trades: 1, closed: 0, open: 1, wins: 0, losses: 0, netInr: 0 },
  ]);
});

test('perBotBreakdown: a bot with zero trades today is left out entirely (never a fake 0 row)', () => {
  assert.deepEqual(perBotBreakdown({ nse: [closed({ pnl_inr: 100 })], nse_scalp: [] }), [{ bot: 'nse', trades: 1, closed: 1, open: 0, wins: 1, losses: 0, netInr: 100 }]);
});

test('bestWorstTrade: picks the highest and lowest P&L closed trade; open trades never count; null when none closed', () => {
  const trades = [closed({ symbol: 'A', pnl_inr: 500 }), closed({ symbol: 'B', pnl_inr: -200 }), closed({ symbol: 'C', pnl_inr: 1000 }), open({ symbol: 'D' })];
  const bw = bestWorstTrade(trades);
  assert.deepEqual(bw, { best: { symbol: 'C', pnlInr: 1000, basis: 'b' }, worst: { symbol: 'B', pnlInr: -200, basis: 'b' } });
  assert.equal(bestWorstTrade([open({ symbol: 'D' })]), null);
});

test('whatToLearn: below minTrades says "too few trades", never a conclusion', () => {
  const lines = whatToLearn([closed({ pnl_inr: 100 })], [], 20); // 1 closed trade, minTrades 20
  assert.deepEqual(lines, ['Too few trades today (1) to learn anything new. Suggestion only, nothing changed.']);
});

test('whatToLearn: at/above minTrades names the best-average pattern today, phrased as a suggestion', () => {
  // 20 closed trades today, one pattern "order_block" averaging 50, another "fvg" averaging -10: order_block is named
  const todays = [
    ...Array.from({ length: 10 }, () => closed({ pnl_inr: 50, patterns: ['order_block'] })),
    ...Array.from({ length: 10 }, () => closed({ pnl_inr: -10, patterns: ['fvg'] })),
  ];
  const lines = whatToLearn(todays, [], 20);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /order_block looked best today \(avg Rs \+50\)/);
  assert.match(lines[0], /nothing changed automatically/);
});

test('dailySummary: by-bot section only appears when a variant bot also traded today', () => {
  const solo = dailySummary({ market: 'nse', date: '2026-11-14', trades: [closed({ pnl_inr: 100 })], allClosed: [], minTrades: 20 });
  assert.doesNotMatch(solo.text, /By bot:/);
  const withVariant = dailySummary({ market: 'nse', date: '2026-11-14', trades: [closed({ pnl_inr: 100 })], allClosed: [], minTrades: 20, variantTrades: { nse_scalp: [closed({ market: 'nse_scalp', pnl_inr: 50 })] } });
  assert.match(withVariant.text, /By bot:/);
  assert.match(withVariant.text, /nse: 1 trades \(1W\/0L\), net Rs \+100/);
  assert.match(withVariant.text, /nse_scalp: 1 trades \(1W\/0L\), net Rs \+50/);
  assert.deepEqual(withVariant.data.byBot.map((b) => [b.bot, b.netInr]), [['nse', 100], ['nse_scalp', 50]]);
});

test('dailySummary: skips today grouped by reason; "No skips recorded today." when none', () => {
  const none = dailySummary({ market: 'nse', date: '2026-11-14', trades: [], allClosed: [], minTrades: 20 });
  assert.match(none.text, /No skips recorded today\./);
  const withSkips = dailySummary({ market: 'nse', date: '2026-11-14', trades: [], allClosed: [], minTrades: 20, skipsToday: [{ reason: 'RSI 71 > 70' }, { reason: 'RSI 69 > 70' }] });
  assert.match(withSkips.text, /2x RSI N > N/);
  assert.deepEqual(withSkips.data.skipsByReason, [{ reason: 'RSI N > N', count: 2 }]);
});

test('dailySummary: best/worst trade line includes variant-bot trades too (combined day)', () => {
  const r = dailySummary({ market: 'nse', date: '2026-11-14', trades: [closed({ symbol: 'A', pnl_inr: 100 })], allClosed: [], minTrades: 20, variantTrades: { nse_scalp: [closed({ market: 'nse_scalp', symbol: 'B', pnl_inr: 900 })] } });
  assert.match(r.text, /Best trade: B Rs \+900/);
  assert.match(r.text, /Worst trade: A Rs \+100/);
});

test('morningBrief: hand-checked net INR, open-trade listing, "No alerts." default', () => {
  const report = morningBrief({
    date: '2026-11-14', yesterday: '2026-11-13',
    nseYesterday: [closed({ pnl_inr: 2000 }), closed({ pnl_inr: -500 })], // net 1500
    cryptoOvernight: [closed({ market: 'crypto', pnl_inr: 300 })], // net 300
    openByBot: { nse: [], nse_scalp: [open({ market: 'nse_scalp', symbol: 'TCS' })], crypto: [], crypto_scalp: [], crypto_wide_scalp: [] },
    alertsOvernight: [],
  });
  assert.match(report.text, /NSE yesterday \(2026-11-13\): 2 trade\(s\), net Rs \+1,500\./);
  assert.match(report.text, /Crypto overnight: 1 trade\(s\), net Rs \+300\./);
  assert.match(report.text, /nse_scalp: 1 open \(TCS\)/);
  assert.match(report.text, /No alerts\./);
  assert.equal(report.data.nseYesterdayCount, 2);
  assert.equal(report.data.openCounts.nse_scalp, 1);
});

test('morningBrief: alerts overnight are listed verbatim (kind, subject, message)', () => {
  const report = morningBrief({
    date: '2026-11-14', yesterday: '2026-11-13', nseYesterday: [], cryptoOvernight: [], openByBot: {},
    alertsOvernight: [{ kind: 'stale_job', subject: 'nseScan', message: 'nseScan has not scanned in 15+ minutes', created_at: '2026-11-14T00:00:00Z' }],
  });
  assert.match(report.text, /stale_job \(nseScan\): nseScan has not scanned in 15\+ minutes/);
  assert.equal(report.data.alertsOvernightCount, 1);
});

test('createReporter().morningBrief(): wires store.tradesForDay/openTrades correctly, stores + sends', async () => {
  const store = createMemoryStore();
  await store.insertTrade({ market: 'nse', symbol: 'RELIANCE', trade_date: '2026-11-13', status: 'closed', pnl_inr: 1000, entry_price: 1, exit_price: 1, basis: 'b', patterns: [] });
  await store.insertTrade({ market: 'crypto', symbol: 'BTCUSDT', trade_date: '2026-11-14', status: 'open', entry_price: 1, basis: 'b', patterns: [] });
  const sent = [];
  const axios = { post: async (u, b) => { sent.push(b.text); } };
  const env = { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '9' };
  const now = () => Date.UTC(2026, 10, 13, 23, 15); // 04:45 IST on 14 Nov
  const reporter = createReporter({ store, axios, env, now, log: () => {}, loadConfig: async () => ({}) });
  const r = await reporter.morningBrief();
  assert.equal(r.telegram_sent, true);
  assert.match(sent[0], /Morning brief 2026-11-14/);
  assert.match(sent[0], /NSE yesterday \(2026-11-13\): 1 trade\(s\), net Rs \+1,000\./);
  assert.match(sent[0], /crypto: 1 open \(BTCUSDT\)/);
  assert.equal((await store.listSummaries(1))[0].kind, 'morning_brief');
});

test('VARIANT_MARKETS: exhaustion_only is deliberately not in it (own table, own report page)', () => {
  assert.ok(!Object.values(VARIANT_MARKETS).flat().includes('crypto_exhaustion_only'));
});
