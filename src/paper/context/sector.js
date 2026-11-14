'use strict';
// Sector momentum for the paper-trading bot: "is this stock's sector strong or weak today?"
// Self-contained: no Dhan, no database, no other backend file. Formula in plain words: docs/SECTOR-CONTEXT.md.
// Rule: real data only. When the source fails or a needed number is missing, the answer is null, never a made-up score.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAP_FILE = path.join(__dirname, '..', '..', '..', 'data', 'nse-sectors.json');
const CACHE_TTL_MS = 5 * 60 * 1000; // good answers are reused for 5 minutes
const FAIL_TTL_MS = 60 * 1000; // after a failed fetch, wait 1 minute before asking the source again

// Each part is turned into 0..100 on a fixed scale, then the parts are mixed by weight (weights add up to 100).
const WEIGHTS = Object.freeze({ change: 30, relative: 30, breadth: 20, trend: 20 });
const RANGES = Object.freeze({ change: 2, relative: 1.5, trend: 4 }); // -2 %..+2 % today, -1.5..+1.5 points vs Nifty, -4 %..+4 % over 3 days
const STRONG_FROM = 65;
const WEAK_UPTO = 35;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round2 = (x) => Math.round(x * 100) / 100;
const pctChange = (now, before) => (isNum(now) && isNum(before) && before > 0 ? (now / before - 1) * 100 : null);
/** value in [-range, +range] -> 0..100 (clamped). -range = 0, 0 = 50, +range = 100. */
const scale = (value, range) => Math.min(100, Math.max(0, ((value + range) / (2 * range)) * 100));

function loadSectorMap(file = DEFAULT_MAP_FILE) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 'tcs', 'TCS.NS', 'NSE:TCS' -> 'TCS' */
function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const s = symbol.trim().toUpperCase().replace(/^NSE:/, '').replace(/\.(NS|NSE)$/, '');
  return /^[A-Z0-9&-]{1,20}$/.test(s) ? s : null;
}

/** Sector name of an NSE stock from the static map, or null when the stock is not in it. */
function sectorOf(symbol, map) {
  const s = normalizeSymbol(symbol);
  if (!s) return null;
  for (const [name, def] of Object.entries(map.sectors)) if (def.stocks.includes(s)) return name;
  return null;
}

/** % change over the last 3 sessions: latest value against the close 3 sessions back. `closes` = daily closes, oldest first, the last one is the latest value. */
function trend3(closes) {
  if (!Array.isArray(closes) || closes.length < 4) return null;
  return pctChange(closes[closes.length - 1], closes[closes.length - 4]);
}

/** % of the sector's stocks that are above their VWAP (when the source gives one) or else above the previous close. Needs data for at least half of the stocks. */
function breadthOf(stocks, expected) {
  const usable = (stocks || []).filter((s) => isNum(s.price) && (isNum(s.vwap) || isNum(s.prevClose)));
  if (!usable.length || usable.length * 2 < expected) return null;
  const up = usable.filter((s) => s.price > (isNum(s.vwap) ? s.vwap : s.prevClose)).length;
  return (up / usable.length) * 100;
}

/** Equal-weight average % change of the stocks: used as the sector move only when the sector has no index. */
function basketChange(stocks, expected) {
  const moves = (stocks || []).map((s) => pctChange(s.price, s.prevClose)).filter(isNum);
  if (!moves.length || moves.length * 2 < expected) return null;
  return moves.reduce((a, b) => a + b, 0) / moves.length;
}

const labelOf = (score) => (score >= STRONG_FROM ? 'STRONG' : score <= WEAK_UPTO ? 'WEAK' : 'AVERAGE');

/**
 * Pure scoring. `q` = one sector's quotes { index: { pct, closes } | null, stocks: [{ symbol, price, prevClose, vwap? }] }, `nifty` = { pct, closes }.
 * Returns null when today's sector move or today's Nifty move is not known. Breadth and the 3-day trend are optional: when one is missing its
 * weight is shared out over the parts that are known, and it is named in `missing`.
 */
