'use strict';
// Paper bot data sources. READ-ONLY market data: Dhan quotes / intraday
// candles / option chain (the keys the backend already uses), the FREE Yahoo
// chart fallback for NSE candles when Dhan is not available (./yahoo.js), the
// existing Economic Times news feed, and Binance PUBLIC klines (no API key).
// There is no order-placing call anywhere in this file or this folder.
const { istParts, istDayStart } = require('./time');

const FIVE_MIN = 300000;

// Names used to spot a stock in a news headline (symbol itself is always tried).
const NEWS_ALIASES = {
  RELIANCE: ['Reliance Industries', 'RIL'], TCS: ['Tata Consultancy'], HDFCBANK: ['HDFC Bank'], ICICIBANK: ['ICICI Bank'],
  INFY: ['Infosys'], SBIN: ['SBI', 'State Bank'], BHARTIARTL: ['Bharti Airtel', 'Airtel'], LT: ['Larsen', 'L&T'],
  HINDUNILVR: ['Hindustan Unilever', 'HUL'], KOTAKBANK: ['Kotak'], AXISBANK: ['Axis Bank'], BAJFINANCE: ['Bajaj Finance'],
  ASIANPAINT: ['Asian Paints'], MARUTI: ['Maruti'], SUNPHARMA: ['Sun Pharma'], ULTRACEMCO: ['UltraTech'],
  TATAMOTORS: ['Tata Motors'], NESTLEIND: ['Nestle'], ADANIENT: ['Adani Enterprises'], ADANIPORTS: ['Adani Ports'],
  POWERGRID: ['Power Grid'], 'M&M': ['Mahindra'], HCLTECH: ['HCL Tech'], TATASTEEL: ['Tata Steel'], JSWSTEEL: ['JSW Steel'],
  TECHM: ['Tech Mahindra'], DRREDDY: ["Dr Reddy", "Dr. Reddy"], COALINDIA: ['Coal India'], BAJAJFINSV: ['Bajaj Finserv'],
  EICHERMOT: ['Eicher'], HEROMOTOCO: ['Hero MotoCorp'], DIVISLAB: ["Divi's", 'Divis Lab'], APOLLOHOSP: ['Apollo Hospitals'],
  INDUSINDBK: ['IndusInd'], SBILIFE: ['SBI Life'], HDFCLIFE: ['HDFC Life'], TATACONSUM: ['Tata Consumer'],
  'BAJAJ-AUTO': ['Bajaj Auto'], SHRIRAMFIN: ['Shriram Finance'], ITC: [], TITAN: [], WIPRO: [], ONGC: [], NTPC: [],
  GRASIM: [], CIPLA: [], BRITANNIA: [], BPCL: [], HINDALCO: [], UPL: [],
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// News/event filter on headlines published today (IST). Returns
// { status: 'clear' | 'blocked' | 'unavailable', reason }.
function newsCheck(symbol, items, nowMs) {
  if (!Array.isArray(items)) return { status: 'unavailable', reason: 'news feed not available, filter could not run' };
  const today = istParts(nowMs).date;
  const names = [symbol, ...(NEWS_ALIASES[symbol] || [])];
  const re = new RegExp(`(^|[^A-Za-z0-9])(${names.map(esc).join('|')})([^A-Za-z0-9]|$)`, 'i');
  for (const it of items) {
    const ts = Date.parse(it.pubDate || '');
    if (!Number.isFinite(ts) || istParts(ts).date !== today) continue;
    if (re.test(it.title || '')) return { status: 'blocked', reason: `news today: "${String(it.title).slice(0, 120)}"` };
  }
  return { status: 'clear', reason: 'no headline about this stock today' };
}

// Builds 5-minute candles from live price samples. Used only when the
// intraday candle API is not available: every value is a real traded price
// the backend saw, nothing is filled in.
function createCandleAggregator(maxCandles = 400) {
  const bySymbol = new Map();
  return {
    record(stocks, nowMs) {
      const bucket = Math.floor(nowMs / FIVE_MIN) * FIVE_MIN;
      for (const s of stocks || []) {
        if (!s || !s.symbol || !(s.price > 0)) continue;
        let st = bySymbol.get(s.symbol);
        if (!st) { st = { candles: [], lastVol: null }; bySymbol.set(s.symbol, st); }
        let k = st.candles[st.candles.length - 1];
        if (!k || k.t !== bucket) {
          k = { t: bucket, o: s.price, h: s.price, l: s.price, c: s.price, v: 0 };
          st.candles.push(k);
          if (st.candles.length > maxCandles) st.candles.shift();
        }
        k.h = Math.max(k.h, s.price);
        k.l = Math.min(k.l, s.price);
        k.c = s.price;
        if (st.lastVol != null && s.volume >= st.lastVol) k.v += s.volume - st.lastVol;
        if (Number.isFinite(s.volume)) st.lastVol = s.volume;
      }
    },
    candles(symbol) { return (bySymbol.get(symbol)?.candles || []).map((k) => ({ ...k })); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `yahoo` (optional, ./yahoo.js): free fallback used automatically when Dhan has no candles / no live quotes.
function createNseSource({ axios, queueDhanCall, DHAN_BASE, DHAN_HEADERS, getSecurityId, getMovers, getLotSize, fetchNews, yahoo = null, log = console.log, now = Date.now }) {
  const aggregator = createCandleAggregator();
  const expiryCache = new Map(); // symbol -> { date, expiry }
  let news = { items: null, time: 0 };
  let lastChainCall = 0;
  let warnedIntraday = false;
  let dhanRetryAt = 0; // after a failed Dhan candle read, Dhan is not asked again for 15 minutes
  let lastYahooNote = '';
  const DHAN_RETRY_MS = 3 * FIVE_MIN;
  const dhanQuotes = () => {
    const m = getMovers();
    if (!m || !m.data || now() - m.time > 120000) return null;
    return m.data.all || null;
  };

  const fmt = (ms) => { const p = istParts(ms); return `${p.date} ${p.hhmm}:00`; };

  async function dhanIntraday(symbol) {
    const id = getSecurityId(symbol);
    if (!id) throw new Error(`no security id for ${symbol}`);
    const res = await queueDhanCall(() => axios.post(`${DHAN_BASE}/charts/intraday`, {
      securityId: String(id), exchangeSegment: 'NSE_EQ', instrument: 'EQUITY', interval: '5', oi: false,
      fromDate: fmt(istDayStart(now()) - 5 * 86400000), toDate: fmt(now() + 60000),
    }, { headers: DHAN_HEADERS, timeout: 15000 }));
    const d = res.data || {};
    const ts = d.timestamp || d.start_Time;
    if (!Array.isArray(ts) || !Array.isArray(d.open) || !ts.length) throw new Error('intraday response has no candles');
    return ts.map((t, i) => ({ t: t < 1e12 ? t * 1000 : t, o: d.open[i], h: d.high[i], l: d.low[i], c: d.close[i], v: d.volume?.[i] || 0 }))
      .filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite))
      .sort((a, b) => a.t - b.t);
  }

  // Dhan allows the option chain about once every 3 seconds.
  async function chainCall(url, body) {
    const wait = lastChainCall + 3100 - Date.now();
    if (wait > 0) await sleep(wait);
    lastChainCall = Date.now();
    return queueDhanCall(() => axios.post(url, body, { headers: DHAN_HEADERS, timeout: 15000 }));
  }

  return {
    // Live quotes of the basket (the same data the Movers page shows). When
    // Dhan has none, the quotes Yahoo sent with its candles (top 60 F&O stocks).
    ranking() {
      const live = dhanQuotes();
      if (live) return live;
      const rows = yahoo ? yahoo.quotes() : [];
      return rows.length ? rows : null;
    },
    // Called once at the start of every scan. With Dhan quotes live it does
    // nothing; without them it refreshes the Yahoo cache (staggered, at most
    // one request per stock per 5-minute window). A failure is logged, never hidden.
    async prepare() {
      if (!yahoo || dhanQuotes()) return { source: 'dhan' };
      const r = await yahoo.refreshAll();
      const sample = yahoo.quotes().find((q) => q.quoteLagSec != null);
      const note = `${r.ok} of ${r.ok + r.failed.length} stocks read${r.failed.length ? `, ${r.failed.length} failed and are skipped (${r.failed.slice(0, 3).map((f) => f.error).join('; ')}${r.failed.length > 3 ? '; ...' : ''})` : ''}`;
      if (note !== lastYahooNote || r.failed.length) log(`[paperbot] NSE data source: yahoo (Dhan quotes not available). ${note}${sample ? `. Observed delay of the Yahoo quote: ${sample.quoteLagSec} s` : ''}`);
      lastYahooNote = note;
      return { source: 'yahoo', ok: r.ok, failed: r.failed };
    },
    sample() { const r = dhanQuotes(); if (r) aggregator.record(r, now()); },
    // Last real price of a stock. A Yahoo price is used only if its last trade is at most
    // 2 candles + the allowed feed delay old (Yahoo's NSE data may run about 15 minutes late).
    spot(symbol, { maxDelaySec = 0 } = {}) {
      const live = dhanQuotes();
      if (live) return live.find((s) => s.symbol === symbol)?.price || null;
      const q = yahoo ? yahoo.quote(symbol) : null;
      if (!q || q.marketTime == null || now() - q.marketTime > 2 * FIVE_MIN + maxDelaySec * 1000) return null;
      return q.price;
    },
    // Native 15-minute candles (Yahoo only, for the few stocks about to be analysed). null = build them from the 5-minute candles.
    async candles15(symbol) {
      if (!yahoo || dhanQuotes()) return null;
      try { return (await yahoo.get(symbol, '15m', '5d')).candles; } catch (e) { log(`[paperbot] ${e.message}; 15-min candles of ${symbol} are built from its 5-min candles instead`); return null; }
    },
    // Candles for the report page chart (read-only): same order as candles(), nothing made up.
    async chartCandles(symbol) { return this.candles(symbol); },
    // For the exit check of an open trade when Dhan quotes are gone: one Yahoo read per 5-minute window.
    async refreshSpot(symbol) {
      if (!yahoo || dhanQuotes()) return;
      try { await yahoo.get(symbol); } catch (e) { log(`[paperbot] ${e.message}; no price for the open ${symbol} trade right now`); }
    },
    // 5-minute candles: Dhan first, then Yahoo, then candles built from live
    // Dhan prices. dataSource says where they came from ("dhan" or "yahoo").
    async candles(symbol) {
      if (now() >= dhanRetryAt) {
        try {
          return { candles: await dhanIntraday(symbol), source: 'dhan_intraday_5m', dataSource: 'dhan' };
        } catch (e) {
          if (!/^no security id/.test(e.message)) dhanRetryAt = now() + DHAN_RETRY_MS;
          if (!warnedIntraday) {
            warnedIntraday = true;
            log(`[paperbot] Dhan intraday candles not available (${e.response?.status || e.message}); using ${yahoo ? 'the free Yahoo chart fallback (top 60 F&O stocks)' : '5-min candles built from live prices'} instead`);
          }
        }
      }
      if (yahoo) {
        try {
          const y = await yahoo.get(symbol);
          return { candles: y.candles, source: 'yahoo_chart_5m', dataSource: 'yahoo_delayed', quoteLagSec: y.quoteLagSec, exchangeDelayMin: y.meta.exchangeDelayMin,
            asOfMs: y.meta.marketTime }; // time of the last trade the delayed feed has seen: a candle counts as closed only up to here
        } catch (e) {
          log(`[paperbot] ${e.message}; ${symbol} is skipped`);
        }
      }
      return { candles: aggregator.candles(symbol), source: 'built_from_live_prices', dataSource: 'dhan' };
    },
    // Real ATM option price from the Dhan option chain, or null (never guessed).
    async optionQuote(symbol, direction, fixed) {
      try {
        const id = getSecurityId(symbol);
        if (!id) return null;
        const body = { UnderlyingScrip: id, UnderlyingSeg: 'NSE_EQ' };
        const today = istParts(now()).date;
        let expiry = fixed?.expiry;
        if (!expiry) {
          const c = expiryCache.get(symbol);
          if (c && c.date === today) expiry = c.expiry;
          else {
            const ex = await chainCall(`${DHAN_BASE}/optionchain/expirylist`, body);
            expiry = (ex.data?.data || []).find((d) => d >= today);
            if (!expiry) return null;
            expiryCache.set(symbol, { date: today, expiry });
          }
        }
        const res = await chainCall(`${DHAN_BASE}/optionchain`, { ...body, Expiry: expiry });
        const data = res.data?.data || {};
        const spot = data.last_price;
        const strikes = Object.keys(data.oc || {});
        if (!(spot > 0) || !strikes.length) return null;
        const key = fixed?.strike != null
          ? strikes.find((s) => parseFloat(s) === fixed.strike)
          : strikes.reduce((best, s) => (Math.abs(parseFloat(s) - spot) < Math.abs(parseFloat(best) - spot) ? s : best));
        if (!key) return null;
        const leg = direction === 'up' ? data.oc[key].ce : data.oc[key].pe;
        const ltp = leg?.last_price;
        if (!(ltp > 0)) return null;
        return { ltp, strike: parseFloat(key), expiry, spot };
      } catch (e) {
        log(`[paperbot] option price for ${symbol} not available: ${e.response?.status || e.message}`);
        return null;
      }
    },
    lotSize: (symbol) => getLotSize(symbol) || null,
    async news() {
      if (news.items && now() - news.time < 300000) return news.items;
      try {
        news = { items: await fetchNews(), time: now() };
        return news.items;
      } catch (e) {
        log(`[paperbot] news feed failed: ${e.response?.status || e.message}`);
        return null;
      }
    },
  };
}

// Binance PUBLIC market data. No key, no account, no orders.
function createCryptoSource({ axios, log = console.log, now = Date.now, hosts = ['https://data-api.binance.vision', 'https://api.binance.com'] }) {
  let fx = { rate: null, time: 0 };
  async function get(pathname, params) {
    let lastErr;
    for (const h of hosts) {
      try {
        return (await axios.get(`${h}${pathname}`, { params, timeout: 15000 })).data;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  return {
    async candles(symbol, limit = 330, range = null) {
      const rows = await get('/api/v3/klines', { symbol, interval: '5m', limit, ...(range ? { startTime: range.startMs, endTime: range.endMs } : {}) });
      return rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite));
    },
    async price(symbol) {
      const p = +(await get('/api/v3/ticker/price', { symbol })).price;
      return p > 0 ? p : null;
    },
    // Live USDT/INR (CoinGecko, the source /api/crypto already uses). Falls
    // back to the configured rate, and says so.
    async usdtInr(fallback) {
      if (fx.rate && now() - fx.time < 600000) return { rate: fx.rate, source: 'coingecko' };
      try {
        const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', { params: { ids: 'tether', vs_currencies: 'inr' }, timeout: 15000 });
        const rate = res.data?.tether?.inr;
        if (!(rate > 0)) throw new Error('no rate');
        fx = { rate, time: now() };
        return { rate, source: 'coingecko' };
      } catch (e) {
        log(`[paperbot] USDT/INR rate not available (${e.response?.status || e.message}); using the configured fallback ${fallback}`);
        return { rate: fallback, source: 'config_fallback' };
      }
    },
  };
}

module.exports = { newsCheck, createCandleAggregator, createNseSource, createCryptoSource, NEWS_ALIASES, FIVE_MIN };
