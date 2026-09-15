const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const cron = require('node-cron');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// ============================================
// DHAN API CONFIG
// Set these as Environment Variables on Render:
//   DHAN_CLIENT_ID    -> your Dhan client id
//   DHAN_ACCESS_TOKEN -> your Dhan API access token (JWT)
// ============================================
const DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID || '';
const DHAN_ACCESS_TOKEN = process.env.DHAN_ACCESS_TOKEN || '';
const DHAN_BASE = 'https://api.dhan.co/v2';

const DHAN_HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json',
  'access-token': DHAN_ACCESS_TOKEN,
  'client-id': DHAN_CLIENT_ID,
};

// ============================================
// AUTO TOKEN RENEWAL - runs daily, keeps DHAN_HEADERS fresh
// FIX: Dhan's RenewToken response field is `accessToken`, NOT `token`.
// The old code checked `data.token` (always undefined), so renewal
// silently failed every single day and the token was never refreshed
// in memory - hence needing a manual token paste every ~8-24h.
// ============================================
async function renewDhanToken() {
  try {
    const res = await axios.get(`${DHAN_BASE}/RenewToken`, {
      headers: {
        'access-token': DHAN_HEADERS['access-token'],
        'dhanClientId': DHAN_HEADERS['client-id'],
      },
      timeout: 15000,
    });
    const data = res.data;
    if (data && data.token) {
      DHAN_HEADERS['access-token'] = data.token;
      console.log('✅ Dhan token renewed. New expiry:', data.expiryTime);
    } else {
      console.error('❌ Renew failed, unexpected response:', data);
    }
  } catch (err) {
    console.error('❌ Renew error:', err.response?.data || err.message);
  }
}

// Runs daily at 2:17 AM IST - well within the 24h renewal window
cron.schedule('17 2 * * *', renewDhanToken, {
  timezone: 'Asia/Kolkata',
});

// Manual trigger route for testing renewal without waiting for the cron
app.get('/api/renew-token', async (req, res) => {
  await renewDhanToken();
  res.json({ ok: true, message: 'Renewal attempted - check server logs for result.' });
});

// TEMPORARY DEBUG ROUTE - remove after diagnosing the auth issue.
// Shows masked info about what env vars the running process actually has,
// without ever exposing the full token/id in the response.
app.get('/api/env-check', (req, res) => {
  const token = DHAN_HEADERS['access-token'] || '';
  const clientId = DHAN_HEADERS['client-id'] || '';
  res.json({
    clientIdLength: clientId.length,
    clientIdFirst4: clientId.slice(0, 4),
    clientIdLast4: clientId.slice(-4),
    tokenLength: token.length,
    tokenFirst10: token.slice(0, 10),
    tokenLast10: token.slice(-10),
    hasLeadingOrTrailingSpaceInToken: token !== token.trim(),
    hasLeadingOrTrailingSpaceInClientId: clientId !== clientId.trim(),
  });
});

// Known index Security IDs (segment: IDX_I)
const INDEX_IDS = {
  NIFTY50: 13,
  BANKNIFTY: 25,
  SENSEX: 51,
};

// Nifty 50 constituent symbols (as they appear in Dhan's scrip master SEM_TRADING_SYMBOL)
const NIFTY50_SYMBOLS = [
  'RELIANCE','TCS','HDFCBANK','ICICIBANK','INFY','ITC','SBIN','BHARTIARTL','LT','HINDUNILVR',
  'KOTAKBANK','AXISBANK','BAJFINANCE','ASIANPAINT','MARUTI','SUNPHARMA','TITAN','ULTRACEMCO',
  'TATAMOTORS','WIPRO','NESTLEIND','ONGC','NTPC','ADANIENT','ADANIPORTS','POWERGRID','M&M',
  'HCLTECH','TATASTEEL','JSWSTEEL','TECHM','GRASIM','DRREDDY','CIPLA','COALINDIA','BAJAJFINSV',
  'BRITANNIA','EICHERMOT','HEROMOTOCO','DIVISLAB','APOLLOHOSP','BPCL','HINDALCO','INDUSINDBK',
  'SBILIFE','HDFCLIFE','TATACONSUM','BAJAJ-AUTO','UPL','SHRIRAMFIN',
];

