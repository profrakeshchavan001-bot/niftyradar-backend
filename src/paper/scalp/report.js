'use strict';
// GET /api/paper/scalp-report: Scalp vs Intraday, read-only. Numbers per strategy: closed trades, win rate, net P&L in rupees, average time in trade,
// skips with their reasons, and per-pattern win rate (a pattern with fewer than 20 trades says "too few trades, no conclusion").
const P = require('../../../paperbot/patterns');
const { DEFAULTS, merge } = require('../../../paperbot/config');
const { istParts } = require('../../../paperbot/time');
const { loadScalpConfig, loadScalpWideConfig } = require('./config');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NO_CONCLUSION = 'too few trades, no conclusion';

const minutesIn = (t) => (t.exit_time && t.entry_time ? (Date.parse(t.exit_time) - Date.parse(t.entry_time)) / 60000 : null);

// One strategy: `closed` and `open` trades, `skips` rows.
function summarise({ closed, open, skips, minTrades }) {
  const wins = closed.filter((t) => t.pnl_inr > 0).length;
  const mins = closed.map(minutesIn).filter((m) => Number.isFinite(m));
  const net = closed.reduce((s, t) => s + (t.pnl_inr || 0), 0);
  const gross = closed.reduce((s, t) => s + (Number.isFinite(t.gross_pnl_inr) ? t.gross_pnl_inr : t.pnl_inr || 0), 0);
  const by = new Map();
  for (const t of closed) for (const name of t.patterns || []) {
    if (!by.has(name)) by.set(name, { pattern: name, trades: 0, wins: 0, pnl: 0 });
    const s = by.get(name); s.trades += 1; if (t.pnl_inr > 0) s.wins += 1; s.pnl += t.pnl_inr || 0;
  }
  const patterns = [...by.values()].map((s) => ({
    pattern: s.pattern, trades: s.trades, winRatePct: P.round((s.wins / s.trades) * 100, 1), netPnlInr: P.round(s.pnl, 2),
    conclusion: s.trades >= minTrades ? 'enough trades' : NO_CONCLUSION,
  })).sort((a, b) => b.trades - a.trades || a.pattern.localeCompare(b.pattern));
  const reasons = new Map();
  for (const s of skips) {
    const key = String(s.reason).replace(/"[^"]*"/g, '"..."').replace(/\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 110);
    const e = reasons.get(key) || { reason: key, n: 0, example: s.reason };
    e.n += 1; reasons.set(key, e);
  }
  return {
    trades: closed.length, open: open.length, wins, winRatePct: closed.length ? P.round((wins / closed.length) * 100, 1) : null,
    netPnlInr: P.round(net, 2), grossPnlInr: P.round(gross, 2), costsInr: P.round(gross - net, 2),
    avgMinutes: mins.length ? P.round(mins.reduce((a, b) => a + b, 0) / mins.length, 1) : null,
    conclusion: closed.length >= minTrades ? 'enough trades' : NO_CONCLUSION,
    patterns, skips: { total: skips.length, reasons: [...reasons.values()].sort((a, b) => b.n - a.n).slice(0, 10) },
  };
}

async function buildScalpData({ store, now = Date.now, scalpMarket = 'crypto_scalp', scalpWideMarket = 'crypto_wide_scalp' }) {
  const cfg = merge(DEFAULTS, await store.getConfig());
  const minTrades = cfg.learning.min_trades_for_conclusion;
  const since = istParts(now() - 7 * 86400000).date;
  const scalpClosed = await store.closedTrades(scalpMarket);
  const scalpWideClosed = await store.closedTrades(scalpWideMarket);
  const intradayClosed = await store.closedTrades(null); // intraday markets only (nse, crypto)
  const intradayOpen = [...await store.openTrades('nse'), ...await store.openTrades('crypto')];
  // CC3 urgent fix item 3: the EFFECTIVE config (stored paper_config row laid over the code default - the table always wins),
  // shown plainly so a stale stored value can never again silently override a later code-default change without anyone noticing.
  const effectiveConfig = { scalp: await loadScalpConfig(store), scalp_wide: await loadScalpWideConfig(store) };
  return {
    paperOnly: true,
    generatedAt: new Date(now()).toISOString(),
    minTrades,
    effectiveConfig,
    skipsWindow: `since ${since}`,
    scalp: summarise({ closed: scalpClosed, open: await store.openTrades(scalpMarket), skips: await store.skipsSince(since, scalpMarket), minTrades }),
    scalpWide: summarise({ closed: scalpWideClosed, open: await store.openTrades(scalpWideMarket), skips: await store.skipsSince(since, scalpWideMarket), minTrades }),
    intraday: summarise({ closed: intradayClosed, open: intradayOpen, skips: await store.skipsSince(since), minTrades }),
    recentScalp: (await store.listTrades(20, scalpMarket)).map((t) => ({ id: t.id, symbol: t.symbol, direction: t.direction, patterns: t.patterns, status: t.status, entry_price: t.entry_price, exit_price: t.exit_price, exit_reason: t.exit_reason, gross_pnl_inr: t.gross_pnl_inr ?? null, pnl_inr: t.pnl_inr ?? null, minutes: minutesIn(t) })),
    recentScalpWide: (await store.listTrades(20, scalpWideMarket)).map((t) => ({ id: t.id, symbol: t.symbol, direction: t.direction, patterns: t.patterns, status: t.status, entry_price: t.entry_price, exit_price: t.exit_price, exit_reason: t.exit_reason, gross_pnl_inr: t.gross_pnl_inr ?? null, pnl_inr: t.pnl_inr ?? null, minutes: minutesIn(t) })),
  };
}

