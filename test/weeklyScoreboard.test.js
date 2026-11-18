'use strict';
// GROUP 7: weekly scoreboard (src/paper/ops/weeklyScoreboard/report.js) - pure text/data builder, no I/O.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildWeeklyScoreboard, statusLabel } = require('../src/paper/ops/weeklyScoreboard/report');
const { findPluginDirs } = require('../src/paper/pluginLoader');

test('plugin: auto-discovered under ops/weeklyScoreboard', () => {
  const found = findPluginDirs(require('node:path').join(__dirname, '..', 'src', 'paper'), () => {});
  assert.ok(found.some((p) => p.root === 'ops' && p.name === 'weeklyScoreboard'));
});

test('statusLabel: fewer than 30 lifetime trades is always "too early", whatever the P&L', () => {
  assert.equal(statusLabel({ trades: 10, netPnlInr: 10000, winRatePct: 90 }), 'too early');
  assert.equal(statusLabel({ trades: 29, netPnlInr: -10000, winRatePct: 0 }), 'too early');
});

test('statusLabel: 30+ trades, net profit AND win rate >= 40% -> "ahead"', () => {
  assert.equal(statusLabel({ trades: 40, netPnlInr: 5000, winRatePct: 45 }), 'ahead');
});

test('statusLabel: 30+ trades, profitable but win rate below 40% (a few big wins) -> "under review", not "ahead"', () => {
  assert.equal(statusLabel({ trades: 40, netPnlInr: 5000, winRatePct: 25 }), 'under review');
});

test('statusLabel: 30+ trades, net loss -> "under review"', () => {
  assert.equal(statusLabel({ trades: 40, netPnlInr: -100, winRatePct: 60 }), 'under review');
});

test('buildWeeklyScoreboard: read-only aggregation across every bot given, with a grand total; empty input never throws', () => {
  const r0 = buildWeeklyScoreboard({ now: Date.now(), closedByBot: {} });
  assert.match(r0.text, /No demo bot has a closed trade yet/);

  const now = Date.parse('2026-11-22T06:00:00Z'); // a Sunday, 09:00+ IST
  const closedByBot = {
    confluence: [
      { exit_time: '2026-11-20T10:00:00Z', entry_time: '2026-11-20T09:00:00Z', pnl_inr: 500 },
      { exit_time: '2026-11-19T10:00:00Z', entry_time: '2026-11-19T09:00:00Z', pnl_inr: -200 },
    ],
    confluence_flow: [],
  };
  const r = buildWeeklyScoreboard({ now, closedByBot });
  assert.match(r.text, /confluence:/);
  assert.equal(r.data.stats.confluence.lifetime.trades, 2);
  assert.ok(Number.isFinite(r.data.grandLifetimeNetInr));
});
