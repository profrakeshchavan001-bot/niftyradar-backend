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

const DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID;
const DHAN_TOKEN = process.env.DHAN_TOKEN;

const SECURITY_MAP = {
  'RELIANCE':   2885, 'TCS':        11536, 'HDFCBANK':   1333,
  'INFY':       1594, 'ICICIBANK':  4963,  'SBIN':       3045,
  'WIPRO':      3787, 'TATAMOTORS': 3456,  'BAJFINANCE': 317,
  'HINDUNILVR': 1394, 'HCLTECH':    7229,  'TECHM':      13538,
  'AXISBANK':   5900, 'KOTAKBANK':  1922,  'SUNPHARMA':  3351,
  'DRREDDY':    881,  'CIPLA':      694,   'MARUTI':      10999,
  'TATASTEEL':  3499, 'HINDALCO':   1363,  'JSWSTEEL':   11723,
  'ONGC':       2475, 'NTPC':       11630, 'DLF':        14732,
  'GODREJPROP': 14417,'LT':         11483, 'ULTRACEMCO': 11532,
  'ZEEL':       975,  'SUNTV':      3290,  'ITC':        1660,
  'NESTLEIND':  17963,
};

const cache = {
  movers: { data: null, time: 0 },
  sectors: { data: null, time: 0 },
};
const CACHE_TTL = 30000;

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

function idToSymbol(id) {
  const numId = parseInt(id);
  return Object.keys(SECURITY_MAP).find(k => SECURITY_MAP[k] === numId) || id;
}

function calcPct(lastPrice, prevClose) {
  if (!prevClose || prevClose === 0) return 0;
  return parseFloat(((lastPrice - prevClose) / prevClose * 100).toFixed(2));
}

async function fetchQuotesBatch(symbolList) {
  const ids = symbolList.map(s => SECURITY_MAP[s]).filter(Boolean);
  const r = await axios.post('https://api.dhan.co/v2/marketfeed/quote',
    { "NSE_EQ": ids },
    {
      headers: {
        'access-token': DHAN_TOKEN,
        'client-id': DHAN_CLIENT_ID,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 15000
    }
  );
  return r.data?.data?.NSE_EQ || {};
}

function parseStock(id, d) {
  const lastPrice = d.last_price || 0;
  const prevClose = d.ohlc?.close || 0;
  const change = parseFloat((d.net_change || (lastPrice - prevClose)).toFixed(2));
  const pct = parseFloat((d.percent_change || calcPct(lastPrice, prevClose)).toFixed(2));
  return {
    symbol: idToSymbol(id),
    price: lastPrice,
    change,
    pct,
    open: d.ohlc?.open || 0,
    high: d.ohlc?.high || 0,
    low: d.ohlc?.low || 0
  };
}

async function fetchMoversData() {
  const stocks = ['RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','SBIN','WIPRO','TATAMOTORS','BAJFINANCE','HINDUNILVR'];
  const nseData = await fetchQuotesBatch(stocks);
  const results = Object.entries(nseData).map(([id, d]) => parseStock(id, d));
  results.sort((a, b) => b.pct - a.pct);
  return {
    gainers: results.slice(0, 5),
    losers: results.slice(-5).reverse(),
    total: results.length,
    updatedAt: new Date().toISOString()
  };
}

function broadcastToClients(data) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(data));
    }
  });
}

// Smart refresh - only during market hours, every 30 seconds
setInterval(async () => {
  if (!isMarketOpen()) return;
  try {
    const data = await fetchMoversData();
    cache.movers = { data, time: Date.now() };
    broadcastToClients({ type: 'movers', data });
    console.log('✅ Pushed to', wss.clients.size, 'clients at', new Date().toISOString());
  } catch (e) {
    console.error('❌ Refresh failed:', e.message);
  }
}, 30000);

wss.on('connection', (ws) => {
  console.log('🔌 Client connected. Total:', wss.clients.size);
  if (cache.movers.data) {
    ws.send(JSON.stringify({ type: 'movers', data: cache.movers.data }));
  }
  ws.on('close', () => {
    console.log('🔌 Disconnected. Total:', wss.clients.size);
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'NiftyRadar Backend Running!',
    time: new Date(),
    marketOpen: isMarketOpen(),
    connectedClients: wss.clients.size
  });
});

app.get('/api/movers', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.movers.data && (now - cache.movers.time) < CACHE_TTL) {
      return res.json(cache.movers.data);
    }
    const data = await fetchMoversData();
    cache.movers = { data, time: now };
    res.json(data);
  } catch (e) {
    console.error('Movers error:', e.message);
    if (cache.movers.data) return res.json({ ...cache.movers.data, cached: true });
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sectors', async (req, res) => {
  try {
    const now = Date.now();
    if (cache.sectors.data && (now - cache.sectors.time) < CACHE_TTL) {
      return res.json(cache.sectors.data);
    }

    const sectors = {
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

    const batch1 = ['TCS','INFY','WIPRO','HCLTECH','TECHM','HDFCBANK','ICICIBANK','SBIN','AXISBANK','KOTAKBANK'];
    const batch2 = ['SUNPHARMA','DRREDDY','CIPLA','TATAMOTORS','MARUTI','HINDUNILVR','ITC','NESTLEIND','TATASTEEL','HINDALCO','JSWSTEEL','RELIANCE','ONGC','NTPC','DLF','GODREJPROP','LT','ULTRACEMCO','ZEEL','SUNTV'];

    const data1 = await fetchQuotesBatch(batch1);
    await new Promise(r => setTimeout(r, 2000));
    const data2 = await fetchQuotesBatch(batch2);
    const nseData = { ...data1, ...data2 };

    const result = {};
    for (const [sector, stocks] of Object.entries(sectors)) {
      result[sector] = { stocks: [], avgChange: 0 };
      let total = 0, count = 0;
      for (const stock of stocks) {
        const id = SECURITY_MAP[stock];
        const d = nseData[id] || nseData[String(id)];
        if (d) {
          const lastPrice = d.last_price || 0;
          const prevClose = d.ohlc?.close || 0;
          const pct = parseFloat((d.percent_change || calcPct(lastPrice, prevClose)).toFixed(2));
          const change = parseFloat((d.net_change || (lastPrice - prevClose)).toFixed(2));
          result[sector].stocks.push({ symbol: stock, price: lastPrice, change, pct });
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

app.get('/api/debug', async (req, res) => {
  try {
    const data = await fetchQuotesBatch(['RELIANCE', 'TCS']);
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`NiftyRadar Backend running on port ${PORT}`));