const inr = (v) => (v == null ? '-' : `${v < 0 ? '-' : '+'}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`);

function block(name, s, minTrades) {
  const patterns = s.patterns.length
    ? `<table><tr><th>Pattern</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th><th></th></tr>${s.patterns.map((p) => `<tr><td>${esc(p.pattern)}</td><td>${p.trades}</td><td>${p.trades >= minTrades ? p.winRatePct : '-'}</td><td>${p.trades >= minTrades ? inr(p.netPnlInr) : '-'}</td><td>${p.trades >= minTrades ? '' : esc(NO_CONCLUSION)}</td></tr>`).join('')}</table>`
    : '<p class="m">No closed trades yet.</p>';
  const skips = s.skips.reasons.length
    ? `<table><tr><th>Skipped</th><th>Why (an example)</th></tr>${s.skips.reasons.map((r) => `<tr><td>${r.n}x</td><td>${esc(r.example)}</td></tr>`).join('')}</table>`
    : '<p class="m">No skips recorded.</p>';
  return `<section id="tab-${name}" class="tab"><div class="grid"><div><b>${s.trades}</b><span>closed trades</span></div><div><b>${s.winRatePct == null ? '-' : s.winRatePct + '%'}</b><span>win rate</span></div>
<div><b>${inr(s.netPnlInr)}</b><span>net P&amp;L${name === 'scalp' || name === 'scalp_wide' ? ` (gross ${inr(s.grossPnlInr)}, costs ${inr(-s.costsInr)})` : ''}</span></div><div><b>${s.avgMinutes == null ? '-' : s.avgMinutes + ' min'}</b><span>average time in trade</span></div><div><b>${s.open}</b><span>open now</span></div></div>
${s.trades < minTrades ? `<p class="m">${esc(NO_CONCLUSION)} (${s.trades} of ${minTrades} trades)</p>` : ''}
<h3>Per pattern</h3>${patterns}<h3>Skips (${s.skips.total}), last 7 days</h3>${skips}</section>`;
}

function renderScalpReport(d) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Paper: Scalp vs Intraday</title>
<style>body{font:15px/1.4 system-ui,sans-serif;margin:0;padding:12px;color:#1c1f24;background:#fff}h1{font-size:18px;margin:0 0 4px}h3{font-size:15px;margin:16px 0 6px}.m{color:#5b6470}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.grid div{border:1px solid #d9dde3;border-radius:8px;padding:8px}.grid b{display:block;font-size:18px}.grid span{color:#5b6470;font-size:12px}table{border-collapse:collapse;width:100%}th,td{border-bottom:1px solid #e5e8ec;padding:5px 6px;text-align:left;font-size:13px;vertical-align:top}button{font:inherit;padding:6px 14px;border:1px solid #1c1f24;background:#fff;border-radius:6px;margin-right:6px}button.on{background:#1c1f24;color:#fff}.tab{display:none}.tab.on{display:block}</style></head><body>
<h1>NiftyRadar PAPER bot: Scalp vs Intraday</h1><p class="m">Demo only, no real money. Updated ${esc(d.generatedAt)}. Scalp P&amp;L is after fees and slippage.</p>
<p class="m">Effective config (stored row over the code default - the stored row always wins): scalp min_rr <b>${d.effectiveConfig?.scalp?.min_rr}</b>, scalp_wide min_rr <b>${d.effectiveConfig?.scalp_wide?.min_rr}</b></p>
<p><button id="b-scalp" class="on" type="button">Scalp</button><button id="b-scalp_wide" type="button">Scalp wide</button><button id="b-intraday" type="button">Intraday</button></p>
${block('scalp', d.scalp, d.minTrades).replace('class="tab"', 'class="tab on"')}${block('scalp_wide', d.scalpWide, d.minTrades)}${block('intraday', d.intraday, d.minTrades)}
<script>(function(){function show(n){['scalp','scalp_wide','intraday'].forEach(function(k){document.getElementById('tab-'+k).className='tab'+(k===n?' on':'');document.getElementById('b-'+k).className=k===n?'on':'';});}
document.getElementById('b-scalp').onclick=function(){show('scalp')};document.getElementById('b-scalp_wide').onclick=function(){show('scalp_wide')};document.getElementById('b-intraday').onclick=function(){show('intraday')};})();</script></body></html>`;
}

module.exports = { buildScalpData, renderScalpReport, summarise, NO_CONCLUSION };
