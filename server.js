const express = require('express');
const axios = require('axios');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');

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
  'IT':      ['TCS','INFY','WIPRO','HCLTECH','TECHM'],
  'Banking': ['HDFCBANK','ICICIBANK','SBIN','AXISBANK','KOTAKBANK'],
  'Pharma':  ['SUNPHARMA','DRREDDY','CIPLA'],
  'Auto':    ['TATAMOTORS','MARUTI'],
  'FMCG':    ['HINDUNILVR','ITC','NESTLEIND'],
  'Metal':   ['TATASTEEL','HINDALCO','JSWSTEEL'],
  'Energy':  ['RELIANCE','ONGC','NTPC'],
  'Realty':  ['DLF','GODREJPROP'],
  'Infra':   ['LT','ULTRACEMCO'],
  'Media':   ['ZEEL','SUNTV'],
};

// ============================================
// INSTRUMENT MASTER (symbol -> security id) for NSE_EQ
// Downloaded once at startup, refreshed every 12h
// ============================================
let symbolToId = {};
let instrumentsLoadedAt = 0;

function parseCsvLine(line) {
  // simple CSV parser that handles quoted fields with commas inside
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

    const map = {};
    for (let i = 1; i < lines.length; i++) {
      if (!lines[i]) continue;
      const cols = parseCsvLine(lines[i]);
      const exch = cols[idxExch];
      const instrument = cols[idxInstrument];
      const symbol = (cols[idxSymbol] || '').trim();
      const secId = cols[idxSecId];

      if (exch === 'NSE' && instrument === 'EQUITY' && symbol && secId) {
        // keep first match only (avoid overwriting with duplicate/less relevant rows)
        if (!map[symbol]) map[symbol] = parseInt(secId, 10);
      }
    }
    symbolToId = map;
    instrumentsLoadedAt = Date.now();
    console.log(`✅ Instrument master loaded: ${Object.keys(symbolToId).length} NSE equities`);
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
const CACHE_TTL = 30000; // 30 seconds

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
async function dhanQuote(segmentIdMap) {
  // segmentIdMap e.g. { NSE_EQ: [11536, 1333], IDX_I: [13,25] }
  const res = await axios.post(`${DHAN_BASE}/marketfeed/quote`, segmentIdMap, {
    headers: DHAN_HEADERS,
    timeout: 15000,
  });
  return res.data?.data || {};
}

async function dhanOHLC(segmentIdMap) {
  const res = await axios.post(`${DHAN_BASE}/marketfeed/ohlc`, segmentIdMap, {
    headers: DHAN_HEADERS,
    timeout: 15000,
  });
  return res.data?.data || {};
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
  if (Object.keys(symbolToId).length === 0) return; // instruments not loaded yet
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

setInterval(refreshData, 30000);
// Refresh instrument master every 12 hours
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

// MOVERS
app.get('/api/movers', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.movers.data && (now - cache.movers.time) < CACHE_TTL) {
      return res.json(cache.movers.data);
    }
    const stocks = await fetchNifty50Quotes();
    const data = processMovers(stocks);
    cache.movers = { data, time: now };
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

    // gather all unique symbols across sectors
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

    const result = {};
    for (const [sector, symbols] of Object.entries(SECTOR_MAP)) {
      result[sector] = { stocks: [], avgChange: 0 };
      let total = 0, count = 0;
      for (const sym of symbols) {
        const s = stockMap[sym];
        if (s) {
          result[sector].stocks.push({ symbol: sym, price: s.price, change: s.change, pct: s.pct });
          total += s.pct; count++;
        }
      }
      result[sector].avgChange = count > 0 ? parseFloat((total / count).toFixed(2)) : 0;
    }

    cache.sectors = { data: result, time: now };
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

    const result = {
      nifty50: build(INDEX_IDS.NIFTY50),
      bankNifty: build(INDEX_IDS.BANKNIFTY),
      sensex: build(INDEX_IDS.SENSEX),
      updatedAt: new Date().toISOString(),
    };
    cache.indices = { data: result, time: now };
    res.json(result);
  } catch (e) {
    console.error('Indices error:', e.response?.data || e.message);
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
// OPTIONS CHAIN (NIFTY / BANKNIFTY) - Dhan Option Chain API
// ============================================
app.get('/api/options/:symbol', async (req, res) => {
  try {
    const symbol = (req.params.symbol || 'NIFTY').toUpperCase();
    const underlyingScrip = symbol === 'BANKNIFTY' ? INDEX_IDS.BANKNIFTY : INDEX_IDS.NIFTY50;
    const underlyingSeg = 'IDX_I';

    // Step 1: get nearest expiry
    const expiryRes = await axios.post(`${DHAN_BASE}/optionchain/expirylist`, {
      UnderlyingScrip: underlyingScrip,
      UnderlyingSeg: underlyingSeg,
    }, { headers: DHAN_HEADERS, timeout: 15000 });

    const expiries = expiryRes.data?.data || [];
    const nearExpiry = expiries[0];
    if (!nearExpiry) throw new Error('No expiry found for ' + symbol);

    // Step 2: get option chain for nearest expiry
    const chainRes = await axios.post(`${DHAN_BASE}/optionchain`, {
      UnderlyingScrip: underlyingScrip,
      UnderlyingSeg: underlyingSeg,
      Expiry: nearExpiry,
    }, { headers: DHAN_HEADERS, timeout: 15000 });

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

    // near ATM strikes only (8 above/below)
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

    res.json({
      symbol,
      spot,
      expiry: nearExpiry,
      expiries: expiries.slice(0, 4),
      pcr,
      maxPain: maxPain.strike,
      strikes: nearStrikes,
      updatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Options error:', e.response?.data || e.message);
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
