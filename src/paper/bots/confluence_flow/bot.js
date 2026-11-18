'use strict';
// confluence_flow (Bot B) orchestration (crypto, 5-minute entries, BTC/ETH/SOL). Same as confluence
// (Bot A, src/paper/bots/confluence/bot.js) plus one extra gate: the order-flow reading (GROUP 3,
// src/paper/lib/orderFlow.js) must agree with the trade direction, or the idea is skipped and logged to
// the shadow log with the reason. Every setup (taken or skipped) also gets a small persisted order-flow
// sample (own table, schema.sql) for later offline study. PAPER ONLY: no order API anywhere.
const P = require('../../../../paperbot/patterns');
const E = require('../../../../paperbot/engine');
const { istParts, istDayStart } = require('../../../../paperbot/time');
const { decide, evaluateExit, settle } = require('../confluence/engine');

const MARKET = 'confluence_flow';

function createConfluenceFlowBot({ store, crypto, orderFlow, loadCfg, shadowStore, now = Date.now, log = console.log, botName = 'confluence_flow', onEntry = null, onExit = null }) {
  const skipSeen = new Set();

  async function recordShadow(symbol, reason, extra) {
    if (!extra.shadowPlan || !shadowStore) return;
    const date = istParts(now()).date;
    await shadowStore.insertShadow({ bot: botName, symbol, setup_date: date, trigger_t: extra.shadowPlan.trigger_t, direction: extra.shadowPlan.direction, entry_price: extra.shadowPlan.entry_price, sl_price: extra.shadowPlan.sl_price, target_price: extra.shadowPlan.target_price, skip_reason: reason });
  }

  async function skip(symbol, reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `${date}|${symbol}|${reason}|${extra.trigger_t || ''}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[${botName}] skip ${symbol}: ${reason}`);
    await store.insertSkip({ symbol, skip_date: date, reason });
    await recordShadow(symbol, reason, extra);
  }

  async function recordFlowSample(symbol, triggerT, took, direction, flow) {
    if (!store.insertFlowSample || triggerT == null) return;
    try {
      await store.insertFlowSample({
        symbol, sample_date: istParts(now()).date, trigger_t: triggerT, took_trade: took, direction: direction || null,
        flow_direction: flow?.direction ?? null, flow_strength: flow?.strength ?? null,
        top5: flow?.detail?.top5 ?? null, top10: flow?.detail?.top10 ?? null, cvd30: flow?.detail?.cvd30 ?? null, cvd60: flow?.detail?.cvd60 ?? null, cvd120: flow?.detail?.cvd120 ?? null,
      });
    } catch (e) { log(`[${botName}] flow sample for ${symbol} not stored: ${e.message}`); }
  }

  async function resolveShadows(fetchCandles, intervalMs) {
    if (!shadowStore) return { checked: 0, resolved: 0 };
    try {
      const open = await shadowStore.openShadows(botName);
      if (!open.length) return { checked: 0, resolved: 0 };
      const cfg = await loadCfg();
      let resolved = 0;
      for (const sh of open) {
        try {
          const candles = await fetchCandles(sh.symbol);
          const ev = evaluateExit({ trade: sh, candles: E.closedOnly(candles, intervalMs, now()), cfg });
          if (!ev.exit) continue;
          await shadowStore.resolveShadow(sh.id, { resolved_reason: ev.reason, resolved_price: ev.price, resolved_time: new Date(ev.timeMs).toISOString() });
          log(`[${botName}] shadow resolved ${sh.symbol}: ${ev.reason} @ ${ev.price} (would-be, never a trade)`);
          resolved += 1;
        } catch (e) { log(`[${botName}] shadow ${sh.id} (${sh.symbol}) failed to resolve: ${e.response?.status || e.message}`); }
      }
      return { checked: open.length, resolved };
    } catch (e) {
      log(`[${botName}] resolveShadows failed: ${e.message}`);
      return { checked: 0, resolved: 0, error: e.message };
    }
  }

  async function scan() {
    const cfg = await loadCfg();
    const date = istParts(now()).date;
    const today = await store.tradesForDay(date);
    const tradesToday = today.length;
    if (tradesToday >= cfg.max_trades_per_day) return { ran: true, entered: [], reason: `max ${cfg.max_trades_per_day} trades/day reached` };
    const openFlat = (await Promise.all(cfg.symbols.map((s) => store.openTrades(s)))).flat();
    let freeCash = cfg.capital_usdt - openFlat.reduce((s, t) => s + t.entry_price * t.qty, 0);
    const entered = [];
    let remaining = cfg.max_trades_per_day - tradesToday;
    for (const symbol of cfg.symbols) {
      if (remaining <= 0) break;
      if (openFlat.some((t) => t.symbol === symbol) || entered.includes(symbol)) continue;
      let c5; let c1h;
      try { [c5, c1h] = await Promise.all([crypto.candles(symbol), crypto.hourly(symbol)]); } catch (e) { log(`[${botName}] candles for ${symbol} failed: ${e.response?.status || e.message}`); continue; }
      const closed5 = E.closedOnly(c5, 300000, now());
      const closed1h = E.closedOnly(c1h, 3600000, now());
      const ctx5 = E.buildContext(closed5, istDayStart(now()));
      // Location+trigger first on a flow-free context, purely to know whether there IS a setup worth a
      // flow read at all (the flow API call is the costly step - no point spending it on "no setup").
      const probeContext = { vwap: ctx5.vwap, c1h: closed1h, dayStartMs: istDayStart(now()), nowMs: now(), cfg };
      const probe = decide(closed5, probeContext);
      const last = closed5[closed5.length - 1];
      if (probe.quiet) continue; // nothing at all - not even worth a skip log or a flow sample
      let flow = null;
      if (last) {
        try { flow = await orderFlow.read(symbol); } catch (e) { log(`[${botName}] order flow for ${symbol} failed: ${e.message}`); flow = { direction: 'neutral', strength: 0, error: e.message }; }
      }
      const context = { ...probeContext, flow };
      const d = decide(closed5, context);
      const wantedDir = probe.direction || d.direction || (probe.extra?.shadowPlan?.direction === 'LONG' ? 'up' : probe.extra?.shadowPlan?.direction === 'SHORT' ? 'down' : null);
      await recordFlowSample(symbol, last?.t, d.take, wantedDir === 'up' ? 'LONG' : wantedDir === 'down' ? 'SHORT' : null, flow);
      if (!d.take) { if (!d.quiet) await skip(symbol, d.reason, d.extra || {}); continue; }
      if (today.some((t) => t.symbol === symbol && t.trigger_t === d.trigger_t)) continue;
      const stopPct = Math.abs(d.entry - d.stop) / d.entry * 100;
      const size = E.sizeCrypto({ capital: cfg.capital_usdt, riskPct: cfg.risk_pct, stopPct, freeCash, price: d.entry, coins: cfg.symbols.length });
      if (!size) { await skip(symbol, 'no free virtual USDT balance', { patterns: d.patterns, trigger_t: d.trigger_t }); continue; }
      const long = d.direction === 'up';
      const row = {
        symbol, trade_date: date, status: 'open', direction: long ? 'LONG' : 'SHORT',
        trigger_t: d.trigger_t, entry_price: d.entry, entry_time: new Date(now()).toISOString(),
        sl_price: d.stop, target_price: d.target, stop_type: d.stopType, target_type: d.targetType,
        location_type: d.locationType, pattern: d.pattern, flow_direction: flow?.direction ?? null, flow_strength: flow?.strength ?? null,
        obstacles_on_path: JSON.stringify(d.obstaclesOnPath || []), qty: size.qty, rr: d.rr, basis: d.basis,
      };
      const id = await store.insertTrade(row);
      if (id == null) continue;
      log(`[${botName}] PAPER entry ${symbol} ${row.direction} @ ${d.entry}: ${d.locationType} + ${d.pattern}; flow ${flow?.direction}; target ${d.target}, stop ${d.stop}, R ${d.rr}`);
      freeCash -= size.value;
      entered.push(symbol);
      remaining -= 1;
      if (onEntry) { try { await onEntry({ ...row, id }, d); } catch (e) { log(`[${botName}] onEntry alert failed: ${e.message}`); } }
    }
    return { ran: true, entered };
  }

  async function monitor() {
    const cfg = await loadCfg();
    const open = (await Promise.all(cfg.symbols.map((s) => store.openTrades(s)))).flat();
    if (!open.length) { await resolveShadows((symbol) => crypto.candles(symbol), 300000); return { checked: 0, closed: 0 }; }
    let closed = 0;
    for (const t of open) {
      let candles;
      try { candles = await crypto.candles(t.symbol); } catch (e) { log(`[${botName}] candles for ${t.symbol} failed: ${e.response?.status || e.message}`); continue; }
      const ev = evaluateExit({ trade: t, candles: E.closedOnly(candles, 300000, now()), cfg });
      if (!ev.exit) continue;
      const fx = await crypto.usdtInr(cfg.usdt_inr_fallback);
      const s = settle({ trade: t, exitPrice: ev.price, cfg, fxRate: fx.rate });
      const patch = { status: 'closed', exit_price: ev.price, exit_time: new Date(ev.timeMs).toISOString(), exit_reason: ev.reason, ...s, fx_rate: fx.rate, fx_source: fx.source };
      await store.updateTrade(t.id, patch);
      log(`[${botName}] PAPER exit ${t.symbol}: ${ev.reason}, gross ${s.gross_pnl_usdt} net ${s.net_pnl_usdt} USDT (Rs ${s.pnl_inr})`);
      closed += 1;
      if (onExit) { try { await onExit({ ...t, ...patch }); } catch (e) { log(`[${botName}] onExit alert failed: ${e.message}`); } }
    }
    await resolveShadows((symbol) => crypto.candles(symbol), 300000);
    return { checked: open.length, closed };
  }

  async function backfillShadows() {
    const r = await resolveShadows((symbol) => crypto.candles(symbol), 300000);
    log(`[${botName}] shadow backfill: ${r.resolved}/${r.checked}`);
    return r;
  }

  return { scan, monitor, backfillShadows, resolveShadows };
}

module.exports = { createConfluenceFlowBot, MARKET };
