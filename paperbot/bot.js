'use strict';
// Paper bot orchestration: scan for entries, watch open trades, close them.
// PAPER ONLY. It writes rows to its own tables and never talks to a broker's
// order API. Every dependency is injected, so the replay test can drive it
// with recorded candles and a fake clock.
const P = require('./patterns');
const E = require('./engine');
const R = require('./rfactor');
const L = require('./cryptoLevels');
const { loadConfig } = require('./config');
const { newsCheck, FIVE_MIN } = require('./sources');
const { istParts, toMinutes, istDayStart, nseSession, nseJobWindow } = require('./time');
const { createJudge, loadJudgeConfig, tradeFields } = require('../src/paper/decision/judge');
const { judge2, tradeFields2 } = require('../src/paper/decision/judge2');
const { createShadowJudge } = require('../src/paper/decision/judgeSmcShadow');
const { classifyEmaCross } = require('../src/paper/lib/emaCross');
const { tagSmc } = require('../src/paper/lib/smc');
const Lib = require('../src/paper/lib/exitSim');
const { recoveryLimit } = require('../src/paper/lib/recoveryWindow');

// judgeOn: the judge (src/paper/decision/judge.js, docs/JUDGE.md) decides every NSE entry; index.js turns it on unless PAPER_JUDGE_ON=false.
// judgeHelpers: test seam for { stockSectorView, newsScore, eventBlock }; by default the real modules are used when they exist.
// smcShadowOn: Task Group B (docs/decisions/GROUP-A-MONDAY-READINESS.md item 3), SHADOW MODE ONLY -
// default OFF (index.js turns it on only when JUDGE_SMC_LIVE=true). With it off, nothing below runs:
// the real Judge and every real take/skip decision are exactly as before, flag or no flag. With it on,
// for every candidate that reaches the Judge (both markets) it ALSO computes the real decision
// (today's unchanged weights) and a shadow decision (SMC/ICT tags scored as an added helper,
// src/paper/decision/judgeSmcShadow.js) and logs both to paper_judge_shadows - never read by any
// entry/exit decision.
function createBot({ store, nse, crypto, now = Date.now, log = console.log, onConfig = () => {}, judgeOn = false, judgeHelpers = {}, smcShadowOn = false }) {
  const skipSeen = new Set();
  const candleCache = new Map(); // symbol -> { candles, source, at }

  // Shadow logging only (Task Group B). Computes BOTH the real Judge decision (judge.js, completely
  // unchanged) and a shadow decision (judgeSmcShadow.js) for the SAME candidate, and stores both in
  // paper_judge_shadows for later comparison. Never read by, and never allowed to affect, a real
  // take/skip decision. A failure here is logged and swallowed - it must never stop the real scan.
  async function logSmcShadow(market, symbol, candidate) {
    try {
      const config = await loadJudgeConfig(store);
      const real = createJudge({ config, ...judgeHelpers });
      const shadow = createShadowJudge({ config, ...judgeHelpers });
      const [rd, sd] = await Promise.all([real(candidate), shadow(candidate)]);
      await store.insertJudgeShadow({
        market, symbol, judge_date: istParts(now()).date, direction: candidate.direction,
        real_score: rd.score, real_take: rd.take, real_contributions: rd.contributions, real_basis: rd.basis,
        shadow_score: sd.score, shadow_take: sd.take, shadow_contributions: sd.contributions, shadow_basis: sd.basis,
        smc_tags: candidate.smcTags || null,
      });
    } catch (e) {
      log(`[paperbot] SMC judge shadow logging failed (ignored, never blocks the real scan): ${e.message}`);
    }
  }

  // Candles of one stock, read again only when the clock has moved into a new
  // `bucketMs` window since the last read (15 min for ranking, 5 min for patterns).
  async function candlesFor(symbol, bucketMs) {
    const hit = candleCache.get(symbol);
    if (hit && Math.floor(hit.at / bucketMs) === Math.floor(now() / bucketMs)) return hit;
    const entry = { ...(await nse.candles(symbol)), at: now() };
    candleCache.set(symbol, entry);
    return entry;
  }

  // How old the latest closed candle may be: 2 candles, plus the allowed feed
  // delay when the candles come from the delayed free Yahoo feed.
  const isDelayed = (dataSource) => dataSource === 'yahoo_delayed';
  const maxAgeMs = (dataSource, n) => 2 * FIVE_MIN + (isDelayed(dataSource) ? (n.yahoo_max_delay_sec || 0) * 1000 : 0);
  // A delayed feed's newest candle is still forming at the feed's own time, even if the wall clock is past its end.
  // So "closed" is judged at the time of the last trade the feed has seen (asOfMs), never later than now.
  const cutoffOf = (feed, at = now()) => (feed && Number.isFinite(feed.asOfMs) ? Math.min(at, feed.asOfMs) : at);
  // Feed delay stored on trade / skip rows: seconds since the latest closed candle ended.
  const delaySecOf = (last) => (last ? Math.round((now() - (last.t + FIVE_MIN)) / 1000) : null);

  // Real R factor for every liquid stock with valid candles, best first.
  // Entry = live price; ATR and swing levels come from 15-min candles.
  async function rankNse(quotes, n, cfg) {
    const legacyOrder = R.legacyOrderOf(quotes);
    const rows = [];
    let illiquid = 0;
    let noData = 0;
    for (const q of quotes) {
      if (!q || !(q.price > 0) || !Number.isFinite(q.pct)) continue;
      if (!((q.volume || 0) * q.price >= n.min_turnover_inr)) { illiquid += 1; continue; }
      const got = await candlesFor(q.symbol, 3 * FIVE_MIN);
      const c5 = E.closedOnly(got.candles, FIVE_MIN, cutoffOf(got, got.at));
      const last = c5[c5.length - 1];
      const r = c5.length >= n.min_candles && got.at - (last.t + FIVE_MIN) <= maxAgeMs(got.dataSource, n)
        ? R.rFactor({ entry: q.price, c15: E.aggregate(c5), prevDay: R.prevDayLevels(c5, istDayStart(now())), opt: cfg.rfactor })
        : null;
      if (!r) { noData += 1; continue; }
      rows.push({ symbol: q.symbol, price: q.price, pct: q.pct, r });
    }
    const top = R.rankByR(rows, n.top_n, legacyOrder);
    log(`[paperbot] NSE rank: ${rows.length} ranked, ${illiquid} below the liquidity floor, ${noData} without valid candles; top: ${top.map((t) => `${t.symbol} R ${t.rFactor}`).join(', ') || 'none'}`);
    return top;
  }

  // One skip row per (day, symbol, reason, trigger candle), not one per scan.
  async function skip(market, symbol, reason, extra = {}) {
    const date = istParts(now()).date;
    const key = `${date}|${market}|${symbol}|${reason}|${extra.trigger_t || ''}`;
    if (skipSeen.has(key)) return;
    if (skipSeen.size > 5000) skipSeen.clear();
    skipSeen.add(key);
    log(`[paperbot] skip ${market} ${symbol}: ${reason}`);
    await store.insertSkip({ market, symbol, skip_date: date, reason, r_factor: extra.r_factor ?? null, patterns: extra.patterns || null, trend_state: extra.trend_state || null,
      data_source: extra.data_source ?? null, data_delay_sec: extra.data_delay_sec ?? null, ema_cross: extra.ema_cross ?? null, smc_tags: extra.smc_tags || null,
      judge2_score: extra.judge2_score ?? null, judge2_take: extra.judge2_take ?? null, judge2_contributions: extra.judge2_contributions || null, judge2_basis: extra.judge2_basis ?? null });
  }

  // Shared part of both scans: closed candles -> context -> patterns -> entry decision.
  // `feed` = { dataSource, c15 }: where the candles came from and, when the feed has them, native 15-minute candles.
  async function analyse(market, symbol, raw, cfg, score, feed = {}) {
    const c5 = E.closedOnly(raw, FIVE_MIN, cutoffOf(feed));
    const last = c5[c5.length - 1];
    const src = { data_source: feed.dataSource ?? null, data_delay_sec: delaySecOf(last) };
    if (c5.length < cfg.min_candles) { await skip(market, symbol, `not enough 5-min candles yet (need ${cfg.min_candles})`, { r_factor: score, ...src }); return null; }
    if (now() - (last.t + FIVE_MIN) > maxAgeMs(feed.dataSource, cfg)) { await skip(market, symbol, 'no fresh candle (market closed or data feed stale)', { r_factor: score, ...src }); return null; }
    const c15 = feed.c15 ? E.closedOnly(feed.c15, 3 * FIVE_MIN, cutoffOf(feed)) : null;
    const ctx = E.buildContext(c5, istDayStart(now()), c15);
    // NSE gets the owner's stricter, two-candle-confirmed exhaustion reversal (patterns.js
    // exhaustionReversalConfirmed, docs/PAPER-BOT.md); crypto is unchanged (the single-candle rule
    // every crypto bot - scalp, scalp_wide, exhaustion_only - already documents and relies on).
    const patterns = P.detectPatterns(c5, ctx, cfg.patternOpt, market === 'nse' ? 'nse' : 'default');
    if (!patterns.length) return null; // no setup, nothing to log
    const names = patterns.map((p) => p.name);
    const decision = E.decideEntry(patterns, ctx);
    // EMA9/21 (5m) and EMA20/50 (15m/1h): a fresh cross with the trade is a strong confirmation, a
    // cross against is a warning (docs/BOT-INTERFACE.md item 5) - never a hard block either way.
    const tentativeDir = decision.direction || (patterns[0] && patterns[0].direction) || null;
    const c15ForCross = c15 && c15.length ? c15 : E.aggregate(c5);
    const c1hForCross = E.aggregate(c5, FIVE_MIN, 12 * FIVE_MIN);
    const emaCross = tentativeDir ? classifyEmaCross({ direction: tentativeDir, c5, c15: c15ForCross, c1h: c1hForCross }) : 'unknown';
    // Full SMC/ICT tag list (src/paper/lib/smc, docs/decisions/CC2.md round 2 item 2): BOS/CHoCH,
    // liquidity pools/sweeps, order blocks, FVG retests, premium/discount, displacement, session -
    // stored on EVERY trade and skip, informational only (nothing here feeds an entry/exit decision).
    const smcTags = [...new Set([...patterns.filter((p) => p.kind === 'smc').map((p) => p.name), ...tagSmc({ c5, nowMs: now(), market })])];
    // Judge v2 (CC2 round 2 item 3, src/paper/decision/judge2.js): PARALLEL scorer, stored on every
    // trade and skip in both markets, NEVER used for a live decision. For crypto, the real reward/risk
    // (plan.rr) is only known later, after planTrade() runs in cryptoScan - r_factor is left null
    // (excluded, rescaled) here rather than passing off the momentum score as a risk-reward number.
    const judge2Candidate = {
      market, direction: tentativeDir, rFactor: market === 'crypto' ? null : score, patterns,
      smcTags, emaCross, time: now(),
    };
    const judge2Decision = tentativeDir ? await judge2(judge2Candidate) : null;
    const judge2Fields = judge2Decision ? tradeFields2(judge2Decision) : { judge2_score: null, judge2_take: null, judge2_contributions: null, judge2_basis: null };
    const extra = { r_factor: score, patterns: names, trend_state: ctx, trigger_t: last.t, ema_cross: emaCross, smc_tags: smcTags, ...judge2Fields, ...src };
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
      smc_tags: a.extra.smc_tags || decision.patterns.filter((p) => p.kind === 'smc').map((p) => p.name),
      news_filter: news, entry_time: new Date(now()).toISOString(), max_fav_pct: 0, max_adv_pct: 0,
      ema_cross: a.extra.ema_cross ?? null,
      judge2_score: a.extra.judge2_score ?? null, judge2_take: a.extra.judge2_take ?? null,
      judge2_contributions: a.extra.judge2_contributions || null, judge2_basis: a.extra.judge2_basis ?? null,
    };
  }

  // ---------------- NSE ----------------
  async function nseScan() {
    // Root-cause fix: skip BEFORE the database read on a weekend/overnight tick (the buffered job
    // window, wider than the real session) - the Neon compute the old code spent on loadConfig() just
    // to find out the market was shut, every 5 minutes, all night and all weekend.
    const jobWindow = nseJobWindow(now());
    if (!jobWindow.open) return { ran: false, reason: jobWindow.reason };
    const cfg = await loadConfig(store);
    onConfig(cfg);
    const n = { ...cfg.nse, patternOpt: cfg.patterns };
    const session = nseSession(now(), n.holidays);
    if (!session.open) return { ran: false, reason: session.reason };
    const p = istParts(now());
    if (p.minutes >= toMinutes(n.no_new_entry_after_ist)) return { ran: false, reason: 'too late for new entries' };
    if (typeof nse.prepare === 'function') await nse.prepare(); // Dhan quotes gone: refresh the free Yahoo fallback (never more than once per 5 min per stock)
    const quotes = nse.ranking();
    if (!quotes) { log('[paperbot] NSE scan: no fresh live quotes, nothing done'); return { ran: false, reason: 'no live quotes' }; }
    const top = await rankNse(quotes, n, cfg);
    const today = await store.tradesForDay('nse', p.date);
    const open = await store.openTrades('nse');
    for (const t of open) await persistExcursion(t, t.max_fav_pct || 0, t.max_adv_pct || 0); // every scan: best / worst % so far goes to the database
    let taken = today.length;
    let freeCash = n.capital_inr - open.reduce((s, t) => s + t.entry_price * t.qty, 0);
    const entered = [];

    for (const s of top) {
      if (open.some((t) => t.symbol === s.symbol) || entered.includes(s.symbol)) continue; // 1 open trade per stock
      const { candles, source, dataSource, quoteLagSec, exchangeDelayMin, asOfMs } = await candlesFor(s.symbol, FIVE_MIN);
      const c15 = isDelayed(dataSource) && typeof nse.candles15 === 'function' ? await nse.candles15(s.symbol) : null;
      const a = await analyse('nse', s.symbol, candles, n, s.rFactor, { dataSource, c15, asOfMs });
      if (!a) continue;
      if (today.some((t) => t.symbol === s.symbol && t.trigger_t === a.last.t)) continue; // this candle was already traded
      const news = newsCheck(s.symbol, await nse.news(), now());
      if (news.status === 'blocked') { await skip('nse', s.symbol, `news filter: ${news.reason}`, a.extra); continue; }
      if (taken >= n.max_trades_per_day) { await skip('nse', s.symbol, `max ${n.max_trades_per_day} trades for the day already taken`, a.extra); continue; }

      const dir = a.decision.direction;
      let jd = null;
      let niftyTrend; // no Nifty candle source yet: that helper then earns half its points
      if (judgeOn || smcShadowOn) niftyTrend = typeof nse.niftyTrend === 'function' ? await nse.niftyTrend() : undefined;
      const judgeCandidate = { symbol: s.symbol, market: 'nse', direction: dir === 'up' ? 'long' : 'short', rFactor: dir === 'up' ? s.r.long.r : s.r.short.r, patterns: a.decision.patterns, niftyTrend, time: now() };
      // Shadow mode only (Task Group B, JUDGE_SMC_LIVE): runs independently of judgeOn, for every
      // candidate that reaches this point, so a rejected-by-judgeOn candidate is still logged.
      if (smcShadowOn) await logSmcShadow('nse', s.symbol, { ...judgeCandidate, smcTags: a.extra.smc_tags, rawDir: dir });
      if (judgeOn) { // ONE decision from every helper; a hard block or a score under the threshold means no trade
        const judge = createJudge({ config: await loadJudgeConfig(store), ...judgeHelpers });
        jd = await judge(judgeCandidate);
        if (!jd.take) { await skip('nse', s.symbol, `judge ${jd.score}/100: ${jd.basis}`, a.extra); continue; }
      }
      const lot = nse.lotSize(s.symbol);
      if (!lot) { await skip('nse', s.symbol, 'lot size not known for this stock', a.extra); continue; }
      // Group 2 (2026-11): a real Dhan option price is REQUIRED to take an NSE trade - never a
      // simulated/Yahoo-derived premium. If the option chain has no quote right now (API error, no
      // quote for this strike, stale/zero price - nse.optionQuote already returns null for all of
      // those, never a guessed number), the trade is skipped, not taken on a made-up premium.
      const quote = await nse.optionQuote(s.symbol, dir);
      if (!quote) { await skip('nse', s.symbol, 'no real option price', a.extra); continue; }
      const spot = quote.spot;
      const premium = quote.ltp;
      const size = E.sizeNse({ capital: n.capital_inr, riskPct: n.risk_pct, stopPct: n.stop_pct, freeCash, premium, lot });
      if (!size) { await skip('nse', s.symbol, `one lot (${lot} x Rs ${premium}) is bigger than the 2% risk size or the free cash`, a.extra); continue; }

      const type = dir === 'up' ? 'CE' : 'PE';
      // Observed data delay: how long ago the latest closed candle ended when the trade was decided
      // (at most 2 candles on a live feed; up to 2 candles + nse.yahoo_max_delay_sec on the delayed Yahoo feed).
      const delaySec = delaySecOf(a.last);
      const rDir = dir === 'up' ? s.r.long.r : s.r.short.r; // R of the direction actually traded
      const row = {
        ...tradeRow('nse', s.symbol, rDir, 'r_factor_v2 (target distance / stop distance, 15-min ATR and swing levels)', a, news.reason),
        legacy_rf: s.legacyRf,
        r_detail: { ...s.r, traded: { direction: dir, r: rDir }, rRank: s.rRank, legacyRank: s.legacyRank, inLegacyTop: s.legacyRank != null && s.legacyRank <= n.top_n },
        direction: dir === 'up' ? 'CALL' : 'PUT',
        instrument: `${s.symbol} ${quote.expiry} ${quote.strike} ${type}`,
        simulated_option: false,
        price_source: 'dhan_option_chain_ltp',
        candle_source: source, data_source: dataSource || null, data_delay_sec: delaySec, qty: size.qty, entry_price: premium, entry_underlying: spot,
        // exit levels on the OPTION price, fixed at entry so the report shows what the bot was aiming for
        sl_price: P.round(premium * (1 - n.stop_pct / 100), 2), target_price: P.round(premium * (1 + n.target_pct / 100), 2),
        basis: E.basisSentence({ market: 'nse', symbol: s.symbol, score: rDir, direction: dir, patterns: a.decision.patterns, ctx: a.ctx, news: news.reason, simulated: false })
          + (isDelayed(dataSource) ? ` Data: free Yahoo feed, about ${Math.round(delaySec / 60)} min behind the market.` : ''),
        ...(jd ? tradeFields(jd) : {}),
      };
      await store.insertTrade(row);
      log(`[paperbot] PAPER entry nse ${row.instrument} x${size.qty} @ ${premium}: ${row.patterns.join(', ')} · data_source ${row.data_source || 'unknown'}, latest candle closed ${delaySec} s ago${quoteLagSec != null ? `, quote lag ${quoteLagSec} s` : ''}${exchangeDelayMin != null ? `, delay declared by the feed ${exchangeDelayMin} min` : ''}`);
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

  // Best / worst % of an open trade, written to the database at every scan (only when it changed).
  const persisted = new Map(); // trade id -> "fav|adv" last written
  async function persistExcursion(t, fav, adv) {
    const f = P.round(Math.max(t.max_fav_pct || 0, fav), 2);
    const a = P.round(Math.min(t.max_adv_pct || 0, adv), 2);
    const key = `${f}|${a}`;
    if (persisted.get(t.id) === key) return; // unchanged since the last write
    persisted.set(t.id, key);
    await store.updateTrade(t.id, { max_fav_pct: f, max_adv_pct: a });
  }

  async function track(t, pct) {
    if (pct > (t.max_fav_pct || 0) || pct < (t.max_adv_pct || 0)) {
      // best / worst % so far: kept in memory, written to the database only when the trade closes
      await store.noteTrade(t.id, { max_fav_pct: P.round(Math.max(t.max_fav_pct || 0, pct), 2), max_adv_pct: P.round(Math.min(t.max_adv_pct || 0, pct), 2) });
    }
  }

  async function nseMonitor() {
    // Same root-cause fix as nseScan: no database read at all outside the buffered job window.
    const jobWindow = nseJobWindow(now());
    if (!jobWindow.open) return { checked: 0, ran: false, reason: jobWindow.reason };
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
      if (typeof nse.refreshSpot === 'function') await nse.refreshSpot(t.symbol);
      let spot = nse.spot(t.symbol, { maxDelaySec: n.yahoo_max_delay_sec || 0 });
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
    // Every scan: best / worst % of each open trade from the candles since its entry (highs and lows, not only closes).
    for (const t of open) {
      const s = scored.find((x) => x.symbol === t.symbol);
      const since = s ? E.closedOnly(s.raw, FIVE_MIN, now()).filter((k) => k.t + FIVE_MIN > Date.parse(t.entry_time)) : [];
      if (!since.length) continue;
      const short = t.direction === 'SHORT';
      const hi = E.changePct(t.entry_price, Math.max(...since.map((k) => k.h)), short);
      const lo = E.changePct(t.entry_price, Math.min(...since.map((k) => k.l)), short);
      await persistExcursion(t, Math.max(hi, lo), Math.min(hi, lo));
    }
    scored.sort((a, b) => (b.m?.score || 0) - (a.m?.score || 0));
    const entered = [];
    for (const s of scored) {
      if (open.some((t) => t.symbol === s.symbol)) continue; // 1 open trade per coin (no daily cap, no cooldown)
      const score = s.m ? s.m.score : null;
      const a = await analyse('crypto', s.symbol, s.raw, c, score, { dataSource: 'binance_public' });
      if (!a) continue;
      if (today.some((t) => t.symbol === s.symbol && t.trigger_t === a.last.t)) continue;
      if (score == null || score < c.min_momentum_score) { await skip('crypto', s.symbol, `momentum score ${score} is below ${c.min_momentum_score}`, a.extra); continue; }
      const dir = a.decision.direction;
      const price = a.ctx.price;
      // Shadow mode only (Task Group B, JUDGE_SMC_LIVE): the live Judge is NSE-only today, but this
      // task also wants crypto's would-be score logged for comparison - never read by any real crypto
      // entry decision below (that stays on momentum score / planTrade, completely unchanged).
      if (smcShadowOn) {
        await logSmcShadow('crypto', s.symbol, {
          symbol: s.symbol, market: 'crypto', direction: dir === 'up' ? 'long' : 'short', rFactor: null,
          patterns: a.decision.patterns, smcTags: a.extra.smc_tags, rawDir: dir, time: now(),
        });
      }
      // Target and stop from price levels; a trade needs reward / risk of at least levels.minRr.
      let c1h = [];
      try { if (typeof crypto.hourly === 'function') c1h = E.closedOnly(await crypto.hourly(s.symbol), 12 * FIVE_MIN, now()); } catch (e) { log(`[paperbot] 1-hour candles for ${s.symbol} failed (${e.response?.status || e.message}); 1-hour levels come from the 5-min candles only`); }
      if (!c1h.length) c1h = E.aggregate(a.c5, FIVE_MIN, 12 * FIVE_MIN);
      const planned = L.planTrade({ entry: price, direction: dir, patterns: a.decision.patterns, c5: a.c5, c15: E.aggregate(a.c5), c1h, nowMs: now(), opt: c.levels });
      if (!planned.ok) {
        await skip('crypto', s.symbol, planned.reason, a.extra);
        // Shadow tracking (CC2 round 2 item 4): the setup had a real plan (entry/target/stop) but
        // failed the reward/risk floor - followed on paper to see if it would have worked anyway,
        // in its own table, never counted as a trade.
        if (planned.plan) {
          await store.insertShadow({
            market: 'crypto', symbol: s.symbol, shadow_date: istParts(now()).date, direction: dir, reason: planned.reason,
            entry_price: price, target_price: planned.plan.target, stop_price: planned.plan.stop,
            entry_time: new Date(now()).toISOString(), basis: `Rejected: ${planned.reason}`,
          });
        }
        continue;
      }
      const plan = planned.plan;
      const size = E.sizeCrypto({ capital: c.capital_usdt, riskPct: c.risk_pct, stopPct: plan.riskPct, freeCash, price, coins: c.symbols.length });
      if (!size) { await skip('crypto', s.symbol, 'no free virtual USDT balance', a.extra); continue; }
      const legacy = L.legacyLevels({ entry: price, short: dir !== 'up', targetPct: c.target_pct, stopPct: c.stop_pct });
      const targetType = `${plan.targetType} at ${plan.targetLevel}`;
      const stopType = `${plan.stopType} (${plan.stopBase} ${dir === 'up' ? '-' : '+'} ${plan.atr15})`;
      const row = {
        ...tradeRow('crypto', s.symbol, score, `momentum_score_v1 (vol x${s.m.volumeSpike}, range x${s.m.rangeExpansion}, trend ${s.m.trendStrength})`, a, 'not applied to crypto'),
        direction: dir === 'up' ? 'LONG' : 'SHORT', instrument: `${s.symbol} spot (paper)`, simulated_option: false,
        price_source: 'binance_public_5m_close', candle_source: 'binance_public_klines_5m', data_source: 'binance_public', data_delay_sec: delaySecOf(a.last),
        qty: size.qty, entry_price: price, entry_underlying: price,
        sl_price: plan.stop, target_price: plan.target, stop_active: plan.stop, target_type: targetType, stop_type: stopType, rr: plan.rr,
        legacy_target: legacy.target, legacy_stop: legacy.stop, legacy_result: null, r_detail: { plan },
        basis: `${E.basisSentence({ market: 'crypto', symbol: s.symbol, score, direction: dir, patterns: a.decision.patterns, ctx: a.ctx, news: 'not applied to crypto', simulated: false })}`
          + ` Target ${plan.target}: ${c.levels.targetBufferPct}% before the ${targetType}. Stop ${plan.stop}: ${stopType}. Reward/risk ${plan.rr}. Stop moves to the entry after ${Math.round(c.breakeven_at * 100)}% of the way to the target.`,
      };
      const id = await store.insertTrade(row);
      if (legacyWatch) legacyWatch.set(id, { ...row, id });
      log(`[paperbot] PAPER entry crypto ${s.symbol} ${row.direction} @ ${price}: ${row.patterns.join(', ')} · target ${plan.target} (${targetType}), stop ${plan.stop}, reward/risk ${plan.rr}`);
      freeCash -= size.value;
      entered.push(s.symbol);
    }
    return { ran: true, entered };
  }

  // Trades whose old fixed-rule outcome (legacy_result) is not decided yet, open or already closed.
  // Read from the store once, then kept in memory.
  let legacyWatch = null;
  async function legacyPending() {
    if (!legacyWatch) {
      legacyWatch = new Map();
      for (const t of await store.legacyPending('crypto')) legacyWatch.set(t.id, t);
    }
    return legacyWatch;
  }

  async function cryptoMonitor() {
    const open = await store.openTrades('crypto');
    const watch = await legacyPending();
    if (!open.length && !watch.size) return { checked: 0 };
    const c = (await loadConfig(store)).crypto;
    const prices = new Map(); // one price read per coin per check (still used for tracking + the legacy fixed-rule path)
    for (const symbol of new Set([...open, ...watch.values()].map((t) => t.symbol))) {
      try { prices.set(symbol, await crypto.price(symbol)); } catch (e) { log(`[paperbot] crypto price for ${symbol} failed: ${e.response?.status || e.message}`); }
    }
    let closed = 0;
    for (const t of open) {
      const price = prices.get(t.symbol);
      const short = t.direction === 'SHORT';
      let reason = null;
      let exitPrice = null;
      if (t.target_price == null || t.stop_active == null) {
        // a trade opened before level-based exits existed: it finishes on the fixed rule it was opened with
        if (!price) continue;
        const r = E.evaluateExit({ entry: t.entry_price, current: price, targetPct: c.target_pct, stopPct: c.stop_pct, short });
        if (r.exit) { reason = r.reason; exitPrice = price; } else { await track(t, E.changePct(t.entry_price, price, short)); continue; }
      } else {
        // Candle-accurate exit (CC2 round 2 item 1, src/paper/lib/exitSim.js): checks the stop and the
        // target against every closed candle's high/low since the entry, not only this minute's tick -
        // a spike between two checks is no longer missed. Walked from the entry every time (idempotent,
        // deterministic) using the ORIGINAL stop (sl_price), not whatever stop_active currently holds.
        let candles = [];
        try {
          const limit = recoveryLimit({ oldestEntryMs: Date.parse(t.entry_time), nowMs: now(), intervalMs: FIVE_MIN, defaultLimit: 330 });
          const raw = await crypto.candles(t.symbol, limit);
          candles = E.closedOnly(raw, FIVE_MIN, now()).filter((k) => k.t + FIVE_MIN > Date.parse(t.entry_time));
        } catch (e) { log(`[paperbot] crypto candles for ${t.symbol} (exit check) failed: ${e.response?.status || e.message}`); }
        if (!candles.length) { if (price) await track(t, E.changePct(t.entry_price, price, short)); continue; }
        const sim = Lib.simulateExit({ entry: t.entry_price, target: t.target_price, stop: t.sl_price, short, breakevenAt: c.breakeven_at, candles });
        if (sim.exit) { reason = sim.reason; exitPrice = sim.price; } else {
          if (sim.action === 'breakeven' && t.stop_active !== sim.stopActive) {
            await store.updateTrade(t.id, { stop_active: sim.stopActive, breakeven_time: t.breakeven_time || new Date(now()).toISOString() });
            log(`[paperbot] PAPER crypto ${t.symbol}: ${Math.round(c.breakeven_at * 100)}% of the way to the target covered (by a candle high/low), stop moved to the entry ${sim.stopActive}`);
          }
          if (price) await track(t, E.changePct(t.entry_price, price, short));
          continue;
        }
      }
      const fx = await crypto.usdtInr(c.usdt_inr_fallback);
      const pct = E.changePct(t.entry_price, exitPrice, short);
      // Group 3a (2026-11): same per-side fee + slippage model scalp_wide already uses, via the ONE
      // settle() intraday-MIRROR/intraday-REVERSE already call (paperbot/engine.js) - no longer a
      // fee-less inline calc kept only here. The exit trigger (reason/exitPrice above) is unchanged.
      const s = E.settle({ trade: t, exitPrice, cfg: c, fxRate: fx.rate });
      await closeTrade(t, exitPrice, exitPrice, reason, s.pnl_inr, pct, {
        fx_rate: fx.rate, fx_source: fx.source,
        gross_pnl_usdt: s.gross_pnl_usdt, cost_usdt: s.cost_usdt, net_pnl_usdt: s.net_pnl_usdt, gross_pnl_inr: s.gross_pnl_inr,
      });
      closed += 1;
    }
    // A/B only: what the old fixed +target% / -stop% rule would have done with the same entry. Never used for an exit.
    for (const t of [...watch.values()]) {
      const price = prices.get(t.symbol);
      let result = price ? L.legacyOutcome({ target: t.legacy_target, stop: t.legacy_stop, short: t.direction === 'SHORT', price }) : null;
      if (!result && now() - Date.parse(t.entry_time) > c.legacy_max_hours * 3600000) result = `undecided after ${c.legacy_max_hours} h`;
      if (!result) continue;
      await store.updateTrade(t.id, { legacy_result: result });
      watch.delete(t.id);
    }
    return { checked: open.length, closed };
  }

  // Shadow tracking (CC2 round 2 item 4): follows every open shadow row to its own would-be stop or
  // target, the SAME way cryptoMonitor's level-based exits work (src/paper/lib/exitSim.js), but it
  // is never a trade and never read by any entry/exit decision - its own table, its own loop.
  // breakevenAt: 1 means "the full distance to the target" - with no breakeven feature for shadows,
  // that threshold is reached only together with the target hit itself, so it never actually fires.
  async function shadowMonitor() {
    const open = await store.openShadows('crypto');
    if (!open.length) return { checked: 0, closed: 0 };
    let closed = 0;
    for (const s of open) {
      let candles = [];
      try {
        const raw = await crypto.candles(s.symbol);
        candles = E.closedOnly(raw, FIVE_MIN, now()).filter((k) => k.t + FIVE_MIN > Date.parse(s.entry_time));
      } catch (e) { log(`[paperbot] shadow candles for ${s.symbol} failed: ${e.response?.status || e.message}`); continue; }
      if (!candles.length) continue;
      const short = s.direction === 'down';
      const sim = Lib.simulateExit({ entry: s.entry_price, target: s.target_price, stop: s.stop_price, short, breakevenAt: 1, candles });
      if (sim.exit) {
        const pct = E.changePct(s.entry_price, sim.price, short);
        await store.updateShadow(s.id, { status: 'closed', outcome: sim.reason === 'target' ? 'target' : 'stop', result_pct: P.round(pct, 2), exit_time: new Date(now()).toISOString() });
        closed += 1;
      }
    }
    return { checked: open.length, closed };
  }

  return { nseScan, nseMonitor, cryptoScan, cryptoMonitor, shadowMonitor };
}

module.exports = { createBot };
