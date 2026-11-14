'use strict';
// FREE fallback for NSE intraday candles: Yahoo Finance's public chart
// endpoint (SYMBOL.NS, no key). Used only when Dhan candles are not available.
// READ-ONLY market data, no order call. Rules kept here:
//  - universe: at most 60 liquid F&O stocks (data/nse-fno-top60.json), nothing else is ever asked for
//  - one request at a time, about 1 per second, polite User-Agent
//  - shared cache: one request per symbol and interval per 5-minute clock window, never more
//  - 429 / 5xx: exponential backoff, then a cool-down; a failed symbol is not asked again in that window
//  - nothing is filled in: a row Yahoo sends without prices is dropped, a failed read throws
const fs = require('fs');
const path = require('path');
const { istDayStart } = require('./time');

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const USER_AGENT = 'niftyradar-paperbot/1.0 (paper trading demo, read-only; about 1 request per second, 5-minute cache)';
const STEP_MS = { '5m': 300000, '15m': 900000 };
const RANGES = ['1d', '5d'];
const MAX_UNIVERSE = 60;

function loadUniverse(file = path.join(__dirname, '..', 'data', 'nse-fno-top60.json')) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8')).symbols;
  return [...new Set(list.filter((s) => typeof s === 'string' && s))].slice(0, MAX_UNIVERSE);
}

const yahooTicker = (symbol) => `${symbol}.NS`;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

