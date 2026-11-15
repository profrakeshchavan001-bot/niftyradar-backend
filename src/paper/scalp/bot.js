'use strict';
// Scalp bot orchestration (crypto, 1-minute entries). PAPER ONLY: no order API anywhere. Every dependency is injected, so tests drive it with fake candles and a fake clock.
// Trades live under market 'crypto_scalp' with strategy 'scalp', so the intraday monitor, reports and judge never see them.
const P = require('../../../paperbot/patterns');
const E = require('../../../paperbot/engine');
const { istParts, istDayStart } = require('../../../paperbot/time');
const { loadScalpConfig, loadScalpWideConfig } = require('./config');
const { analyse, analyseWide, evaluateExit, settle } = require('./engine');
const { recoveryLimit } = require('../lib/recoveryWindow');

const MARKET = 'crypto_scalp';
const MARKET_WIDE = 'crypto_wide_scalp'; // scalp_wide: own market key, own virtual balance, independent of scalp and intraday

function basisText(plan, symbol) {
  const p = plan.hits.map((h) => `${h.name.replace(/_/g, ' ')} (${h.note})`).join('; ');
  const lvl = plan.level ? `nearest ${plan.long ? 'resistance' : 'support'} ${plan.level.price} is ${plan.level.pct}% away` : 'no level in the way, target at the cap';
  return `Scalp ${plan.long ? 'LONG' : 'SHORT'} on ${symbol}: the 1-min chart showed ${p}. 5-min trend ${plan.trend5}, price ${plan.ctx5.price} vs VWAP ${plan.ctx5.vwap}. `
    + `Target +${plan.targetPct}% (${lvl}), stop ${plan.stopPct}% (beyond the pattern candle + 0.5 x ATR), costs ${plan.costPct}% round trip, reward/risk ${plan.rr} after costs. `
    + 'Exits: target, stop, stop moved to breakeven half way, or out after the time stop.';
}

function basisTextWide(plan, symbol) {
  const p = plan.hits.map((h) => `${h.name.replace(/_/g, ' ')} (${h.note})`).join('; ');
  const lvl = `nearest ${plan.long ? 'resistance' : 'support'} ${plan.level.price} is ${plan.level.pct}% away`;
  return `Scalp wide ${plan.long ? 'LONG' : 'SHORT'} on ${symbol}: the 5-min chart showed ${p}. 15-min trend ${plan.trend15}, price ${plan.ctx15.price} vs VWAP ${plan.ctx15.vwap}. `
    + `Target +${plan.targetPct}% (${lvl}), stop ${plan.stopPct}% (beyond the pattern candle + 0.5 x ATR14(5m)), costs ${plan.costPct}% round trip, reward/risk ${plan.rr} after costs. `
    + 'Exits: target, stop, stop moved to breakeven half way, or out after the 45-minute time stop.';
}

