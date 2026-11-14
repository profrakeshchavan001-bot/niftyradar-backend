'use strict';
// Orchestrates one replay run across every adapter this lane owns: scalp, scalp_wide, exhaustion_only and
// intraday_crypto (round 2, item 1). Each gets: base run, doubled-cost run, random-entry baseline,
// in-sample/out-of-sample split, and a look-ahead check. Filter study (item 3) stays scalp-only, where the
// config knobs and recorded SMC tags/EMA cross it studies actually live. PAPER ONLY.
const {
  replayScalp, replayRandomBaseline, replayScalpWide, replayRandomGeneric,
} = require('./simulator');
const { evaluateExit: scalpEvaluateExit, settle: scalpSettle } = require('../scalp/engine');
const { SCALP_WIDE_DEFAULTS } = require('../scalp/config');
const { replayExhaustionOnly, decide: decideEx, buildContext: ctxEx, evaluateExit: exitEx, settle: settleEx, EXHAUSTION_ONLY_DEFAULTS } = require('./adapters/exhaustionOnly');
const { replayIntradayCrypto, decide: decideIc, buildContext: ctxIc, evaluateExit: exitIcRaw, settle: settleIc, INTRADAY_CRYPTO_DEFAULTS } = require('./adapters/intradayCrypto');
const { buildReport, splitInOutSample } = require('./stats');
const { runFilterStudy } = require('./filters');
const { lookAheadCheck, lookAheadCheckWide, lookAheadCheckDecide } = require('./lookahead');
const { codeVersion } = require('./codeVersion');

const DAY = 86400000;
const FIVE_MIN = 5 * 60000;

async function loadSymbolCandles(store, symbol, { windowStartMs, now }) {
  const [c1, c5] = await Promise.all([
    store.getCandles(symbol, '1m', { fromT: windowStartMs, toT: now }),
    store.getCandles(symbol, '5m', { fromT: windowStartMs, toT: now }),
  ]);
  return { c1, c5 };
}

function windowSegment(t, windowStartMs, inSampleDays) {
  return t.entry_t < windowStartMs + inSampleDays * DAY ? 'in_sample' : 'out_sample';
}

function toTradeRow(strategy, t, variant) {
  return {
    strategy, variant, segment: t.segment, symbol: t.symbol, direction: t.direction, entry_t: t.entry_t,
    exit_t: t.exit_t, entry_price: t.entry_price, exit_price: t.exit_price, exit_reason: t.exit_reason,
    stop_pct: t.stop_pct, target_pct: t.target_pct, rr: t.rr, pnl_inr: t.pnl_inr, patterns: t.patterns,
  };
}

function pickCutoffs(len, minCandles) {
  const start = minCandles + 5;
  if (len <= start + 10) return len > start ? [start] : [];
  const out = [];
  for (let k = 1; k <= 5; k++) out.push(start + Math.floor((len - start) * k / 6));
  return out;
}

function hashSeed(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return h || 1;
}

function reportSegments(trades, windowStartMs, inSampleDays) {
  const { inSample, outSample } = splitInOutSample(trades, { windowStartMs, inSampleDays });
  return { full: buildReport(trades), inSample: buildReport(inSample), outSample: buildReport(outSample) };
}

// --- scalp (tight, 1m/5m): unchanged from round 1, still with the full filter study. ---
function runScalpSymbol({ symbol, c1, c5, cfg, fx, windowStartMs, inSampleDays }) {
  const base = replayScalp({ symbol, candles1m: c1, candles5m: c5, cfg, fxRate: fx });
  const doubled = replayScalp({ symbol, candles1m: c1, candles5m: c5, cfg: { ...cfg, fee_pct_per_side: cfg.fee_pct_per_side * 2, slippage_pct: cfg.slippage_pct * 2 }, fxRate: fx });
  const random = replayRandomBaseline({ symbol, candles1m: c1, realTrades: base, cfg, fxRate: fx, seed: hashSeed(symbol) });
  const filterStudy = runFilterStudy({ symbol, candles1m: c1, candles5m: c5, cfg, fxRate: fx, baseTrades: base });
  const cutoffs = pickCutoffs(c1.length, cfg.min_candles_1m);
  const lookAhead = cutoffs.map((cutoffBar1m) => ({ symbol, cutoffBar1m, ...lookAheadCheck({ candles1m: c1, candles5m: c5, cfg, cutoffBar1m }) }));
  return {
    base: reportSegments(base.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })), windowStartMs, inSampleDays),
    randomBaseline: reportSegments(random.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })), windowStartMs, inSampleDays),
    doubledCost: reportSegments(doubled.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })), windowStartMs, inSampleDays),
    filterStudy, lookAhead, candleCoverage: { c1: c1.length, c5: c5.length },
    trades: { base, random, doubled },
  };
}

