const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID;
const DHAN_TOKEN = process.env.DHAN_TOKEN;

app.get('/', (req, res) => {
  res.json({ status: 'NiftyRadar Backend Running!', time: new Date() });
});

// Helper: Dhan API se ek stock ka data fetch karo
async function fetchStockData(stock) {
  try {
    const r = await axios.get('https://api.dhan.co/v2/marketfeed/quote', {
      headers: {
        'access-token': DHAN_TOKEN,
        'client-id': DHAN_CLIENT_ID,
        'Content-Type': 'application/json'
      },
      params: { NSE: stock }
    });

    const raw = r.data;

    // Dhan API possible response formats:
    // Format 1: { "NSE:RELIANCE": { ltp, netChange, percentChange } }
    // Format 2: { data: { "NSE:RELIANCE": { ... } } }
    // Format 3: { ltp, netChange, percentChange } (direct)

    let d = null;

    // Format 1 check
    const key1 = `NSE:${stock}`;
    if (raw[key1]) {
      d = raw[key1];
    }
    // Format 2 check
    else if (raw.data && raw.data[key1]) {
      d = raw.data[key1];
    }
    // Format 2 with plain stock name
    else if (raw.data && raw.data[stock]) {
      d = raw.data[stock];
    }
    // Format 3 - direct object
    else if (raw.ltp || raw.last_price) {
      d = raw;
    }
    // Last resort - first key ki value le lo
    else {
      const keys = Object.keys(raw);
      if (keys.length > 0) {
        d = raw[keys[0]];
      }
    }

    if (!d) return null;

    // Different field names handle karo
    const price = d.ltp || d.last_price || d.lastPrice || 0;
    const change = d.netChange || d.net_change || d.change || 0;
    const pct = d.percentChange || d.percent_change || d.pctChange || 0;

    return { symbol: stock, price, change, pct };
  } catch (err) {
    console.error(`Error fetching ${stock}:`, err.message);
    return null;
  }
}

app.get('/api/movers', async (req, res) => {
  try {
    const stocks = [
      'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK',
      'SBIN','WIPRO','TATAMOTORS','BAJFINANCE','HINDUNILVR'
    ];

    const results = [];
    for (const stock of stocks) {
      const data = await fetchStockData(stock);
      if (data) results.push(data);
    }

    results.sort((a, b) => b.pct - a.pct);

    res.json({
      gainers: results.slice(0, 5),
      losers: results.slice(-5).reverse(),
      total: results.length
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/sectors', async (req, res) => {
  const sectors = {
    'IT': ['TCS','INFY','WIPRO','HCLTECH','TECHM'],
    'Banking': ['HDFCBANK','ICICIBANK','SBIN','AXISBANK','KOTAKBANK'],
    'Pharma': ['SUNPHARMA','DRREDDY','CIPLA'],
    'Auto': ['TATAMOTORS','MARUTI'],
    'FMCG': ['HINDUNILVR','ITC','NESTLEIND'],
    'Metal': ['TATASTEEL','HINDALCO','JSWSTEEL'],
    'Energy': ['RELIANCE','ONGC','NTPC'],
    'Realty': ['DLF','GODREJPROP'],
    'Infra': ['LT','ULTRACEMCO'],
    'Media': ['ZEEL','SUNTV']
  };

  const result = {};

  for (const [sector, stocks] of Object.entries(sectors)) {
    result[sector] = { stocks: [], avgChange: 0 };
    let total = 0, count = 0;

    for (const stock of stocks) {
      const data = await fetchStockData(stock);
      if (data) {
        result[sector].stocks.push(data);
        total += data.pct;
        count++;
      }
    }

    result[sector].avgChange = count > 0 ? parseFloat((total / count).toFixed(2)) : 0;
  }

  res.json(result);
});

// Debug route - Dhan API raw response dekho
app.get('/api/debug/:stock', async (req, res) => {
  try {
    const stock = req.params.stock.toUpperCase();
    const r = await axios.get('https://api.dhan.co/v2/marketfeed/quote', {
      headers: {
        'access-token': DHAN_TOKEN,
        'client-id': DHAN_CLIENT_ID,
        'Content-Type': 'application/json'
      },
      params: { NSE: stock }
    });
    res.json({ stock, rawResponse: r.data });
  } catch (e) {
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NiftyRadar Backend running on port ${PORT}`));
