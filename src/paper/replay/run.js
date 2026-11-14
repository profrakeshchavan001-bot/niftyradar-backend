'use strict';
// Orchestrates one replay run: load stored candles, replay the real scalp engine, the random baseline and
// the doubled-cost check, split in/out of sample, run the filter study, and save everything. PAPER ONLY.
const { replayScalp, replayRandomBaseline } = require('./simulator');
const { buildReport, splitInOutSample } = require('./stats');
const { runFilterStudy } = require('./filters');
const { lookAheadCheck } = require('./lookahead');
const { codeVersion } = require('./codeVersion');

const DAY = 86400000;

async function loadSymbolCandles(store, symbol, { windowStartMs, now }) {
  const [c1, c5] = await Promise.all([
    store.getCandles(symbol, '1m', { fromT: windowStartMs, toT: now }),
    store.getCandles(symbol, '5m', { fromT: windowStartMs, toT: now }),
  ]);
  return { c1, c5 };
}

// `cfg` is the already-merged live scalp config (SCALP_DEFAULTS + any paper_config override); run.js takes
// it as a plain object so the replay engine never needs its own copy of the live store's config logic.
async function runReplay({ store, symbols, cfg, days = 30, inSampleDays = 20, now = Date.now(), fxRate = null, trigger = 'manual', log = () => {} }) {
  const windowStartMs = now - days * DAY;
  const fx = fxRate ?? cfg.usdt_inr_fallback;
  const runId = await store.createRun({ trigger, codeVersion: codeVersion(), params: { symbols, days, inSampleDays, fxRate: fx } });
  const bySymbol = {};
  const allTrades = []; const allRandom = []; const allDouble = [];
  const lookAheadChecks = [];
  try {
    for (const symbol of symbols) {
      // eslint-disable-next-line no-await-in-loop
      const { c1, c5 } = await loadSymbolCandles(store, symbol, { windowStartMs, now });
      if (c1.length < cfg.min_candles_1m || c5.length < cfg.min_candles_5m) {
        bySymbol[symbol] = { error: `not enough stored history (${c1.length} 1m, ${c5.length} 5m candles); run the history loader first` };
        log(`[replay] ${symbol}: skipped, not enough stored history`);
        continue;
      }
      const base = replayScalp({ symbol, candles1m: c1, candles5m: c5, cfg, fxRate: fx });
      const doubled = replayScalp({ symbol, candles1m: c1, candles5m: c5, cfg: { ...cfg, fee_pct_per_side: cfg.fee_pct_per_side * 2, slippage_pct: cfg.slippage_pct * 2 }, fxRate: fx });
      const random = replayRandomBaseline({ symbol, candles1m: c1, realTrades: base, cfg, fxRate: fx, seed: hashSeed(symbol) });
      const filterStudy = runFilterStudy({ symbol, candles1m: c1, candles5m: c5, cfg, fxRate: fx, baseTrades: base });

      // Look-ahead spot-check: a handful of cutoffs spread through the symbol's history (brief item 5,
      // "repeat after every new adapter" -- here, every run, which is cheap since min_candles_1m guards the start).
      const cutoffs = pickCutoffs(c1.length, cfg.min_candles_1m);
      const checks = cutoffs.map((cutoffBar1m) => ({ symbol, cutoffBar1m, ...lookAheadCheck({ candles1m: c1, candles5m: c5, cfg, cutoffBar1m }) }));
      lookAheadChecks.push(...checks);

      const { inSample, outSample } = splitInOutSample(base, { windowStartMs, inSampleDays });
      const randomSplit = splitInOutSample(random, { windowStartMs, inSampleDays });
      const doubleSplit = splitInOutSample(doubled, { windowStartMs, inSampleDays });

      bySymbol[symbol] = {
        base: { full: buildReport(base), inSample: buildReport(inSample), outSample: buildReport(outSample) },
        randomBaseline: { full: buildReport(random), inSample: buildReport(randomSplit.inSample), outSample: buildReport(randomSplit.outSample) },
        doubledCost: { full: buildReport(doubled), inSample: buildReport(doubleSplit.inSample), outSample: buildReport(doubleSplit.outSample) },
        filterStudy,
        lookAhead: checks,
        candleCoverage: { c1: c1.length, c5: c5.length },
      };

      allTrades.push(...base.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
      allRandom.push(...random.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
      allDouble.push(...doubled.map((t) => ({ ...t, segment: windowSegment(t, windowStartMs, inSampleDays) })));
    }

    // eslint-disable-next-line no-await-in-loop
    await store.saveTrades(runId, [
      ...allTrades.map((t) => toTradeRow(t, 'base')),
      ...allRandom.map((t) => toTradeRow(t, 'random_baseline')),
      ...allDouble.map((t) => toTradeRow(t, 'double_cost')),
    ]);
    const combined = {
      base: { full: buildReport(allTrades), inSample: buildReport(allTrades.filter((t) => t.segment === 'in_sample')), outSample: buildReport(allTrades.filter((t) => t.segment === 'out_sample')) },
      randomBaseline: { full: buildReport(allRandom) },
      doubledCost: { full: buildReport(allDouble) },
    };
    for (const [variant, byRange] of Object.entries(combined)) {
      for (const [segment, metrics] of Object.entries(byRange)) {
        // eslint-disable-next-line no-await-in-loop
        await store.saveResult({ runId, strategy: 'scalp', variant, segment, scope: {}, metrics });
      }
    }
    const lookAheadOk = lookAheadChecks.every((c) => c.ok);
    await store.finishRun(runId, { status: lookAheadOk ? 'done' : 'failed', error: lookAheadOk ? null : 'look-ahead check failed: a past decision changed when future candles were corrupted' });
    return { runId, bySymbol, combined, lookAheadChecks, lookAheadOk };
  } catch (e) {
    await store.finishRun(runId, { status: 'failed', error: e.message });
    throw e;
  }
}

function windowSegment(t, windowStartMs, inSampleDays) {
  return t.entry_t < windowStartMs + inSampleDays * DAY ? 'in_sample' : 'out_sample';
}

function toTradeRow(t, variant) {
  return {
    strategy: 'scalp', variant, segment: t.segment, symbol: t.symbol, direction: t.direction, entry_t: t.entry_t,
    exit_t: t.exit_t, entry_price: t.entry_price, exit_price: t.exit_price, exit_reason: t.exit_reason,
    stop_pct: t.stop_pct, target_pct: t.target_pct, rr: t.rr, pnl_inr: t.pnl_inr, patterns: t.patterns,
  };
}

// A handful of evenly spread cutoffs, always inside the valid range (after the warm-up window).
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

module.exports = { runReplay, pickCutoffs, hashSeed, windowSegment };