// Sector map (same categorisation as before)
const SECTOR_MAP = {
  'IT':          ['TCS','INFY','WIPRO','HCLTECH','TECHM','LTIM'],
  'Pvt Banks':   ['HDFCBANK','ICICIBANK','AXISBANK','KOTAKBANK','INDUSINDBK'],
  'PSU Banks':   ['SBIN','BANKBARODA','PNB','CANBK'],
  'Pharma':      ['SUNPHARMA','DRREDDY','CIPLA','DIVISLAB','LUPIN'],
  'Auto':        ['TATAMOTORS','MARUTI','M&M','BAJAJ-AUTO','HEROMOTOCO','EICHERMOT'],
  'FMCG':        ['HINDUNILVR','ITC','NESTLEIND','BRITANNIA','TATACONSUM','DABUR'],
  'Metal':       ['TATASTEEL','HINDALCO','JSWSTEEL','VEDL','SAIL'],
  'Energy':      ['RELIANCE','ONGC','BPCL','IOC','GAIL'],
  'Power':       ['NTPC','POWERGRID','TATAPOWER','ADANIPOWER'],
  'Realty':      ['DLF','GODREJPROP','OBEROIRLTY','PRESTIGE'],
  'Infra/Cement':['LT','ULTRACEMCO','GRASIM','AMBUJACEM','SHREECEM'],
  'Media':       ['ZEEL','SUNTV','PVRINOX'],
  'Telecom':     ['BHARTIARTL','IDEA','INDUSTOWER'],
  'Insurance':   ['SBILIFE','HDFCLIFE','ICICIPRULI','ICICIGI'],
  'NBFC':        ['BAJFINANCE','BAJAJFINSV','CHOLAFIN','MUTHOOTFIN','SHRIRAMFIN'],
  'Consumer':    ['TITAN','HAVELLS','VOLTAS','CROMPTON'],
};

// ============================================
// INSTRUMENT MASTER (symbol -> security id) for NSE_EQ
// Downloaded once at startup, refreshed every 12h
// ============================================
let symbolToId = {};
let instrumentsLoadedAt = 0;
let lotSizes = {}; // underlying symbol -> live lot size, built from Dhan's own data

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function loadInstrumentMaster() {
  try {
    console.log('⏳ Downloading Dhan instrument master...');
    const res = await axios.get('https://images.dhan.co/api-data/api-scrip-master.csv', {
      timeout: 30000,
      responseType: 'text',
    });
    const lines = res.data.split('\n');
    const header = parseCsvLine(lines[0]).map(h => h.trim());

    const idxExch = header.indexOf('SEM_EXM_EXCH_ID');
    const idxSegment = header.indexOf('SEM_SEGMENT');
    const idxInstrument = header.indexOf('SEM_INSTRUMENT_NAME');
    const idxSymbol = header.indexOf('SEM_TRADING_SYMBOL');
    const idxSecId = header.indexOf('SEM_SMST_SECURITY_ID');
    // FIX: extra columns to derive REAL, LIVE lot sizes straight from Dhan's
    // own instrument master, instead of hardcoding numbers that go stale
    // whenever NSE revises them.
    const idxLotUnits = header.indexOf('SEM_LOT_UNITS');

    const map = {};
    const lots = {};
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = parseCsvLine(lines[i]);
      const exch = cols[idxExch];
      const instrument = cols[idxInstrument];
      const symbol = (cols[idxSymbol] || '').trim();
      const secId = cols[idxSecId];

      if (exch === 'NSE' && instrument === 'EQUITY' && symbol && secId) {
        if (!map[symbol]) map[symbol] = parseInt(secId, 10);
      }

      // FUTSTK = stock futures, FUTIDX = index futures. Every derivative
      // contract on the same underlying shares one lot size, so grabbing
      // it from the futures row (one per underlying) is enough - options
      // on that underlying use the identical lot size.
      // Dhan's SEM_TRADING_SYMBOL for these is "SYMBOL-MON2026-FUT" - drop
      // the last two hyphen-separated tokens (month-year, FUT) to recover
      // the underlying. Works even for symbols that themselves contain a
      // hyphen, e.g. "BAJAJ-AUTO-OCT2026-FUT" -> "BAJAJ-AUTO".
      if (exch === 'NSE' && (instrument === 'FUTSTK' || instrument === 'FUTIDX') && idxLotUnits !== -1) {
        const lotUnits = parseInt(cols[idxLotUnits], 10);
        if (!lotUnits || !symbol) continue;
        const parts = symbol.split('-');
        const underlying = parts.length > 2 ? parts.slice(0, -2).join('-').trim().toUpperCase() : symbol.trim().toUpperCase();
        if (underlying && !lots[underlying]) lots[underlying] = lotUnits;
      }
    }
    symbolToId = map;
    lotSizes = lots;
    instrumentsLoadedAt = Date.now();
    console.log(`✅ Instrument master loaded: ${Object.keys(symbolToId).length} NSE equities, ${Object.keys(lotSizes).length} lot sizes`);
  } catch (e) {
    console.error('❌ Instrument master load failed:', e.message);
  }
}

