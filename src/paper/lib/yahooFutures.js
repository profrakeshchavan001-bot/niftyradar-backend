'use strict';
// FREE data proxy for MCX gold/crude bots (src/paper/bots/mcx_gold, mcx_crude). MCX itself has no free
// public candle feed wired into this repo (Dhan/Yahoo here are both NSE-only - paperbot/sources.js,
// paperbot/yahoo.js always append ".NS"), so these two bots trade a PROXY instrument instead of the real
// MCX contract: Yahoo Finance's free, keyless chart endpoint for the global futures MCX itself tracks -
// COMEX gold (GC=F) and NYMEX WTI crude (CL=F) - converted to INR with a USD/INR rate. This is NOT the
// real MCX GOLDM/CRUDEOIL print (MCX adds import duty, GST and a local premium/discount that this proxy
// does not model), so it will not match the exchange tick-for-tick - documented here, in each bot's own
// register.js comment, and in the PR description. PAPER ONLY, read-only, no order call, no API key.
//
// Separate file from paperbot/yahoo.js on purpose: that module is hard-wired to the NSE ".NS" suffix and
// a 60-symbol NSE F&O universe; duplicating its retry/backoff/cache shape here (own, independent cache
// keyed by Yahoo symbol) is simpler and safer than bending a shared, already-relied-on file to a second,
// unrelated use.
const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const FX_SYMBOL = 'USDINR=X';
const USER_AGENT = 'niftyradar-paperbot/1.0 (paper trading demo, read-only, MCX gold/crude proxy via GC=F/CL=F)';
const STEP_MS = { '5m': 300000 };

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// Same candle shape every other source in this repo uses: { t, o, h, l, c, v }, oldest first, closed only
// filtered later by paperbot/engine.js's closedOnly() - this just parses what Yahoo sent.
function parseChart(json, interval = '5m') {
  const step = STEP_MS[interval];
  if (!step) throw new Error(`interval ${interval} is not supported`);
  const r = json?.chart?.result?.[0];
  if (!r) throw new Error(json?.chart?.error?.description || 'chart response has no result');
  const ts = r.timestamp;
  const q = r.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q || !Array.isArray(q.close)) throw new Error('chart response has no candles');
  const byT = new Map();
  ts.forEach((sec, i) => {
    const k = { t: sec * 1000, o: num(q.open?.[i]), h: num(q.high?.[i]), l: num(q.low?.[i]), c: num(q.close?.[i]), v: num(q.volume?.[i]) ?? 0 };
    if (!Number.isFinite(k.t) || k.t % step !== 0) return;
    if (![k.o, k.h, k.l, k.c].every((x) => x > 0)) return;
    byT.set(k.t, k);
  });
  const m = r.meta || {};
  return { candles: [...byT.values()].sort((a, b) => a.t - b.t), meta: { price: num(m.regularMarketPrice), marketTime: num(m.regularMarketTime) != null ? m.regularMarketTime * 1000 : null } };
}

const defaultSleep = (ms) => new Promise((res) => setTimeout(res, ms));