function scoreSector(q, nifty, expectedStocks = (q && q.stocks ? q.stocks.length : 0)) {
  if (!q || !nifty || !isNum(nifty.pct)) return null;
  const fromIndex = q.index && isNum(q.index.pct);
  const change = fromIndex ? q.index.pct : basketChange(q.stocks, expectedStocks);
  if (!isNum(change)) return null;
  const vsNifty = change - nifty.pct;
  const breadth = breadthOf(q.stocks, expectedStocks);
  const trend = fromIndex ? trend3(q.index.closes) : null; // no index = no 3-day history of the sector
  const parts = { change: scale(change, RANGES.change), relative: scale(vsNifty, RANGES.relative), breadth, trend: isNum(trend) ? scale(trend, RANGES.trend) : null };
  let sum = 0; let weight = 0; const missing = [];
  for (const [k, w] of Object.entries(WEIGHTS)) {
    if (isNum(parts[k])) { sum += w * parts[k]; weight += w; } else missing.push(k);
  }
  const score = Math.round(sum / weight);
  return {
    score, label: labelOf(score), vsNifty: round2(vsNifty), changePct: round2(change), niftyPct: round2(nifty.pct),
    breadthPct: isNum(breadth) ? round2(breadth) : null, trend3Pct: isNum(trend) ? round2(trend) : null,
    basis: fromIndex ? 'index' : 'stocks_average', missing,
  };
}

/**
 * The module. `adapter.getSectorQuotes()` must resolve to { asOf, nifty: { pct, closes }, sectors: { [name]: { index, stocks } } } or null.
 * Results are cached for 5 minutes; a failure is cached for 1 minute so a dead source is not asked on every call.
 */
function createSectorContext({ adapter, map = loadSectorMap(), ttlMs = CACHE_TTL_MS, failTtlMs = FAIL_TTL_MS, now = Date.now, log = () => {} } = {}) {
  if (!adapter || typeof adapter.getSectorQuotes !== 'function') throw new Error('sector context needs an adapter with getSectorQuotes()');
  let cache = { at: -Infinity, data: null, ok: false };
  let inFlight = null;

  async function getQuotes() {
    const age = now() - cache.at;
    if (age < (cache.ok ? ttlMs : failTtlMs)) return cache.data;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let data = null;
      try { data = await adapter.getSectorQuotes(); } catch (err) { log(`[sector] source failed: ${err.message}`); }
      const ok = Boolean(data && data.nifty && isNum(data.nifty.pct) && data.sectors);
      cache = { at: now(), data: ok ? data : null, ok };
      return cache.data;
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }

  /** sectorScore('IT') -> { sector, score 0..100, label, vsNifty, ... } or null (unknown sector, source down, numbers missing). */
  async function sectorScore(sector) {
    const def = map.sectors[sector];
    if (!def) return null;
    const quotes = await getQuotes();
    if (!quotes) return null;
    const s = scoreSector(quotes.sectors[sector], quotes.nifty, def.stocks.length);
    return s ? { sector, ...s, asOf: quotes.asOf ?? null } : null;
  }

  /** stockSectorView('TCS') -> { sector, score, label, vsNifty } or null. */
  async function stockSectorView(symbol) {
    const sector = sectorOf(symbol, map);
    if (!sector) return null;
    const s = await sectorScore(sector);
    return s ? { sector, score: s.score, label: s.label, vsNifty: s.vsNifty } : null;
  }

  return { getQuotes, sectorScore, stockSectorView, sectorOf: (symbol) => sectorOf(symbol, map), sectors: () => Object.keys(map.sectors) };
}

/** Test adapter: hands back a fixed object (or a function's result). */
function createFixtureAdapter(data) {
  let calls = 0;
  return { getSectorQuotes: async () => { calls += 1; return typeof data === 'function' ? data(calls) : data; }, calls: () => calls };
}