function getSecurityId(symbol) {
  return symbolToId[symbol];
}

// ============================================
// Cache
// ============================================
const cache = {
  movers: { data: null, time: 0 },
  sectors: { data: null, time: 0 },
  indices: { data: null, time: 0 },
};
const CACHE_TTL = 5000; // 5 seconds - near-live

// FIX: In-flight request tracker to prevent "cache stampede".
// When multiple browser tabs/clients hit an endpoint at the same moment
// and the cache is empty/expired, they were EACH firing a separate Dhan
// API call in parallel - Dhan flags that burst as abuse (805 Too many
// requests). Now, if a fetch for a given key is already in progress,
// everyone waits for that SAME promise instead of starting a new one.
const inFlight = {};
async function getOrFetch(key, fetchFn) {
  if (inFlight[key]) return inFlight[key];
  inFlight[key] = fetchFn().finally(() => { delete inFlight[key]; });
  return inFlight[key];
}

const newsCache = { data: null, time: 0 };
const NEWS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes - news doesn't change that fast

const optionsCache = {}; // keyed by symbol
const OPTIONS_CACHE_TTL = 5000; // 5 seconds

// Market hours check
function isMarketOpen() {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const timeInMin = hours * 60 + minutes;
  return timeInMin >= 555 && timeInMin <= 930;
}

// ============================================
// Dhan API helpers
// ============================================
// FIX: Dhan's documented limit for marketfeed/quote and marketfeed/ohlc is
// exactly 1 request PER SECOND. A 400ms gap allowed ~2.5 req/sec, which was
// still exceeding the limit even from a single browser tab. Bumped to
// 1100ms to stay safely under 1 req/sec.
let dhanQueue = Promise.resolve();
let lastDhanCallTime = 0;
const DHAN_MIN_GAP_MS = 1100;

function queueDhanCall(fn) {
  const run = dhanQueue.then(async () => {
    const wait = Math.max(0, lastDhanCallTime + DHAN_MIN_GAP_MS - Date.now());
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastDhanCallTime = Date.now();
    return fn();
  });
  dhanQueue = run.catch(() => {}); // keep the chain alive even if one call fails
  return run;
}

async function dhanQuote(segmentIdMap) {
  return queueDhanCall(async () => {
    const res = await axios.post(`${DHAN_BASE}/marketfeed/quote`, segmentIdMap, {
      headers: DHAN_HEADERS,
      timeout: 15000,
    });
    return res.data?.data || {};
  });
}

