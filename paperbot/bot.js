'use strict';
// Paper bot orchestration: scan for entries, watch open trades, close them.
// PAPER ONLY. It writes rows to its own tables and never talks to a broker's
// order API. Every dependency is injected, so the replay test can drive it
// with recorded candles and a fake clock.
const P = require('./patterns');
const E = require('./engine');
const { loadConfig } = require('./config');
const { newsCheck, FIVE_MIN } = require('./sources');
const { istParts, toMinutes, istDayStart, nseSession } = require('./time');

function createBot({ store, nse, crypto, now = Date.now, log = console.log }) {
  const skipSeen = new Set();

  // One skip row per (day, symbol, reason, trigger candle), not one per scan.
  async function skip(market, symbol, reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `${date}|${market}|${symbol}|${reason}|${extra.trigger_t || ''}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[paperbot] skip ${market} ${symbol}: ${reason}`);
    await store.insertSkip({ market, symbol, skip_date: date, reason, r_factor: extra.r_factor ?? null, patterns: extra.patterns || null, trend_state: extra.trend_state || null });
  }

  // Shared part of both scans: closed candles -> context -> patterns -> entry decision.
  async function analyse(market, symbol, raw, cfg, score) {
    const c5 = E.closedOnly(raw, FIVE_MIN, now());
    const last = c5[c5.length - 1];
    if (c5.length < cfg.min_candles) { await skip(market, symbol, `not enough 5-min candles yet (need ${cfg.min_candles})`, { r_factor: score }); return null; }
    if (now() - (last.t + FIVE_MIN) > 2 * FIVE_MIN) { await skip(market, symbol, 'no fresh candle (market closed or data feed stale)', { r_factor: score }); return null; }
    const ctx = E.buildContext(c5, istDayStart(now()));
    const patterns = P.detectPatterns(c5, ctx, cfg.patternOpt);
    if (!patterns.length) return null; // no setup, nothing to log
    const names = patterns.map((p) => p.name);
    const decision = E.decideEntry(patterns, ctx);
    const extra = { r_factor: score, patterns: names, trend_state: ctx, trigger_t: last.t };
    if (!decision.enter) { await skip(market, symbol, decision.reason, extra); return null; }
    return { c5, last, ctx, decision, extra };
  }

  function tradeRow(market, symbol, score, scoreSource, a, news) {
    const { decision, ctx, last } = a;
    return {
      market, symbol, trade_date: istParts(now()).date, status: 'open', r_factor: score, score_source: scoreSource,
      patterns: decision.patterns.map((p) => p.name),
      trigger_candles: decision.patterns.map((p) => ({ pattern: p.name, direction: p.direction, note: p.note, candles: p.candles })),
      trigger_t: last.t, trend_state: ctx,
      smc_tags: decision.patterns.filter((p) => p.kind === 'smc').map((p) => p.name),
      news_filter: news, entry_time: new Date(now()).toISOString(), max_fav_pct: 0, max_adv_pct: 0,
    };
  }

  // ---------------- NSE ----------------
  async function nseScan() {
    const cfg = await loadConfig(store);
    const n = { ...cfg.nse, patternOpt: cfg.patterns };
    const session = nseSession(now(), n.holidays);
    if (!session.open) return { ran: false, reason: session.reason };
    const p = istParts(now());
    if (p.minutes >= toMinutes(n.no_new_entry_after_ist)) return { ran: false, reason: 'too late for new entries' };
    const quotes = nse.ranking();
    if (!quotes) { log('[paperbot] NSE scan: no fresh live quotes, nothing done'); return { ran: false, reason: 'no live quotes' }; }
    const top = E.rankRFactor(quotes, n.top_n);
    const today = await store.tradesForDay('nse', p.date);
    const open = await store.openTrades('nse');
    let taken = today.length;
    let freeCash = n.capital_inr - open.reduce((s, t) => s + t.entry_price * t.qty, 0);
    const entered = [];

    for (const s of top) {
      if (open.some((t) => t.symbol === s.symbol) || entered.includes(s.symbol)) continue; // 1 open trade per stock
      const { candles, source } = await nse.candles(s.symbol);
      const a = await analyse('nse', s.symbol, candles, n, s.rFactor);
      if (!a) continue;
      if (today.some((t) => t.symbol === s.symbol && t.trigger_t === a.last.t)) continue; // this candle was already traded
      const news = newsCheck(s.symbol, await nse.news(), now());
      if (news.status === 'blocked') { await skip('nse', s.symbol, `news filter: ${news.reason}`, a.extra); continue; }
      if (taken >= n.max_trades_per_day) { await skip('nse', s.symbol, `max ${n.max_trades_per_day} trades for the day already taken`, a.extra); continue; }

      const dir = a.decision.direction;
      const lot = nse.lotSize(s.symbol);
      if (!lot) { await skip('nse', s.symbol, 'lot size not known for this stock', a.extra); continue; }
      const quote = await nse.optionQuote(s.symbol, dir);
      const simulated = !quote;
      const spot = quote ? quote.spot : a.ctx.price;
      const premium = quote ? quote.ltp : P.round(spot * n.sim_premium_pct / 100, 2);
      const size = E.sizeNse({ capital: n.capital_inr, riskPct: n.risk_pct, stopPct: n.stop_pct, freeCash, premium, lot });
      if (!size) { await skip('nse', s.symbol, `one lot (${lot} x Rs ${premium}) is bigger than the 2% risk size or the free cash`, a.extra); continue; }

      const type = dir === 'up' ? 'CE' : 'PE';
      const row = {
        ...tradeRow('nse', s.symbol, s.rFactor, 'r_factor_proxy_v1 (|% change| / basket median)', a, news.reason),
        direction: dir === 'up' ? 'CALL' : 'PUT',
        instrument: quote ? `${s.symbol} ${quote.expiry} ${quote.strike} ${type}` : `${s.symbol} ATM ${type} (simulated)`,
        simulated_option: simulated,
        price_source: quote ? 'dhan_option_chain_ltp' : `simulated: premium ${n.sim_premium_pct}% of spot, delta ${n.sim_delta}`,
        candle_source: source, qty: size.qty, entry_price: premium, entry_underlying: spot,
        basis: E.basisSentence({ market: 'nse', symbol: s.symbol, score: s.rFactor, direction: dir, patterns: a.decision.patterns, ctx: a.ctx, news: news.reason, simulated }),
      };
      await store.insertTrade(row);
      log(`[paperbot] PAPER entry nse ${row.instrument} x${size.qty} @ ${premium}: ${row.patterns.join(', ')}`);
      taken += 1;
      freeCash -= size.value;
      entered.push(s.symbol);
    }
    return { ran: true, top: top.map((t) => t.symbol), entered };
  }

  async function closeTrade(t, price, underlying, reason, pnlInr, pct, extra = {}) {
    await store.updateTrade(t.id, {
      status: 'closed', exit_price: price, exit_time: new Date(now()).toISOString(), exit_underlying: underlying,
      exit_reason: reason, pnl_inr: P.round(pnlInr, 2),
      max_fav_pct: P.round(Math.max(t.max_fav_pct || 0, pct), 2), max_adv_pct: P.round(Math.min(t.max_adv_pct || 0, pct), 2), ...extra,
    });
    log(`[paperbot] PAPER exit ${t.market} ${t.symbol}: ${reason}, P&L Rs ${P.round(pnlInr, 2)}`);
  }

  async function track(t, pct) {
    if (pct > (t.max_fav_pct || 0) || pct < (t.max_adv_pct || 0)) {
      await store.updateTrade(t.id, { max_fav_pct: P.round(Math.max(t.max_fav_pct || 0, pct), 2), max_adv_pct: P.round(Math.min(t.max_adv_pct || 0, pct), 2) });
    }
  }

  async function nseMonitor() {
    const open = await store.openTrades('nse');
    if (!open.length) return { checked: 0 };
    const cfg = await loadConfig(store);
    const n = cfg.nse;
    const p = istParts(now());
    let closed = 0;
    for (const t of open) {
      const force = t.trade_date < p.date ? 'carried_over_exit' : p.minutes >= toMinutes(n.force_exit_ist) ? `time_exit_${n.force_exit_ist}` : null;
      const dir = t.direction === 'CALL' ? 'up' : 'down';
      let price = null;
      let spot = nse.spot(t.symbol);
      let extra = {};
      if (!t.simulated_option) {
        const [, expiry, strike] = t.instrument.split(' ');
        const q = await nse.optionQuote(t.symbol, dir, { expiry, strike: parseFloat(strike) });
        if (q) { price = q.ltp; spot = q.spot; }
        else if (force && spot) {
          // Real option price missing at the forced exit: fall back to the simulated move and say so.
          price = E.simOptionPrice({ entryPremium: t.entry_price, entrySpot: t.entry_underlying, spot, direction: dir, delta: n.sim_delta });
          extra = { simulated_option: true, price_source: `${t.price_source}; EXIT simulated (delta ${n.sim_delta}) because no option price was available` };
        }
      } else if (spot) {
        price = E.simOptionPrice({ entryPremium: t.entry_price, entrySpot: t.entry_underlying, spot, direction: dir, delta: n.sim_delta });
      }
      if (price == null) continue; // no real price right now: keep the trade open and try again
      const r = E.evaluateExit({ entry: t.entry_price, current: price, targetPct: n.target_pct, stopPct: n.stop_pct, forceReason: force });
      if (r.exit) { await closeTrade(t, price, spot, r.reason, (price - t.entry_price) * t.qty, r.pct, extra); closed += 1; } else await track(t, r.pct);
    }
    return { checked: open.length, closed };
  }

  // ---------------- CRYPTO ----------------
  async function cryptoScan() {
    const cfg = await loadConfig(store);
    const c = { ...cfg.crypto, patternOpt: cfg.patterns };
    const date = istParts(now()).date;
    const today = await store.tradesForDay('crypto', date);
    const open = await store.openTrades('crypto');
    let taken = today.length;
    let freeCash = c.capital_usdt - open.reduce((s, t) => s + t.entry_price * t.qty, 0);
    const scored = [];
    for (const symbol of c.symbols) {
      try {
        const raw = await crypto.candles(symbol);
        const closed = E.closedOnly(raw, FIVE_MIN, now());
        scored.push({ symbol, raw, m: E.momentumScore(closed) });
      } catch (e) {
        log(`[paperbot] crypto candles for ${symbol} failed: ${e.response?.status || e.message}`);
      }
    }
    scored.sort((a, b) => (b.m?.score || 0) - (a.m?.score || 0));
    const entered = [];
    for (const s of scored) {
      if (open.some((t) => t.symbol === s.symbol)) continue; // 1 open trade per coin
      const score = s.m ? s.m.score : null;
      const a = await analyse('crypto', s.symbol, s.raw, c, score);
      if (!a) continue;
      if (today.some((t) => t.symbol === s.symbol && t.trigger_t === a.last.t)) continue;
      if (score == null || score < c.min_momentum_score) { await skip('crypto', s.symbol, `momentum score ${score} is below ${c.min_momentum_score}`, a.extra); continue; }
      if (taken >= c.max_trades_per_day) { await skip('crypto', s.symbol, `max ${c.max_trades_per_day} trades for the day already taken`, a.extra); continue; }
      const dir = a.decision.direction;
      const price = a.ctx.price;
      const size = E.sizeCrypto({ capital: c.capital_usdt, riskPct: c.risk_pct, stopPct: c.stop_pct, freeCash, price, coins: c.symbols.length });
      if (!size) { await skip('crypto', s.symbol, 'no free virtual USDT balance', a.extra); continue; }
      const row = {
        ...tradeRow('crypto', s.symbol, score, `momentum_score_v1 (vol x${s.m.volumeSpike}, range x${s.m.rangeExpansion}, trend ${s.m.trendStrength})`, a, 'not applied to crypto'),
        direction: dir === 'up' ? 'LONG' : 'SHORT', instrument: `${s.symbol} spot (paper)`, simulated_option: false,
        price_source: 'binance_public_5m_close', candle_source: 'binance_public_klines_5m', qty: size.qty, entry_price: price, entry_underlying: price,
        basis: E.basisSentence({ market: 'crypto', symbol: s.symbol, score, direction: dir, patterns: a.decision.patterns, ctx: a.ctx, news: 'not applied to crypto', simulated: false }),
      };
      await store.insertTrade(row);
      log(`[paperbot] PAPER entry crypto ${s.symbol} ${row.direction} @ ${price}: ${row.patterns.join(', ')}`);
      taken += 1;
      freeCash -= size.value;
      entered.push(s.symbol);
    }
    return { ran: true, entered };
  }

  async function cryptoMonitor() {
    const open = await store.openTrades('crypto');
    if (!open.length) return { checked: 0 };
    const c = (await loadConfig(store)).crypto;
    let closed = 0;
    for (const t of open) {
      let price;
      try { price = await crypto.price(t.symbol); } catch (e) { log(`[paperbot] crypto price for ${t.symbol} failed: ${e.response?.status || e.message}`); }
      if (!price) continue;
      const short = t.direction === 'SHORT';
      const r = E.evaluateExit({ entry: t.entry_price, current: price, targetPct: c.target_pct, stopPct: c.stop_pct, short });
      if (!r.exit) { await track(t, r.pct); continue; }
      const fx = await crypto.usdtInr(c.usdt_inr_fallback);
      const pnlUsdt = (price - t.entry_price) * t.qty * (short ? -1 : 1);
      await closeTrade(t, price, price, r.reason, pnlUsdt * fx.rate, r.pct, { fx_rate: fx.rate, fx_source: fx.source });
      closed += 1;
    }
    return { checked: open.length, closed };
  }

  return { nseScan, nseMonitor, cryptoScan, cryptoMonitor };
}

module.exports = { createBot };