// unit: converts one Yahoo-native price unit into the INR unit the bot sizes positions in.
//   gold:  Yahoo GC=F is USD per troy ounce -> INR per gram  (x usdinr / 31.1034768)
//   crude: Yahoo CL=F is USD per barrel      -> INR per barrel (x usdinr)
function createYahooFuturesSource({ axios, symbol, unit, log = console.log, now = Date.now, sleep = defaultSleep,
  gapMs = 1000, windowMs = 300000, maxRetries = 3, backoffMs = 2000, maxBackoffMs = 60000, coolDownMs = 300000, timeoutMs = 8000,
  fxFallback = 88 }) {
  const cache = new Map(); // key -> { candles, meta, fetchedAt } | { error, fetchedAt }
  const inflight = new Map();
  const stats = { requests: 0, retries: 0, failures: 0, ok: 0, lastError: null, lastSuccessAt: null };
  let queue = Promise.resolve();
  let lastStart = -Infinity;
  let coolUntil = 0;
  const sameWindow = (at) => Math.floor(at / windowMs) === Math.floor(now() / windowMs);

  async function requestChart(ySymbol, interval, range) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = lastStart + gapMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      stats.requests += 1;
      try {
        const res = await axios.get(`${BASE}${encodeURIComponent(ySymbol)}`, { params: { interval, range, includePrePost: false }, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: timeoutMs });
        return res.data;
      } catch (e) {
        const status = e.response?.status;
        const retryable = status === 429 || (status >= 500 && status <= 599);
        if (!retryable) throw e;
        if (attempt >= maxRetries) { if (status === 429) coolUntil = now() + coolDownMs; throw e; }
        const delay = Math.min(backoffMs * 2 ** attempt, maxBackoffMs);
        stats.retries += 1;
        log(`[mcx-proxy] ${ySymbol}: HTTP ${status}, retry ${attempt + 1}/${maxRetries} in ${Math.round(delay / 1000)}s`);
        await sleep(delay);
      }
    }
  }

  function get(ySymbol, interval, range, convert) {
    const key = `${ySymbol}|${interval}|${range}`;
    const fromCache = () => {
      const hit = cache.get(key);
      if (!hit || !sameWindow(hit.fetchedAt)) return null;
      if (hit.error) throw new Error(hit.error);
      return hit;
    };
    try { const hit = fromCache(); if (hit) return Promise.resolve(hit); } catch (e) { return Promise.reject(e); }
    if (inflight.has(key)) return inflight.get(key);
    const p = queue.then(async () => {
      const hit = fromCache();
      if (hit) return hit;
      try {
        if (now() < coolUntil) throw new Error(`Yahoo is rate-limiting (HTTP 429); cool-down ends in ${Math.ceil((coolUntil - now()) / 1000)}s`);
        const parsed = parseChart(await requestChart(ySymbol, interval, range), interval);
        if (!parsed.candles.length) throw new Error('chart response has no usable candles');
        const entry = convert ? { candles: parsed.candles.map(convert), meta: parsed.meta, fetchedAt: now() } : { ...parsed, fetchedAt: now() };
        cache.set(key, entry);
        stats.ok += 1; stats.lastSuccessAt = now();
        return entry;
      } catch (e) {
        stats.failures += 1;
        const error = `Yahoo ${interval} candles for ${ySymbol} failed: ${e.response?.status ? `HTTP ${e.response.status}` : e.message}`;
        stats.lastError = error;
        cache.set(key, { error, fetchedAt: now() });
        throw new Error(error);
      }
    });
    queue = p.catch(() => {});
    inflight.set(key, p);
    p.catch(() => {}).then(() => inflight.delete(key));
    return p;
  }

  // The live USDINR rate (Yahoo FX ticker, same free endpoint, no key); falls back to fxFallback (the
  // bot's own usdinr_fallback config) when the fetch fails - never a thrown error, same convention
  // src/paper/scalp/bot.js's crypto.usdtInr() uses.
  async function fxRate() {
    try {
      const hit = await get(FX_SYMBOL, '5m', '1d');
      const last = hit.candles[hit.candles.length - 1];
      const rate = hit.meta.price > 0 ? hit.meta.price : last?.c;
      if (rate > 0) return { rate, source: 'yahoo_usdinr' };
    } catch (e) { log(`[mcx-proxy] USDINR fetch failed, using fallback ${fxFallback}: ${e.message}`); }
    return { rate: fxFallback, source: 'usdinr_fallback' };
  }

  // 5-minute candles of the proxy future, already converted to the bot's INR unit (gram / barrel).
  async function candles5m() {
    const fx = await fxRate();
    const conv = (k) => ({ ...k, o: unit(k.o, fx.rate), h: unit(k.h, fx.rate), l: unit(k.l, fx.rate), c: unit(k.c, fx.rate) });
    const hit = await get(symbol, '5m', '5d', conv);
    return hit.candles;
  }

  return { candles5m, fxRate, stats, symbol };
}

// Unit converters (see createYahooFuturesSource doc above).
const TROY_OZ_TO_GRAM = 31.1034768;
const goldUsdOzToInrPerGram = (usdPerOz, usdinr) => (usdPerOz * usdinr) / TROY_OZ_TO_GRAM;
const crudeUsdBblToInrPerBbl = (usdPerBbl, usdinr) => usdPerBbl * usdinr;

module.exports = { createYahooFuturesSource, parseChart, goldUsdOzToInrPerGram, crudeUsdBblToInrPerBbl, TROY_OZ_TO_GRAM, FX_SYMBOL };