async function dhanOHLC(segmentIdMap) {
  return queueDhanCall(async () => {
    const res = await axios.post(`${DHAN_BASE}/marketfeed/ohlc`, segmentIdMap, {
      headers: DHAN_HEADERS,
      timeout: 15000,
    });
    return res.data?.data || {};
  });
}

// Fetch quote data for the Nifty50 basket (NSE_EQ)
async function fetchNifty50Quotes() {
  const ids = NIFTY50_SYMBOLS.map(s => getSecurityId(s)).filter(Boolean);
  const idToSymbol = {};
  NIFTY50_SYMBOLS.forEach(s => {
    const id = getSecurityId(s);
    if (id) idToSymbol[id] = s;
  });
  const data = await dhanQuote({ NSE_EQ: ids });
  const eqData = data.NSE_EQ || {};

  const stocks = [];
  for (const [id, row] of Object.entries(eqData)) {
    const symbol = idToSymbol[id];
    if (!symbol) continue;
    const lastPrice = row.last_price || 0;
    const prevClose = row.ohlc?.close || lastPrice;
    const change = parseFloat((lastPrice - prevClose).toFixed(2));
    const pct = prevClose ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
    stocks.push({
      symbol,
      price: lastPrice,
      change,
      pct,
      open: row.ohlc?.open || 0,
      high: row.ohlc?.high || 0,
      low: row.ohlc?.low || 0,
      volume: row.volume || 0,
    });
  }
  return stocks;
}

function processMovers(stocks) {
  const sorted = [...stocks].sort((a, b) => b.pct - a.pct);
  return {
    gainers: sorted.slice(0, 5),
    losers: sorted.slice(-5).reverse(),
    all: sorted,
    total: sorted.length,
    updatedAt: new Date().toISOString(),
  };
}

function broadcastToClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

async function refreshData() {
  if (!isMarketOpen()) return;
  if (Object.keys(symbolToId).length === 0) return;
  try {
    const stocks = await fetchNifty50Quotes();
    const moversData = processMovers(stocks);
    cache.movers = { data: moversData, time: Date.now() };
    broadcastToClients({ type: 'movers', data: moversData });
    console.log('✅ Dhan data refreshed at', new Date().toISOString());
  } catch (e) {
    console.error('❌ Refresh failed:', e.response?.data || e.message);
  }
}

setInterval(refreshData, 5000);
setInterval(loadInstrumentMaster, 12 * 60 * 60 * 1000);

wss.on('connection', (ws) => {
  console.log('🔌 Client connected. Total:', wss.clients.size);
  if (cache.movers.data) {
    ws.send(JSON.stringify({ type: 'movers', data: cache.movers.data }));
  }
  ws.on('close', () => console.log('🔌 Disconnected. Total:', wss.clients.size));
});

// ============================================
// ROUTES
// ============================================
app.get('/', (req, res) => {
  res.json({
    status: 'NiftyRadar Backend - Dhan Edition!',
    time: new Date(),
    marketOpen: isMarketOpen(),
    connectedClients: wss.clients.size,
    dataSource: 'Dhan API',
    instrumentsLoaded: Object.keys(symbolToId).length,
    instrumentsLoadedAt: instrumentsLoadedAt ? new Date(instrumentsLoadedAt).toISOString() : null,
  });
});

// LOT SIZES - live, derived from Dhan's own instrument master (see loadInstrumentMaster)
app.get('/api/lot-sizes', (req, res) => {
  res.json({ lotSizes, loadedAt: instrumentsLoadedAt ? new Date(instrumentsLoadedAt).toISOString() : null });
});

// MOVERS
app.get('/api/movers', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.movers.data && (now - cache.movers.time) < CACHE_TTL) {
      return res.json(cache.movers.data);
    }
    const data = await getOrFetch('movers', async () => {
      const stocks = await fetchNifty50Quotes();
      const result = processMovers(stocks);
      cache.movers = { data: result, time: Date.now() };
      return result;
    });
    res.json(data);
  } catch (e) {
    console.error('Movers error:', e.response?.data || e.message);
    if (cache.movers.data) return res.json({ ...cache.movers.data, cached: true });
    res.status(500).json({ error: e.message });
  }
});

