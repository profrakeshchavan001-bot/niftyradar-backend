'use strict';
// confluence (Bot A) orchestration (crypto, 5-minute entries, BTC/ETH/SOL). PAPER ONLY: no order API
// anywhere. Every dependency is injected so tests drive it with fake candles and a fake clock. Max 6
// trades/day/bot (own counter against this bot's own table), own capital pool, own P&L ledger - mirrors
// src/paper/scalp/bot.js's (scalp_wide's) fee/slippage model exactly (engine.js's settle()).
const P = require('../../../../paperbot/patterns');
const E = require('../../../../paperbot/engine');
const { istParts, istDayStart } = require('../../../../paperbot/time');
const { decide, evaluateExit, settle } = require('./engine');

const MARKET = 'confluence';

function createConfluenceBot({ store, crypto, loadCfg, shadowStore, now = Date.now, log = console.log, botName = 'confluence', onEntry = null, onExit = null }) {
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

  // extraGate(plan, symbol): optional async hook confluence_flow uses to fetch + attach an order-flow
  // reading into the decide() context (plan.context.flow) before the reward/risk check runs; confluence
  // itself passes none, so decide() runs with no `flow` key and the extra gate inside decide() never fires.
  async function scan({ beforeDecide } = {}) {
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
      if (openFlat.some((t) => t.symbol === symbol) || entered.includes(symbol)) continue; // 1 open confluence trade per coin
      let c5; let c1h;
      try { [c5, c1h] = await Promise.all([crypto.candles(symbol), crypto.hourly(symbol)]); } catch (e) { log(`[${botName}] candles for ${symbol} failed: ${e.response?.status || e.message}`); continue; }
      const closed5 = E.closedOnly(c5, 300000, now());
      const closed1h = E.closedOnly(c1h, 3600000, now());
      const ctx5 = E.buildContext(closed5, istDayStart(now()));
      const context = { vwap: ctx5.vwap, c1h: closed1h, dayStartMs: istDayStart(now()), nowMs: now(), cfg };
      if (beforeDecide) await beforeDecide(context, symbol); // confluence_flow attaches context.flow here
      const d = decide(closed5, context);
      if (!d.take) { if (!d.quiet) await skip(symbol, d.reason, d.extra || {}); continue; }
      if (today.some((t) => t.symbol === symbol && t.trigger_t === d.trigger_t)) continue; // this candle was already traded
      const stopPct = Math.abs(d.entry - d.stop) / d.entry * 100;
      const size = E.sizeCrypto({ capital: cfg.capital_usdt, riskPct: cfg.risk_pct, stopPct, freeCash, price: d.entry, coins: cfg.symbols.length });
      if (!size) { await skip(symbol, 'no free virtual USDT balance', { patterns: d.patterns, trigger_t: d.trigger_t }); continue; }
      const long = d.direction === 'up';
      const row = {
        symbol, trade_date: date, status: 'open', direction: long ? 'LONG' : 'SHORT',
        trigger_t: d.trigger_t, entry_price: d.entry, entry_time: new Date(now()).toISOString(),
        sl_price: d.stop, target_price: d.target, stop_type: d.stopType, target_type: d.targetType,
        location_type: d.locationType, pattern: d.pattern, obstacles_on_path: JSON.stringify(d.obstaclesOnPath || []),
        qty: size.qty, rr: d.rr, basis: d.basis,
      };
      const id = await store.insertTrade(row);
      if (id == null) continue; // restart safety: unique (symbol, trigger_t) caught a duplicate of this exact candle
      log(`[${botName}] PAPER entry ${symbol} ${row.direction} @ ${d.entry}: ${d.locationType} + ${d.pattern}; target ${d.target}, stop ${d.stop}, R ${d.rr}`);
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
      const patch = {
        status: 'closed', exit_price: ev.price, exit_time: new Date(ev.timeMs).toISOString(), exit_reason: ev.reason,
        ...s, fx_rate: fx.rate, fx_source: fx.source,
      };
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

module.exports = { createConfluenceBot, MARKET };
