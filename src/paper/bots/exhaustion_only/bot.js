'use strict';
// exhaustion_only orchestration (crypto, 5-minute candles). PAPER ONLY: no order API anywhere. Dependencies are injected so tests drive
// it with fake candles and a fake clock, same pattern as src/paper/scalp/bot.js.
const { closedOnly, buildContext, sizeCrypto } = require('../../../../paperbot/engine');
const { istParts, istDayStart } = require('../../../../paperbot/time');
const { decide, evaluateExit, settle } = require('./engine');

const MARKET = 'crypto_exhaustion_only';
const FIVE = 5 * 60000;

function createExhaustionBot({ store, crypto, loadCfg, shadowStore, now = Date.now, log = console.log }) {
  const skipSeen = new Set();

  async function skip(symbol, reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `${date}|${symbol}|${reason}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[exhaustion_only] skip ${symbol}: ${reason}`);
    await store.insertSkip({ symbol, skip_date: date, reason });
    if (extra.shadowPlan && shadowStore) {
      await shadowStore.insertShadow({ bot: 'exhaustion_only', symbol, setup_date: date, trigger_t: extra.shadowPlan.trigger_t, direction: extra.shadowPlan.direction, entry_price: extra.shadowPlan.entry_price, sl_price: extra.shadowPlan.sl_price, target_price: extra.shadowPlan.target_price, skip_reason: reason });
    }
  }

  async function resolveShadows() {
    if (!shadowStore) return { checked: 0, resolved: 0 };
    const open = await shadowStore.openShadows('exhaustion_only');
    if (!open.length) return { checked: 0, resolved: 0 };
    let resolved = 0;
    for (const sh of open) {
      let c5;
      try { c5 = await crypto.candles(sh.symbol); } catch (e) { log(`[exhaustion_only] shadow candles for ${sh.symbol} failed: ${e.response?.status || e.message}`); continue; }
      const ev = evaluateExit({ trade: sh, candles: closedOnly(c5, FIVE, now()) });
      if (!ev.exit) continue;
      await shadowStore.resolveShadow(sh.id, { resolved_reason: ev.reason, resolved_price: ev.price, resolved_time: new Date(ev.timeMs).toISOString() });
      log(`[exhaustion_only] shadow resolved ${sh.symbol}: ${ev.reason} @ ${ev.price} (would-be, never a trade)`);
      resolved += 1;
    }
    return { checked: open.length, resolved };
  }

  async function scan() {
    const cfg = await loadCfg();
    const date = istParts(now()).date;
    const today = await store.tradesForDay(date);
    const open = await store.allOpenTrades();
    let freeCash = cfg.capital_usdt - open.reduce((s, t) => s + t.entry_price * t.qty, 0);
    const entered = [];
    for (const symbol of cfg.symbols) {
      if (open.some((t) => t.symbol === symbol) || entered.includes(symbol)) continue; // 1 open trade per coin; no daily cap, no cooldown
      let c5; let c1h;
      try { [c5, c1h] = await Promise.all([crypto.candles(symbol), crypto.hourly(symbol)]); } catch (e) { log(`[exhaustion_only] candles for ${symbol} failed: ${e.response?.status || e.message}`); continue; }
      const closed5 = closedOnly(c5, FIVE, now());
      const ctx5 = buildContext(closed5, istDayStart(now()));
      const d = decide(closed5, { vwap: ctx5.vwap, c1h: closedOnly(c1h, 3600000, now()), nowMs: now(), cfg });
      if (!d.take) { if (!d.quiet) await skip(symbol, d.reason, d.extra || {}); continue; }
      if (today.some((t) => t.symbol === symbol && t.trigger_t === d.trigger_t)) continue; // this candle was already traded
      const stopPct = Math.abs(d.entry - d.stop) / d.entry * 100;
      const size = sizeCrypto({ capital: cfg.capital_usdt, riskPct: cfg.risk_pct, stopPct, freeCash, price: d.entry, coins: cfg.symbols.length });
      if (!size) { await skip(symbol, 'no free virtual USDT balance for exhaustion_only'); continue; }
      const row = {
        symbol, trade_date: date, status: 'open', direction: d.direction === 'up' ? 'LONG' : 'SHORT',
        trigger_t: d.trigger_t, entry_price: d.entry, entry_time: new Date(now()).toISOString(), qty: size.qty,
        sl_price: d.stop, target_price: d.target, stop_type: d.stopType, target_type: d.targetType, rr: d.rr, basis: d.basis,
      };
      const id = await store.insertTrade(row);
      if (id == null) continue; // restart safety: the DB's own unique (symbol, trigger_t) index caught a duplicate of this exact candle
      log(`[exhaustion_only] PAPER entry ${symbol} ${row.direction} @ ${d.entry}: ${d.pattern}; target ${d.target}, stop ${d.stop}, R ${d.rr}`);
      freeCash -= size.value;
      entered.push(symbol); today.push({ ...row, id });
    }
    return { ran: true, entered };
  }

  async function monitor() {
    const cfg = await loadCfg();
    const open = await store.allOpenTrades();
    if (!open.length) { await resolveShadows(); return { checked: 0, closed: 0 }; }
    let closed = 0;
    for (const t of open) {
      let c5;
      try { c5 = await crypto.candles(t.symbol); } catch (e) { log(`[exhaustion_only] candles for ${t.symbol} failed: ${e.response?.status || e.message}`); continue; }
      const ev = evaluateExit({ trade: t, candles: closedOnly(c5, FIVE, now()) });
      if (!ev.exit) continue;
      const fx = await crypto.usdtInr(cfg.usdt_inr_fallback);
      const s = settle({ trade: t, exitPrice: ev.price, cfg, fxRate: fx.rate });
      await store.updateTrade(t.id, { status: 'closed', exit_price: ev.price, exit_time: new Date(ev.timeMs).toISOString(), exit_reason: ev.reason, ...s, fx_rate: fx.rate, fx_source: fx.source });
      log(`[exhaustion_only] PAPER exit ${t.symbol}: ${ev.reason}, gross ${s.gross_pnl_usdt} net ${s.net_pnl_usdt} USDT (Rs ${s.pnl_inr})`);
      closed += 1;
    }
    await resolveShadows();
    return { checked: open.length, closed };
  }

  return { scan, monitor };
}

module.exports = { createExhaustionBot, MARKET };