// --- scalp_wide, exhaustion_only, intraday_crypto: single 5-minute stream, no filter study (round 2 item 1). ---
const SINGLE_STREAM = {
  scalp_wide: {
    defaultCfg: SCALP_WIDE_DEFAULTS,
    minCandles: (cfg) => cfg.min_candles_5m,
    replay: (c5, cfg, fx, symbol) => replayScalpWide({ symbol, candles5m: c5, cfg, fxRate: fx }),
    randomEvalFn: (c5, cfg) => (args) => scalpEvaluateExit({ ...args, nowMs: c5[c5.length - 1].t + FIVE_MIN, cfg }),
    settleFn: scalpSettle,
    lookAhead: (c5, cfg, cutoffBar5m) => lookAheadCheckWide({ candles5m: c5, cfg, cutoffBar5m }),
  },
  exhaustion_only: {
    defaultCfg: EXHAUSTION_ONLY_DEFAULTS,
    minCandles: (cfg) => Math.max(cfg.min_candles_5m, 8),
    replay: (c5, cfg, fx, symbol) => replayExhaustionOnly({ symbol, candles5m: c5, cfg, fxRate: fx }),
    randomEvalFn: () => exitEx,
    settleFn: settleEx,
    lookAhead: (c5, cfg, cutoffBar) => lookAheadCheckDecide({ candles: c5, intervalMs: FIVE_MIN, decide: decideEx, buildContext: ctxEx, cfg, minCandles: Math.max(cfg.min_candles_5m, 8), window: 330, cutoffBar }),
  },
  intraday_crypto: {
    defaultCfg: INTRADAY_CRYPTO_DEFAULTS,
    minCandles: (cfg) => Math.max(cfg.min_candles, 21),
    replay: (c5, cfg, fx, symbol) => replayIntradayCrypto({ symbol, candles5m: c5, cfg, fxRate: fx }),
    randomEvalFn: (c5, cfg) => (args) => exitIcRaw(args, cfg),
    settleFn: settleIc,
    lookAhead: (c5, cfg, cutoffBar) => lookAheadCheckDecide({ candles: c5, intervalMs: FIVE_MIN, decide: decideIc, buildContext: ctxIc, cfg, minCandles: Math.max(cfg.min_candles, 21), window: 330, cutoffBar }),
  },
};

function runSingleStreamSymbol({ name, def, symbol, c5, cfg, fx, windowStartMs, inSampleDays }) {
  const minCandles = def.minCandles(cfg);
  const base = def.replay(c5, cfg, fx, symbol);
  const doubled = def.replay(c5, { ...cfg, fee_pct_per_side: cfg.fee_pct_per_side * 2, slippage_pct: cfg.slippage_pct * 2 }, fx, symbol);
  const random = replayRandomGeneric({
    symbol, candles: c5, stepMs: FIVE_MIN, minCandles, realTrades: base,
    evaluateExitFn: def.randomEvalFn(c5, cfg), settleFn: def.settleFn, cfg, fxRate: fx, seed: hashSeed(symbol),
  });
  const cutoffs = pickCutoffs(c5.length, minCandles);
  const lookAhead = cutoffs.map((cutoffBar) => ({ symbol, cutoffBar, ...def.lookAhead(c5, cfg, cutoffBar) }));
  const seg = (trades) => trades.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) }));
  return {
    base: reportSegments(seg(base), windowStartMs, inSampleDays),
    randomBaseline: reportSegments(seg(random), windowStartMs, inSampleDays),
    doubledCost: reportSegments(seg(doubled), windowStartMs, inSampleDays),
    lookAhead, candleCoverage: { c5: c5.length },
    trades: { base, random, doubled },
  };
}