// One chart answer -> { candles, meta }. Candles are { t (ms, candle start), o, h, l, c, v }.
// Dropped, never repaired: rows with a missing price, and the extra "live" row
// Yahoo sometimes adds at the last trade time (not on a candle boundary).
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
  return {
    candles: [...byT.values()].sort((a, b) => a.t - b.t),
    meta: {
      price: num(m.regularMarketPrice),
      marketTime: num(m.regularMarketTime) != null ? m.regularMarketTime * 1000 : null, // time of the last trade Yahoo has
      dayVolume: num(m.regularMarketVolume),
      exchangeDelayMin: num(m.exchangeDataDelayedBy), // delay Yahoo itself declares for the exchange, in minutes
    },
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createYahooSource({ axios, log = console.log, now = Date.now, sleep = defaultSleep, universe = loadUniverse(), gapMs = 1000, windowMs = 300000,
  maxRetries = 3, backoffMs = 2000, maxBackoffMs = 60000, coolDownMs = 300000, timeoutMs = 15000 }) {
  const allowed = new Set(universe.slice(0, MAX_UNIVERSE));
  const cache = new Map(); // `${symbol}|${interval}|${range}` -> { candles, meta, fetchedAt } or { error, fetchedAt }
  const inflight = new Map();
  const stats = { requests: 0, retries: 0, failures: 0 };
  let queue = Promise.resolve();
  let lastStart = -Infinity;
  let coolUntil = 0;
  const sameWindow = (at) => Math.floor(at / windowMs) === Math.floor(now() / windowMs);

  async function request(symbol, interval, range) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = lastStart + gapMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      stats.requests += 1;
      try {
        const res = await axios.get(`${BASE}${encodeURIComponent(yahooTicker(symbol))}`, {
          params: { interval, range, includePrePost: false },
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, timeout: timeoutMs,
        });
        return res.data;
      } catch (e) {
        const status = e.response?.status;
        const retryable = status === 429 || (status >= 500 && status <= 599);
        if (!retryable) throw e;
        if (attempt >= maxRetries) {
          if (status === 429) coolUntil = now() + coolDownMs; // still rate-limited: leave Yahoo alone for a while
          throw e;
        }
        const retryAfter = Number(e.response?.headers?.['retry-after']) * 1000;
        const delay = Math.min(Math.max(backoffMs * 2 ** attempt, retryAfter > 0 ? retryAfter : 0), maxBackoffMs);
        stats.retries += 1;
        log(`[paperbot] Yahoo ${symbol}: HTTP ${status}, waiting ${Math.round(delay / 1000)} s before retry ${attempt + 1} of ${maxRetries}`);
        await sleep(delay);
      }
    }
  }

  // Candles + quote of one universe stock. Reads the shared cache; asks Yahoo
  // at most once per 5-minute clock window. Throws when there is no real data.
  function get(symbol, interval = '5m', range = '5d') {
    if (!allowed.has(symbol)) return Promise.reject(new Error(`${symbol} is not in the Yahoo fallback universe (top ${MAX_UNIVERSE} F&O stocks)`));
    if (!STEP_MS[interval] || !RANGES.includes(range)) return Promise.reject(new Error(`interval ${interval} / range ${range} is not supported`));
    const key = `${symbol}|${interval}|${range}`;
    const fromCache = () => {
      const hit = cache.get(key);
      if (!hit || !sameWindow(hit.fetchedAt)) return null;
      if (hit.error) throw new Error(hit.error);
      return hit;
    };
    try { const hit = fromCache(); if (hit) return Promise.resolve(hit); } catch (e) { return Promise.reject(e); }
    if (inflight.has(key)) return inflight.get(key);
    const p = queue.then(async () => {
      const hit = fromCache(); // may have been filled while this call waited in the queue
      if (hit) return hit;
      try {
        if (now() < coolUntil) throw new Error(`Yahoo is rate-limiting (HTTP 429); no request until the cool-down ends in ${Math.ceil((coolUntil - now()) / 1000)} s`);
        const parsed = parseChart(await request(symbol, interval, range), interval);
        if (!parsed.candles.length) throw new Error('chart response has no usable candles');
        const fetchedAt = now();
        const entry = { ...parsed, fetchedAt, interval, quoteLagSec: parsed.meta.marketTime != null ? Math.max(0, Math.round((fetchedAt - parsed.meta.marketTime) / 1000)) : null };
        cache.set(key, entry);
        return entry;
      } catch (e) {
        stats.failures += 1;
        const error = `Yahoo ${interval} candles for ${symbol} failed: ${e.response?.status ? `HTTP ${e.response.status}` : e.message}`;
        cache.set(key, { error, fetchedAt: now() }); // not asked again in this window
        throw new Error(error);
      }
    });
    queue = p.catch(() => {});
    inflight.set(key, p);
    p.catch(() => {}).then(() => inflight.delete(key));
    return p;
  }

  // Refreshes the 5-minute candles of the whole universe, one stock at a time.
  async function refreshAll() {
    const failed = [];
    let ok = 0;
    for (const symbol of allowed) {
      try { await get(symbol); ok += 1; } catch (e) { failed.push({ symbol, error: e.message }); }
    }
    return { ok, failed };
  }

  // Quote row in the shape of the Movers basket ({ symbol, price, pct, volume }),
  // built only from what Yahoo sent in this or the previous 5-minute window.
  function quote(symbol) {
    const hit = cache.get(`${symbol}|5m|5d`);
    if (!hit || hit.error || now() - hit.fetchedAt > 2 * windowMs) return null;
    const dayStart = istDayStart(now());
    const today = hit.candles.filter((k) => k.t >= dayStart);
    const before = hit.candles.filter((k) => k.t < dayStart);
    const price = hit.meta.price;
    const prevClose = before.length ? before[before.length - 1].c : null;
    if (!(price > 0) || !(prevClose > 0) || !today.length) return null; // no trade today or no previous close: no quote
    const volume = hit.meta.dayVolume != null ? hit.meta.dayVolume : today.reduce((s, k) => s + k.v, 0);
    return {
      symbol, price, pct: Math.round((price - prevClose) / prevClose * 10000) / 100, volume, prevClose,
      source: 'yahoo', marketTime: hit.meta.marketTime, quoteLagSec: hit.quoteLagSec, fetchedAt: hit.fetchedAt,
    };
  }
  const quotes = () => [...allowed].map(quote).filter(Boolean);

  return { get, refreshAll, quote, quotes, universe: [...allowed], stats, userAgent: USER_AGENT };
}

module.exports = { createYahooSource, parseChart, loadUniverse, yahooTicker, USER_AGENT, MAX_UNIVERSE };
