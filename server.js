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

// NSE India headers - required for NSE API
const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.nseindia.com/',
  'Connection': 'keep-alive',
};

// NSE session cookie - refresh every 30 min
let nseCookie = '';
let cookieTime = 0;

async function getNSECookie() {
  const now = Date.now();
  if (nseCookie && (now - cookieTime) < 1800000) return nseCookie; // 30 min cache
  try {
    const res = await axios.get('https://www.nseindia.com', {
      headers: NSE_HEADERS,
      timeout: 10000
    });
    const cookies = res.headers['set-cookie'];
    if (cookies) {
      nseCookie = cookies.map(c => c.split(';')[0]).join('; ');
      cookieTime = now;
      console.log('✅ NSE cookie refreshed');
    }
  } catch (e) {
    console.error('❌ Cookie fetch failed:', e.message);
  }
  return nseCookie;
}

// Cache
const cache = {
  movers: { data: null, time: 0 },
  sectors: { data: null, time: 0 },
  nifty: { data: null, time: 0 },
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

// Fetch Nifty 50 stocks from NSE
async function fetchNifty50() {
  const cookie = await getNSECookie();
  const res = await axios.get('https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%2050', {
    headers: { ...NSE_HEADERS, 'Cookie': cookie },
    timeout: 15000
  });
  return res.data?.data || [];
}

// Fetch Nifty/Sensex index prices
async function fetchIndexData() {
  const cookie = await getNSECookie();
  const res = await axios.get('https://www.nseindia.com/api/allIndices', {
    headers: { ...NSE_HEADERS, 'Cookie': cookie },
    timeout: 15000
  });
  return res.data?.data || [];
}

// Process movers from NSE data
function processMovers(stocks) {
  // Remove index entry (first item is usually NIFTY 50 index itself)
  const filtered = stocks.filter(s => s.symbol && s.symbol !== 'NIFTY 50');
  
  const processed = filtered.map(s => ({
    symbol: s.symbol,
    price: s.lastPrice || 0,
    change: parseFloat((s.change || 0).toFixed(2)),
    pct: parseFloat((s.pChange || 0).toFixed(2)),
    open: s.open || 0,
    high: s.dayHigh || 0,
    low: s.dayLow || 0,
    volume: s.totalTradedVolume || 0,
  }));

  processed.sort((a, b) => b.pct - a.pct);
  
  return {
    gainers: processed.slice(0, 5),
    losers: processed.slice(-5).reverse(),
    all: processed,
    total: processed.length,
    updatedAt: new Date().toISOString()
  };
}

// Broadcast to WebSocket clients
function broadcastToClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// Smart auto-refresh
async function refreshData() {
  if (!isMarketOpen()) return;
  try {
    const stocks = await fetchNifty50();
    const moversData = processMovers(stocks);
    cache.movers = { data: moversData, time: Date.now() };
    broadcastToClients({ type: 'movers', data: moversData });
    console.log('✅ NSE data refreshed at', new Date().toISOString());
  } catch (e) {
    console.error('❌ Refresh failed:', e.message);
  }
}

// Refresh every 30 seconds during market hours
setInterval(refreshData, 30000);

// WebSocket
wss.on('connection', (ws) => {
  console.log('🔌 Client connected. Total:', wss.clients.size);
  if (cache.movers.data) {
    ws.send(JSON.stringify({ type: 'movers', data: cache.movers.data }));
  }
  ws.on('close', () => console.log('🔌 Disconnected. Total:', wss.clients.size));
});

// ROOT
app.get('/', (req, res) => {
  res.json({
    status: 'NiftyRadar Backend - NSE Edition!',
    time: new Date(),
    marketOpen: isMarketOpen(),
    connectedClients: wss.clients.size,
    dataSource: 'NSE India (Free - No Limits!)'
  });
});

// MOVERS
app.get('/api/movers', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.movers.data && (now - cache.movers.time) < CACHE_TTL) {
      return res.json(cache.movers.data);
    }
    const stocks = await fetchNifty50();
    const data = processMovers(stocks);
    cache.movers = { data, time: now };
    res.json(data);
  } catch (e) {
    console.error('Movers error:', e.message);
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

    const stocks = await fetchNifty50();
    const filtered = stocks.filter(s => s.symbol && s.symbol !== 'NIFTY 50');

    const sectorMap = {
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

    const stockMap = {};
    filtered.forEach(s => { stockMap[s.symbol] = s; });

    const result = {};
    for (const [sector, symbols] of Object.entries(sectorMap)) {
      result[sector] = { stocks: [], avgChange: 0 };
      let total = 0, count = 0;
      for (const sym of symbols) {
        const s = stockMap[sym];
        if (s) {
          const pct = parseFloat((s.pChange || 0).toFixed(2));
          const change = parseFloat((s.change || 0).toFixed(2));
          result[sector].stocks.push({ symbol: sym, price: s.lastPrice || 0, change, pct });
          total += pct; count++;
        }
      }
      result[sector].avgChange = count > 0 ? parseFloat((total / count).toFixed(2)) : 0;
    }

    cache.sectors = { data: result, time: now };
    res.json(result);
  } catch (e) {
    console.error('Sectors error:', e.message);
    if (cache.sectors.data) return res.json(cache.sectors.data);
    res.status(500).json({ error: e.message });
  }
});

