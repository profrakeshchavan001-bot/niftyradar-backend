const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const DHAN_CLIENT_ID = process.env.DHAN_CLIENT_ID;
const DHAN_TOKEN = process.env.DHAN_TOKEN;

// NSE Security IDs as NUMBERS (Dhan ko integer chahiye!)
const SECURITY_MAP = {
  'RELIANCE':    2885,
  'TCS':         11536,
  'HDFCBANK':    1333,
  'INFY':        1594,
  'ICICIBANK':   4963,
  'SBIN':        3045,
  'WIPRO':       3787,
  'TATAMOTORS':  3456,
  'BAJFINANCE':  317,
  'HINDUNILVR':  1394,
  'HCLTECH':     7229,
  'TECHM':       13538,
  'AXISBANK':    5900,
  'KOTAKBANK':   1922,
  'SUNPHARMA':   3351,
  'DRREDDY':     881,
  'CIPLA':       694,
  'MARUTI':      10999,
  'TATASTEEL':   3499,
  'HINDALCO':    1363,
  'JSWSTEEL':    11723,
  'ONGC':        2475,
  'NTPC':        11630,
  'DLF':         14732,
  'GODREJPROP':  14417,
  'LT':          11483,
  'ULTRACEMCO':  11532,
  'ZEEL':        975,
  'SUNTV':       3290,
  'ITC':         1660,
  'NESTLEIND':   17963,
};

// Dhan API se quotes fetch karo
async function fetchQuotes(symbolList) {
  const ids = symbolList.map(s => SECURITY_MAP[s]).filter(Boolean);

  const body = {
    "NSE_EQ": ids
  };

  console.log('Fetching:', JSON.stringify(body));

  const r = await axios.post('https://api.dhan.co/v2/marketfeed/quote', body, {
    headers: {
      'access-token': DHAN_TOKEN,
      'client-id': DHAN_CLIENT_ID,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
  });

  return r.data;
}

// ID se symbol name dhundho
function idToSymbol(id) {
  const numId = parseInt(id);
  return Object.keys(SECURITY_MAP).find(k => SECURITY_MAP[k] === numId) || id;
}

app.get('/', (req, res) => {
  res.json({ status: 'NiftyRadar Backend Running!', time: new Date() });
});

// /api/movers
app.get('/api/movers', async (req, res) => {
  try {
    const stocks = [
      'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK',
      'SBIN','WIPRO','TATAMOTORS','BAJFINANCE','HINDUNILVR'
    ];

    const raw = await fetchQuotes(stocks);
    console.log('Movers raw:', JSON.stringify(raw).substring(0, 300));

    const nseData = raw?.data?.NSE_EQ || {};

    const results = Object.entries(nseData).map(([id, d]) => ({
      symbol: idToSymbol(id),
      price: d.last_price || 0,
      change: d.net_change || 0,
      pct: d.percent_change || 0,
      open: d.ohlc?.open || 0,
      high: d.ohlc?.high || 0,
      low: d.ohlc?.low || 0,
    }));

    results.sort((a, b) => b.pct - a.pct);

    res.json({
      gainers: results.slice(0, 5),
      losers: results.slice(-5).reverse(),
      total: results.length
    });
  } catch (e) {
    console.error('Movers error:', e.message, JSON.stringify(e.response?.data));
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

// /api/sectors
app.get('/api/sectors', async (req, res) => {
  const sectors = {
    'IT':      ['TCS','INFY','WIPRO','HCLTECH','TECHM'],
    'Banking': ['HDFCBANK','ICICIBANK','SBIN','AXISBANK','KOTAKBANK'],
    'Pharma':  ['SUNPHARMA','DRREDDY','CIPLA'],
    'Auto':    ['TATAMOTORS','MARUTI'],
    'FMCG':   ['HINDUNILVR','ITC','NESTLEIND'],
    'Metal':   ['TATASTEEL','HINDALCO','JSWSTEEL'],
    'Energy':  ['RELIANCE','ONGC','NTPC'],
    'Realty':  ['DLF','GODREJPROP'],
    'Infra':   ['LT','ULTRACEMCO'],
    'Media':   ['ZEEL','SUNTV'],
  };

  try {
    const allStocks = [...new Set(Object.values(sectors).flat())];
    const raw = await fetchQuotes(allStocks);
    const nseData = raw?.data?.NSE_EQ || {};

    const result = {};
    for (const [sector, stocks] of Object.entries(sectors)) {
      result[sector] = { stocks: [], avgChange: 0 };
      let total = 0, count = 0;

      for (const stock of stocks) {
        const id = SECURITY_MAP[stock];
        const d = nseData[id] || nseData[String(id)];
        if (d) {
          const pct = d.percent_change || 0;
          result[sector].stocks.push({
            symbol: stock,
            price: d.last_price || 0,
            change: d.net_change || 0,
            pct
          });
          total += pct;
          count++;
        }
      }
      result[sector].avgChange = count > 0 ? parseFloat((total / count).toFixed(2)) : 0;
    }

    res.json(result);
  } catch (e) {
    console.error('Sectors error:', e.message, JSON.stringify(e.response?.data));
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

// /api/debug - raw response dekho
app.get('/api/debug', async (req, res) => {
  try {
    const raw = await fetchQuotes(['RELIANCE', 'TCS', 'INFY']);
    res.json({ success: true, raw });
  } catch (e) {
    res.status(500).json({ error: e.message, details: e.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NiftyRadar Backend running on port ${PORT}`));