// `cfgs` is { scalp, scalp_wide, exhaustion_only, intraday_crypto } (any missing key falls back to that
// strategy's own defaults) -- the already-merged live config for each, read by index.js from the live store.
async function runReplay({ store, symbols, cfg, cfgs = {}, days = 30, inSampleDays = 20, now = Date.now(), fxRate = null, trigger = 'manual', log = () => {} }) {
  const windowStartMs = now - days * DAY;
  const fx = fxRate ?? cfg.usdt_inr_fallback;
  const startedAt = Date.now();
  const runId = await store.createRun({ trigger, codeVersion: codeVersion(), params: { symbols, days, inSampleDays, fxRate: fx } });
  const bySymbol = { scalp: {} };
  for (const name of Object.keys(SINGLE_STREAM)) bySymbol[name] = {};
  const combinedTrades = { scalp: { base: [], random: [], doubled: [] } };
  for (const name of Object.keys(SINGLE_STREAM)) combinedTrades[name] = { base: [], random: [], doubled: [] };
  const lookAheadChecks = [];
  let candlesLoaded = 0;
  try {
    for (const symbol of symbols) {
      // eslint-disable-next-line no-await-in-loop
      const { c1, c5 } = await loadSymbolCandles(store, symbol, { windowStartMs, now });
      candlesLoaded += c1.length + c5.length;
      if (c1.length >= cfg.min_candles_1m && c5.length >= cfg.min_candles_5m) {
        const r = runScalpSymbol({ symbol, c1, c5, cfg, fx, windowStartMs, inSampleDays });
        bySymbol.scalp[symbol] = r;
        lookAheadChecks.push(...r.lookAhead);
        combinedTrades.scalp.base.push(...r.trades.base.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
        combinedTrades.scalp.random.push(...r.trades.random.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
        combinedTrades.scalp.doubled.push(...r.trades.doubled.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
      } else {
        bySymbol.scalp[symbol] = { error: `not enough stored history (${c1.length} 1m, ${c5.length} 5m candles); run the history loader first` };
        log(`[replay] scalp ${symbol}: skipped, not enough stored history`);
      }
      for (const [name, def] of Object.entries(SINGLE_STREAM)) {
        const cfgN = { ...def.defaultCfg, ...(cfgs[name] || {}) };
        if (c5.length < def.minCandles(cfgN)) { bySymbol[name][symbol] = { error: `not enough stored 5m history (${c5.length} candles)` }; continue; }
        const r = runSingleStreamSymbol({ name, def, symbol, c5, cfg: cfgN, fx, windowStartMs, inSampleDays });
        bySymbol[name][symbol] = r;
        lookAheadChecks.push(...r.lookAhead);
        combinedTrades[name].base.push(...r.trades.base.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
        combinedTrades[name].random.push(...r.trades.random.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
        combinedTrades[name].doubled.push(...r.trades.doubled.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
      }
    }

    const allRows = [];
    const combined = {};
    for (const [name, groups] of Object.entries(combinedTrades)) {
      combined[name] = {
        base: { full: buildReport(groups.base), inSample: buildReport(groups.base.filter((t) => t.segment === 'in_sample')), outSample: buildReport(groups.base.filter((t) => t.segment === 'out_sample')) },
        randomBaseline: { full: buildReport(groups.random) },
        doubledCost: { full: buildReport(groups.doubled) },
      };
      allRows.push(...groups.base.map((t) => toTradeRow(name, t, 'base')), ...groups.random.map((t) => toTradeRow(name, t, 'random_baseline')), ...groups.doubled.map((t) => toTradeRow(name, t, 'double_cost')));
      for (const [variant, byRange] of Object.entries(combined[name])) {
        for (const [segment, metrics] of Object.entries(byRange)) {
          // eslint-disable-next-line no-await-in-loop
          await store.saveResult({ runId, strategy: name, variant, segment, scope: {}, metrics });
        }
      }
    }
    await store.saveTrades(runId, allRows);
    const lookAheadOk = lookAheadChecks.every((c) => c.ok);
    const runtimeMs = Date.now() - startedAt;
    await store.finishRun(runId, { status: lookAheadOk ? 'done' : 'failed', error: lookAheadOk ? null : 'look-ahead check failed: a past decision changed when future candles were corrupted', candlesLoaded, runtimeMs });
    return { runId, bySymbol, combined, lookAheadChecks, lookAheadOk, candlesLoaded, runtimeMs };
  } catch (e) {
    await store.finishRun(runId, { status: 'failed', error: e.message });
    throw e;
  }
}

module.exports = { runReplay, pickCutoffs, hashSeed, windowSegment, SINGLE_STREAM };