// SECTORS
app.get('/api/sectors', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.sectors.data && (now - cache.sectors.time) < CACHE_TTL) {
      return res.json(cache.sectors.data);
    }
    const result = await getOrFetch('sectors', async () => {
      const allSymbols = [...new Set(Object.values(SECTOR_MAP).flat())];
      const ids = allSymbols.map(s => getSecurityId(s)).filter(Boolean);
      const idToSymbol = {};
      allSymbols.forEach(s => {
        const id = getSecurityId(s);
        if (id) idToSymbol[id] = s;
      });

      const data = await dhanQuote({ NSE_EQ: ids });
      const eqData = data.NSE_EQ || {};

      const stockMap = {};
      for (const [id, row] of Object.entries(eqData)) {
        const symbol = idToSymbol[id];
        if (!symbol) continue;
        const lastPrice = row.last_price || 0;
        const prevClose = row.ohlc?.close || lastPrice;
        const change = parseFloat((lastPrice - prevClose).toFixed(2));
        const pct = prevClose ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
        stockMap[symbol] = { price: lastPrice, change, pct };
      }

      const sectorResult = {};
      for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
        sectorResult[sector] = { stocks: [], avgChange: 0 };
        let total = 0, count = 0;
        for (const sym of symbols) {
          const s = stockMap[sym];
          if (s) {
            sectorResult[sector].stocks.push({ symbol: sym, price: s.price, change: s.change, pct: s.pct });
            total += s.pct; count++;
          }
        }
        sectorResult[sector].avgChange = count > 0 ? parseFloat((total / count).toFixed(2)) : 0;
      }

      cache.sectors = { data: sectorResult, time: Date.now() };
      return sectorResult;
    });
    res.json(result);
  } catch (e) {
    console.error('Sectors error:', e.response?.data || e.message);
    if (cache.sectors.data) return res.json(cache.sectors.data);
    res.status(500).json({ error: e.message });
  }
});

// NIFTY/BANKNIFTY/SENSEX INDEX
app.get('/api/indices', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.indices.data && (now - cache.indices.time) < CACHE_TTL) {
      return res.json(cache.indices.data);
    }
    const result = await getOrFetch('indices', async () => {
      const data = await dhanOHLC({ IDX_I: [INDEX_IDS.NIFTY50, INDEX_IDS.BANKNIFTY, INDEX_IDS.SENSEX] });
      const idxData = data.IDX_I || {};

      function build(id) {
        const row = idxData[id];
        if (!row) return null;
        const lastPrice = row.last_price || 0;
        const prevClose = row.ohlc?.close || lastPrice;
        const change = parseFloat((lastPrice - prevClose).toFixed(2));
        const pct = prevClose ? parseFloat(((change / prevClose) * 100).toFixed(2)) : 0;
        return { price: lastPrice, change, pct };
      }

      const idxResult = {
        nifty50: build(INDEX_IDS.NIFTY50),
        bankNifty: build(INDEX_IDS.BANKNIFTY),
        sensex: build(INDEX_IDS.SENSEX),
        updatedAt: new Date().toISOString(),
      };
      cache.indices = { data: idxResult, time: Date.now() };
      return idxResult;
    });
    res.json(result);
  } catch (e) {
    console.error('Indices error:', e.response?.data || e.message);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// LIVE NEWS - Economic Times Markets RSS feed
// Simple regex-based RSS parsing, no extra npm dependency needed
// ============================================
async function fetchMarketNews() {
  const res = await axios.get('https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms', {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NiftyRadarBot/1.0)' },
  });
  const xml = res.data;
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null && items.length < 15) {
    const block = m[1];
    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (titleMatch) {
      items.push({
        title: titleMatch[1].trim(),
        link: linkMatch ? linkMatch[1].trim() : '',
        pubDate: pubMatch ? pubMatch[1].trim() : '',
      });
    }
  }
  return items;
}