/**
 * One Yahoo chart answer -> { price, prevClose, pct, closes, asOf } or null.
 * closes = daily closes oldest first with the latest price as the last value; prevClose = the close of the session before the latest one.
 */
function parseYahooChart(json) {
  const r = json && json.chart && Array.isArray(json.chart.result) ? json.chart.result[0] : null;
  const raw = r && r.indicators && r.indicators.quote && r.indicators.quote[0] ? r.indicators.quote[0].close : null;
  if (!Array.isArray(raw)) return null;
  const closes = raw.filter(isNum);
  if (closes.length < 2) return null;
  const live = r.meta && isNum(r.meta.regularMarketPrice) ? r.meta.regularMarketPrice : closes[closes.length - 1];
  closes[closes.length - 1] = live;
  const prevClose = closes[closes.length - 2];
  const pct = pctChange(live, prevClose);
  if (!isNum(pct)) return null;
  return { price: live, prevClose, pct, closes, asOf: r.meta && isNum(r.meta.regularMarketTime) ? new Date(r.meta.regularMarketTime * 1000).toISOString() : null };
}

const yahooStockTicker = (symbol) => `${symbol}.NS`;

/**
 * Free adapter: Yahoo Finance public chart endpoint (no key). One request per index and per stock, a few at a time.
 * The Nifty 50 must load, else the whole answer is null. A sector index or a stock that fails is simply left out (the scorer then returns null
 * for that sector or names the missing part). Yahoo gives no VWAP, so breadth uses the previous close.
 */
function createYahooAdapter({ map = loadSectorMap(), fetchJson = defaultFetchJson, concurrency = 6, base = 'https://query1.finance.yahoo.com/v8/finance/chart/', log = () => {} } = {}) {
  const one = async (ticker) => {
    try { return parseYahooChart(await fetchJson(`${base}${encodeURIComponent(ticker)}?range=10d&interval=1d`)); } catch (err) { log(`[sector] ${ticker}: ${err.message}`); return null; }
  };
  async function getSectorQuotes() {
    const nifty = await one(map.benchmark.yahooIndex);
    if (!nifty) return null;
    const jobs = [];
    for (const [name, def] of Object.entries(map.sectors)) {
      if (def.yahooIndex) jobs.push({ name, kind: 'index', ticker: def.yahooIndex });
      for (const symbol of def.stocks) jobs.push({ name, kind: 'stock', symbol, ticker: yahooStockTicker(symbol) });
    }
    const sectors = Object.fromEntries(Object.keys(map.sectors).map((name) => [name, { index: null, stocks: [] }]));
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const q = await one(job.ticker);
        if (!q) continue;
        if (job.kind === 'index') sectors[job.name].index = { symbol: job.ticker, pct: q.pct, closes: q.closes };
        else sectors[job.name].stocks.push({ symbol: job.symbol, price: q.price, prevClose: q.prevClose });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
    return { asOf: nifty.asOf, source: 'yahoo', nifty: { pct: nifty.pct, closes: nifty.closes }, sectors };
  }
  return { getSectorQuotes };
}

async function defaultFetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Ready-to-use instance on the free adapter (created on first use, so loading this file never touches the network).
let shared = null;
const live = () => (shared || (shared = createSectorContext({ adapter: createYahooAdapter() })));
const sectorScore = (sector) => live().sectorScore(sector);
const stockSectorView = (symbol) => live().stockSectorView(symbol);

module.exports = {
  sectorScore, stockSectorView,
  createSectorContext, createFixtureAdapter, createYahooAdapter,
  scoreSector, parseYahooChart, sectorOf, normalizeSymbol, loadSectorMap, trend3, breadthOf, basketChange, scale, labelOf,
  WEIGHTS, RANGES, STRONG_FROM, WEAK_UPTO, CACHE_TTL_MS, FAIL_TTL_MS,
};