function createScalpBot({ store, crypto, source1m, shadowStore, now = Date.now, log = console.log }) {
  const skipSeen = new Set();
  const nseNoted = new Set();

  // Shadow tracking (docs/BOTS.md): a skip whose plan made it all the way to the reward/risk gate carries a shadowPlan (full
  // entry/stop/target) - followed on paper in its own table, never counted as a trade. A skip with no shadowPlan (no setup, too few
  // candles, no room for a target) has nothing to follow, so it is just logged as before.
  async function recordShadow(bot, symbol, reason, extra) {
    if (!extra.shadowPlan || !shadowStore) return;
    const date = istParts(now()).date;
    await shadowStore.insertShadow({ bot, symbol, setup_date: date, trigger_t: extra.shadowPlan.trigger_t, direction: extra.shadowPlan.direction, entry_price: extra.shadowPlan.entry_price, sl_price: extra.shadowPlan.sl_price, target_price: extra.shadowPlan.target_price, skip_reason: reason });
  }

  async function skip(symbol, reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `${date}|${symbol}|${reason}|${extra.trigger_t || ''}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[scalp] skip ${symbol}: ${reason}`);
    await store.insertSkip({ market: MARKET, symbol, skip_date: date, reason, r_factor: extra.r_factor ?? null, patterns: extra.patterns || null, trend_state: extra.trend_state || null, data_source: 'binance_public', data_delay_sec: null });
    await recordShadow('scalp', symbol, reason, extra);
  }

  // Walks every open shadow for `bot`, resolves it the same way a real trade of that bot would exit (same evaluateExit, same candles).
  // CC3 urgent fix: the WHOLE body is now wrapped - previously only the candle fetch was, so a throw from openShadows/resolveShadow
  // itself (a real Postgres error, not just a dead Binance call) silently killed the ENTIRE resolveShadows() call for every shadow
  // on that tick, every tick, forever, with only a line in the server's own log (never seen) - exactly how 10 shadows stayed open
  // 40+ minutes past their target/time stop. It must never again be able to stop real-trade exit processing in cryptoScalpMonitor.
  async function resolveShadows(bot, fetchCandles, intervalMs) {
    if (!shadowStore) return { checked: 0, resolved: 0 };
    try {
      const open = await shadowStore.openShadows(bot);
      if (!open.length) return { checked: 0, resolved: 0 };
      const cfg = bot === 'scalp' ? await loadScalpConfig(store) : await loadScalpWideConfig(store);
      let resolved = 0;
      for (const sh of open) {
        try {
          const candles = await fetchCandles(sh.symbol);
          const ev = evaluateExit({ trade: sh, candles: E.closedOnly(candles, intervalMs, now()), nowMs: now(), cfg });
          if (!ev.exit) continue;
          await shadowStore.resolveShadow(sh.id, { resolved_reason: ev.reason, resolved_price: ev.price, resolved_time: new Date(ev.timeMs).toISOString() });
          log(`[${bot}] shadow resolved ${sh.symbol}: ${ev.reason} @ ${ev.price} (would-be, never a trade)`);
          resolved += 1;
        } catch (e) { log(`[${bot}] shadow ${sh.id} (${sh.symbol}) failed to resolve: ${e.response?.status || e.message}`); }
      }
      return { checked: open.length, resolved };
    } catch (e) {
      log(`[${bot}] resolveShadows failed: ${e.message}`);
      return { checked: 0, resolved: 0, error: e.message };
    }
  }
  async function cryptoScalpScan() {
    const cfg = await loadScalpConfig(store);
    const date = istParts(now()).date;
    const today = await store.tradesForDay(MARKET, date);
    const open = await store.openTrades(MARKET);
    let freeCash = cfg.capital_usdt - open.reduce((s, t) => s + t.entry_price * t.qty, 0);
    const entered = [];
    for (const symbol of cfg.symbols) {
      if (open.some((t) => t.symbol === symbol) || entered.includes(symbol)) continue; // 1 open scalp per coin; no daily cap, no cooldown
      let c1; let c5;
      try { [c1, c5] = await Promise.all([source1m.candles1m(symbol, 120), crypto.candles(symbol)]); } catch (e) { log(`[scalp] candles for ${symbol} failed: ${e.response?.status || e.message}`); continue; }
      const a = analyse({ c1raw: c1, c5raw: c5, now: now(), cfg, dayStartMs: istDayStart(now()) });
      if (!a.ok) { if (!a.quiet) await skip(symbol, a.reason, a.extra || {}); continue; }
      const plan = a.plan;
      if (today.some((t) => t.symbol === symbol && t.trigger_t === plan.last.t)) continue; // this candle was already traded
      const size = E.sizeCrypto({ capital: cfg.capital_usdt, riskPct: cfg.risk_pct, stopPct: plan.stopPct, freeCash, price: plan.entry, coins: cfg.symbols.length });
      if (!size) { await skip(symbol, 'no free virtual USDT balance for scalps', { patterns: plan.hits.map((h) => h.name), trigger_t: plan.last.t }); continue; }
      const long = plan.long;
      const row = {
        market: MARKET, strategy: 'scalp', symbol, trade_date: date, status: 'open', r_factor: plan.rr, score_source: 'scalp reward/risk after costs (target / stop, fees and slippage included)',
        direction: long ? 'LONG' : 'SHORT', patterns: plan.hits.map((h) => h.name),
        trigger_candles: plan.hits.map((h) => ({ pattern: h.name, direction: h.direction, note: h.note, candles: h.candles })),
        trigger_t: plan.last.t, trend_state: { ...plan.ctx5, trend5: plan.trend5, atr1m: P.round(plan.atr, 6), level: plan.level },
        smc_tags: plan.hits.filter((h) => h.kind === 'smc').map((h) => h.name), news_filter: 'not applied to crypto',
        instrument: `${symbol} spot (paper scalp)`, simulated_option: false, price_source: 'binance_public_1m_close', candle_source: 'binance_public_klines_1m_and_5m',
        data_source: 'binance_public', data_delay_sec: Math.round((now() - (plan.last.t + 60000)) / 1000),
        qty: size.qty, entry_price: plan.entry, entry_time: new Date(now()).toISOString(), entry_underlying: plan.entry,
        sl_price: plan.stopPrice, target_price: plan.targetPrice, max_fav_pct: 0, max_adv_pct: 0, basis: basisText(plan, symbol),
      };
      const id = await store.insertTrade(row);
      if (id == null) continue; // restart safety: the DB's own unique (market, symbol, trigger_t) index caught a duplicate of this exact candle
      log(`[scalp] PAPER entry ${symbol} ${row.direction} @ ${plan.entry}: ${row.patterns.join(', ')}; target ${plan.targetPrice}, stop ${plan.stopPrice}, R ${plan.rr}`);
      freeCash -= size.value;
      entered.push(symbol);
    }
    return { ran: true, entered };
  }

  async function cryptoScalpMonitor() {
    const open = await store.openTrades(MARKET);
    if (!open.length) { await resolveShadows('scalp', (symbol) => source1m.candles1m(symbol, 40), 60000); return { checked: 0, closed: 0 }; }
    const cfg = await loadScalpConfig(store);
    let closed = 0;
    for (const t of open) {
      let candles;
      const limit = recoveryLimit({ oldestEntryMs: Date.parse(t.entry_time), nowMs: now(), intervalMs: 60000, defaultLimit: 40 });
      try { candles = await source1m.candles1m(t.symbol, limit); } catch (e) { log(`[scalp] candles for ${t.symbol} failed: ${e.response?.status || e.message}`); continue; }
      const ev = evaluateExit({ trade: t, candles: E.closedOnly(candles, 60000, now()), nowMs: now(), cfg });
      if (!ev.exit) { if (ev.favPct > (t.max_fav_pct || 0) || ev.advPct < (t.max_adv_pct || 0)) await store.noteTrade(t.id, { max_fav_pct: ev.favPct, max_adv_pct: ev.advPct }); continue; }
      const fx = await crypto.usdtInr(cfg.usdt_inr_fallback);
      const s = settle({ trade: t, exitPrice: ev.price, cfg, fxRate: fx.rate });
      await store.updateTrade(t.id, {
        status: 'closed', exit_price: ev.price, exit_underlying: ev.price, exit_time: new Date(ev.timeMs).toISOString(), exit_reason: ev.reason,
        ...s, fx_rate: fx.rate, fx_source: fx.source, max_fav_pct: ev.favPct, max_adv_pct: ev.advPct, be_moved: ev.beMoved,
      });
      log(`[scalp] PAPER exit ${t.symbol}: ${ev.reason}, gross ${s.gross_pnl_usdt} net ${s.net_pnl_usdt} USDT (Rs ${s.pnl_inr})`);
      closed += 1;
    }
    await resolveShadows('scalp', (symbol) => source1m.candles1m(symbol, 40), 60000);
    return { checked: open.length, closed };
  }

  async function skipWide(symbol, reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `wide|${date}|${symbol}|${reason}|${extra.trigger_t || ''}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[scalp_wide] skip ${symbol}: ${reason}`);
    await store.insertSkip({ market: MARKET_WIDE, symbol, skip_date: date, reason, r_factor: extra.r_factor ?? null, patterns: extra.patterns || null, trend_state: extra.trend_state || null, data_source: 'binance_public', data_delay_sec: null });
    await recordShadow('scalp_wide', symbol, reason, extra);
  }

  // scalp_wide: 5-minute entries, 15-minute trend. Reads the same 5-minute candles crypto.candles() already returns for the tight scalp's trend,
  // so no extra API call is made; the 15-minute candles are built from them (E.aggregate, inside analyseWide) unless a native feed is wired later.
  async function cryptoScalpWideScan() {
    const cfg = await loadScalpWideConfig(store);
    const date = istParts(now()).date;
    const today = await store.tradesForDay(MARKET_WIDE, date);
    const open = await store.openTrades(MARKET_WIDE);
    let freeCash = cfg.capital_usdt - open.reduce((s, t) => s + t.entry_price * t.qty, 0);
    const entered = [];
    for (const symbol of cfg.symbols) {
      if (open.some((t) => t.symbol === symbol) || entered.includes(symbol)) continue; // 1 open scalp_wide per coin; no daily cap, no cooldown
      let c5;
      try { c5 = await crypto.candles(symbol); } catch (e) { log(`[scalp_wide] candles for ${symbol} failed: ${e.response?.status || e.message}`); continue; }
      const a = analyseWide({ c5raw: c5, now: now(), cfg, dayStartMs: istDayStart(now()) });
      if (!a.ok) { if (!a.quiet) await skipWide(symbol, a.reason, a.extra || {}); continue; }
      const plan = a.plan;
      if (today.some((t) => t.symbol === symbol && t.trigger_t === plan.last.t)) continue; // this candle was already traded
      const size = E.sizeCrypto({ capital: cfg.capital_usdt, riskPct: cfg.risk_pct, stopPct: plan.stopPct, freeCash, price: plan.entry, coins: cfg.symbols.length });
      if (!size) { await skipWide(symbol, 'no free virtual USDT balance for scalp_wide', { patterns: plan.hits.map((h) => h.name), trigger_t: plan.last.t }); continue; }
      const long = plan.long;
      const row = {
        market: MARKET_WIDE, strategy: 'scalp_wide', symbol, trade_date: date, status: 'open', r_factor: plan.rr, score_source: 'scalp_wide reward/risk after costs (target / stop, fees and slippage included)',
        direction: long ? 'LONG' : 'SHORT', patterns: plan.hits.map((h) => h.name),
        trigger_candles: plan.hits.map((h) => ({ pattern: h.name, direction: h.direction, note: h.note, candles: h.candles })),
        trigger_t: plan.last.t, trend_state: { ...plan.ctx15, trend15: plan.trend15, atr5m: P.round(plan.atr, 6), level: plan.level },
        smc_tags: plan.hits.filter((h) => h.kind === 'smc').map((h) => h.name), news_filter: 'not applied to crypto',
        instrument: `${symbol} spot (paper scalp_wide)`, simulated_option: false, price_source: 'binance_public_5m_close', candle_source: 'binance_public_klines_5m',
        data_source: 'binance_public', data_delay_sec: Math.round((now() - (plan.last.t + 300000)) / 1000),
        qty: size.qty, entry_price: plan.entry, entry_time: new Date(now()).toISOString(), entry_underlying: plan.entry,
        sl_price: plan.stopPrice, target_price: plan.targetPrice, max_fav_pct: 0, max_adv_pct: 0, basis: basisTextWide(plan, symbol),
      };
      const id = await store.insertTrade(row);
      if (id == null) continue; // restart safety: the DB's own unique (market, symbol, trigger_t) index caught a duplicate of this exact candle
      log(`[scalp_wide] PAPER entry ${symbol} ${row.direction} @ ${plan.entry}: ${row.patterns.join(', ')}; target ${plan.targetPrice}, stop ${plan.stopPrice}, R ${plan.rr}`);
      freeCash -= size.value;
      entered.push(symbol);
    }
    return { ran: true, entered };
  }

  async function cryptoScalpWideMonitor() {
    const open = await store.openTrades(MARKET_WIDE);
    if (!open.length) { await resolveShadows('scalp_wide', (symbol) => crypto.candles(symbol), 300000); return { checked: 0, closed: 0 }; }
    const cfg = await loadScalpWideConfig(store);
    let closed = 0;
    for (const t of open) {
      let candles;
      const limit = recoveryLimit({ oldestEntryMs: Date.parse(t.entry_time), nowMs: now(), intervalMs: 300000, defaultLimit: 330 });
      try { candles = await crypto.candles(t.symbol, limit); } catch (e) { log(`[scalp_wide] candles for ${t.symbol} failed: ${e.response?.status || e.message}`); continue; }
      const ev = evaluateExit({ trade: t, candles: E.closedOnly(candles, 300000, now()), nowMs: now(), cfg });
      if (!ev.exit) { if (ev.favPct > (t.max_fav_pct || 0) || ev.advPct < (t.max_adv_pct || 0)) await store.noteTrade(t.id, { max_fav_pct: ev.favPct, max_adv_pct: ev.advPct }); continue; }
      const fx = await crypto.usdtInr(cfg.usdt_inr_fallback);
      const s = settle({ trade: t, exitPrice: ev.price, cfg, fxRate: fx.rate });
      await store.updateTrade(t.id, {
        status: 'closed', exit_price: ev.price, exit_underlying: ev.price, exit_time: new Date(ev.timeMs).toISOString(), exit_reason: ev.reason,
        ...s, fx_rate: fx.rate, fx_source: fx.source, max_fav_pct: ev.favPct, max_adv_pct: ev.advPct, be_moved: ev.beMoved,
      });
      log(`[scalp_wide] PAPER exit ${t.symbol}: ${ev.reason}, gross ${s.gross_pnl_usdt} net ${s.net_pnl_usdt} USDT (Rs ${s.pnl_inr})`);
      closed += 1;
    }
    await resolveShadows('scalp_wide', (symbol) => crypto.candles(symbol), 300000);
    return { checked: open.length, closed };
  }

  // NSE scalp needs 1-minute NSE candles. The bot has none (Dhan is wired for 5-minute candles; the free Yahoo feed is delayed), so it does not run and says why.
  async function nseScalpScan() {
    const reason = 'NSE scalp is off: no 1-minute NSE candle source (Dhan is wired for 5-minute candles only and the free Yahoo feed is delayed)';
    const day = istParts(now()).date;
    if (!nseNoted.has(day)) { nseNoted.add(day); log(`[scalp] ${reason}`); }
    return { ran: false, reason };
  }

  // CC3 urgent fix item 2: one-time backfill at startup - resolves every OLD open shadow from candle history (a much bigger
  // window than the regular per-tick fetch, since a shadow stuck from before this fix could be hours old). Idempotent: resolving
  // an already-resolved shadow never happens (resolveShadows only reads status='open'); running this twice is always safe.
  async function backfillShadows() {
    const tight = await resolveShadows('scalp', (symbol) => source1m.candles1m(symbol, 1440), 60000); // 1440 x 1m = 24h back
    const wide = await resolveShadows('scalp_wide', (symbol) => crypto.candles(symbol), 300000); // crypto.candles() default (330 x 5m = ~27h) already covers this
    log(`[scalp] shadow backfill: tight ${tight.resolved}/${tight.checked}, wide ${wide.resolved}/${wide.checked}`);
    return { tight, wide };
  }

  return { cryptoScalpScan, cryptoScalpMonitor, cryptoScalpWideScan, cryptoScalpWideMonitor, nseScalpScan, backfillShadows };
}

module.exports = { createScalpBot, MARKET, MARKET_WIDE, basisText, basisTextWide };