// NIFTY/SENSEX INDEX
app.get('/api/indices', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.nifty.data && (now - cache.nifty.time) < CACHE_TTL) {
      return res.json(cache.nifty.data);
    }
    const indices = await fetchIndexData();
    const nifty = indices.find(i => i.index === 'NIFTY 50');
    const banknifty = indices.find(i => i.index === 'NIFTY BANK');
    const sensex = indices.find(i => i.index === 'SENSEX');
    const data = {
      nifty50: nifty ? { price: nifty.last, change: nifty.variation, pct: nifty.percentChange } : null,
      bankNifty: banknifty ? { price: banknifty.last, change: banknifty.variation, pct: banknifty.percentChange } : null,
      sensex: sensex ? { price: sensex.last, change: sensex.variation, pct: sensex.percentChange } : null,
      updatedAt: new Date().toISOString()
    };
    cache.nifty = { data, time: now };
    res.json(data);
  } catch (e) {
    console.error('Indices error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DEBUG
app.get('/api/debug', async (req, res) => {
  try {
    const stocks = await fetchNifty50();
    res.json({ success: true, count: stocks.length, sample: stocks.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NiftyRadar NSE Backend running on port ${PORT}`));

// ✅ REAL OPTIONS CHAIN - NSE India Free API
app.get('/api/options/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol || 'NIFTY';
    
    // Force fresh cookie for options
    nseCookie = '';
    cookieTime = 0;
    const cookie = await getNSECookie();
    
    // First visit options page to get proper session
    await axios.get('https://www.nseindia.com/option-chain', {
      headers: { ...NSE_HEADERS, 'Cookie': cookie },
      timeout: 10000
    }).catch(() => {});
    
    await new Promise(r => setTimeout(r, 1000));
    
    const freshCookie = await getNSECookie();
    const url = symbol === 'BANKNIFTY' 
      ? 'https://www.nseindia.com/api/option-chain-indices?symbol=BANKNIFTY'
      : 'https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY';
    
    const response = await axios.get(url, {
      headers: { ...NSE_HEADERS, 'Cookie': freshCookie },
      timeout: 15000
    });

    const data = response.data;
    const spot = data?.records?.underlyingValue || 0;
    const expDates = data?.records?.expiryDates || [];
    const allData = data?.records?.data || [];

    // Get nearest expiry
    const nearExpiry = expDates[0];
    
    // Filter by nearest expiry
    const filtered = allData.filter(d => d.expiryDate === nearExpiry);

    // Process strikes
    const strikes = {};
    filtered.forEach(item => {
      const strike = item.strikePrice;
      if (!strikes[strike]) strikes[strike] = { strike, callOI: 0, putOI: 0, callChgOI: 0, putChgOI: 0, callLTP: 0, putLTP: 0, callIV: 0, putIV: 0, callVol: 0, putVol: 0 };
      if (item.CE) {
        strikes[strike].callOI = item.CE.openInterest || 0;
        strikes[strike].callChgOI = item.CE.changeinOpenInterest || 0;
        strikes[strike].callLTP = item.CE.lastPrice || 0;
        strikes[strike].callIV = item.CE.impliedVolatility || 0;
        strikes[strike].callVol = item.CE.totalTradedVolume || 0;
      }
      if (item.PE) {
        strikes[strike].putOI = item.PE.openInterest || 0;
        strikes[strike].putChgOI = item.PE.changeinOpenInterest || 0;
        strikes[strike].putLTP = item.PE.lastPrice || 0;
        strikes[strike].putIV = item.PE.impliedVolatility || 0;
        strikes[strike].putVol = item.PE.totalTradedVolume || 0;
      }
    });

    // Get ATM strikes (10 above, 10 below spot)
    const allStrikes = Object.values(strikes).sort((a, b) => a.strike - b.strike);
    const atmIdx = allStrikes.findIndex(s => s.strike >= spot);
    const start = Math.max(0, atmIdx - 8);
    const end = Math.min(allStrikes.length, atmIdx + 8);
    const nearStrikes = allStrikes.slice(start, end);

    // PCR
    const totalCallOI = nearStrikes.reduce((s, x) => s + x.callOI, 0);
    const totalPutOI = nearStrikes.reduce((s, x) => s + x.putOI, 0);
    const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : 0;

    // Max Pain
    const maxPain = nearStrikes.reduce((best, s) => {
      const pain = nearStrikes.reduce((t, x) => t + Math.max(0, x.callOI * (x.strike - s.strike)) + Math.max(0, x.putOI * (s.strike - x.strike)), 0);
      return pain < best.pain ? { strike: s.strike, pain } : best;
    }, { strike: nearStrikes[0]?.strike || 0, pain: Infinity });

    res.json({
      symbol,
      spot,
      expiry: nearExpiry,
      expiries: expDates.slice(0, 4),
      pcr,
      maxPain: maxPain.strike,
      strikes: nearStrikes,
      updatedAt: new Date().toISOString()
    });

  } catch (e) {
    console.error('Options error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