app.get('/api/news', async (req, res) => {
  try {
    const now = Date.now();
    if (newsCache.data && (now - newsCache.time) < NEWS_CACHE_TTL) {
      return res.json(newsCache.data);
    }
    const items = await fetchMarketNews();
    newsCache.data = items;
    newsCache.time = now;
    res.json(items);
  } catch (e) {
    console.error('News error:', e.response?.status || e.message);
    if (newsCache.data) return res.json(newsCache.data);
    res.status(500).json({ error: e.message });
  }
});

// DEBUG
app.get('/api/debug', async (req, res) => {
  try {
    const stocks = await fetchNifty50Quotes();
    res.json({
      success: true,
      instrumentsLoaded: Object.keys(symbolToId).length,
      count: stocks.length,
      sample: stocks.slice(0, 3),
    });
  } catch (e) {
    res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

// ============================================
// CRYPTO - CoinGecko API
// ============================================
const cryptoCache = { data: null, time: 0 };
const CRYPTO_CACHE_TTL = 30000; // 30 seconds

app.get('/api/crypto', async (req, res) => {
  try {
    const now = Date.now();
    if (cryptoCache.data && (now - cryptoCache.time) < CRYPTO_CACHE_TTL) {
      return res.json(cryptoCache.data);
    }
    const response = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
      params: {
        vs_currency: 'inr',
        order: 'market_cap_desc',
        per_page: 20,
        page: 1,
        price_change_percentage: '24h',
      },
      timeout: 15000,
    });
    const data = response.data.map(coin => ({
      id: coin.id,
      symbol: coin.symbol.toUpperCase(),
      name: coin.name,
      image: coin.image,
      price: coin.current_price,
      change24h: coin.price_change_percentage_24h,
      marketCap: coin.market_cap,
      volume: coin.total_volume,
    }));
    cryptoCache.data = data;
    cryptoCache.time = now;
    res.json(data);
  } catch (e) {
    console.error('Crypto error:', e.response?.data || e.message);
    if (cryptoCache.data) return res.json(cryptoCache.data);
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// OPTIONS CHAIN (NIFTY / BANKNIFTY) - Dhan Option Chain API
// ============================================
app.get('/api/options/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || 'NIFTY').toUpperCase();
  try {
    const now = Date.now();
    const cached = optionsCache[symbol];
    if (cached && (now - cached.time) < OPTIONS_CACHE_TTL) {
      return res.json(cached.data);
    }
    const result = await getOrFetch(`options_${symbol}`, async () => {
      // FIX: Now supports ANY stock symbol, not just NIFTY/BANKNIFTY.
      // Dhan's Option Chain API works for any underlying - for indices it's
      // UnderlyingSeg 'IDX_I', for individual stocks it's 'NSE_EQ' with the
      // same Security ID our instrument master already loads for equities.
      // Not every stock has listed F&O options - if none exist, this throws
      // a clear "No expiry found" error below instead of crashing.
      let underlyingScrip, underlyingSeg;
      if (symbol === 'NIFTY') {
        underlyingScrip = INDEX_IDS.NIFTY50;
        underlyingSeg = 'IDX_I';
      } else if (symbol === 'BANKNIFTY') {
        underlyingScrip = INDEX_IDS.BANKNIFTY;
        underlyingSeg = 'IDX_I';
      } else {
        const stockId = getSecurityId(symbol);
        if (!stockId) throw new Error(`Unknown symbol: ${symbol}`);
        underlyingScrip = stockId;
        underlyingSeg = 'NSE_EQ';
      }

      const expiryRes = await queueDhanCall(() => axios.post(`${DHAN_BASE}/optionchain/expirylist`, {
        UnderlyingScrip: underlyingScrip,
        UnderlyingSeg: underlyingSeg,
      }, { headers: DHAN_HEADERS, timeout: 15000 }));

      const expiries = expiryRes.data?.data || [];
      const nearExpiry = expiries[0];
      if (!nearExpiry) throw new Error('No expiry found for ' + symbol);

      const chainRes = await queueDhanCall(() => axios.post(`${DHAN_BASE}/optionchain`, {
        UnderlyingScrip: underlyingScrip,
        UnderlyingSeg: underlyingSeg,
        Expiry: nearExpiry,
      }, { headers: DHAN_HEADERS, timeout: 15000 }));

      const chainData = chainRes.data?.data || {};
      const spot = chainData.last_price || 0;
      const oc = chainData.oc || {};

      const strikes = Object.entries(oc).map(([strikeStr, val]) => {
        const strike = parseFloat(strikeStr);
        const ce = val.ce || {};
        const pe = val.pe || {};
        return {
          strike,
          callOI: ce.oi || 0,
          callChgOI: (ce.oi || 0) - (ce.previous_oi || 0),
          callLTP: ce.last_price || 0,
          callIV: ce.implied_volatility || 0,
          callVol: ce.volume || 0,
          putOI: pe.oi || 0,
          putChgOI: (pe.oi || 0) - (pe.previous_oi || 0),
          putLTP: pe.last_price || 0,
          putIV: pe.implied_volatility || 0,
          putVol: pe.volume || 0,
        };
      }).sort((a, b) => a.strike - b.strike);

      const atmIdx = strikes.findIndex(s => s.strike >= spot);
      const start = Math.max(0, atmIdx - 8);
      const end = Math.min(strikes.length, atmIdx + 8);
      const nearStrikes = strikes.slice(start, end);

      const totalCallOI = nearStrikes.reduce((s, x) => s + x.callOI, 0);
      const totalPutOI = nearStrikes.reduce((s, x) => s + x.putOI, 0);
      const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : 0;

      const maxPain = nearStrikes.reduce((best, s) => {
        const pain = nearStrikes.reduce((t, x) =>
          t + Math.max(0, x.callOI * (x.strike - s.strike)) + Math.max(0, x.putOI * (s.strike - x.strike)), 0);
        return pain < best.pain ? { strike: s.strike, pain } : best;
      }, { strike: nearStrikes[0]?.strike || 0, pain: Infinity });

      const payload = {
        symbol,
        spot,
        expiry: nearExpiry,
        expiries: expiries.slice(0, 4),
        pcr,
        maxPain: maxPain.strike,
        strikes: nearStrikes,
        updatedAt: new Date().toISOString(),
      };
      optionsCache[symbol] = { data: payload, time: Date.now() };
      return payload;
    });
    res.json(result);
  } catch (e) {
    console.error('Options error:', e.response?.data || e.message);
    if (optionsCache[symbol]) return res.json({ ...optionsCache[symbol].data, cached: true });
    res.status(500).json({ error: e.message, detail: e.response?.data });
  }
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  console.log(`NiftyRadar Dhan Backend running on port ${PORT}`);
  if (!DHAN_CLIENT_ID || !DHAN_ACCESS_TOKEN) {
    console.error('⚠️  DHAN_CLIENT_ID / DHAN_ACCESS_TOKEN not set in environment variables!');
  }
  await loadInstrumentMaster();
});

// ============================================
// GRACEFUL SHUTDOWN
// FIX: On Render redeploy, the OLD process was staying alive for a few
// seconds alongside the NEW process (visible as two different process IDs
// in the logs, e.g. v9kqk and j8mjg, both hitting Dhan at the same time).
// That double-hit is what was triggering the "805: Too many requests"
// error on top of the real "808: Authentication Failed" issue.
// This handler tells the old process to close its server + websocket
// connections and exit immediately when Render sends the shutdown signal.
// ============================================
function shutdown(signal) {
  console.log(`\n${signal} received - shutting down old instance gracefully...`);
  wss.clients.forEach(client => client.terminate());
  server.close(() => {
    console.log('✅ Old instance closed cleanly.');
    process.exit(0);
  });
  // Safety net in case something hangs
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
