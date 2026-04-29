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

app.get('/api/movers', async (req, res) => {
  try {
    const stocks = ['RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','SBIN','WIPRO','TATAMOTORS','BAJFINANCE','HINDUNILVR'];
    const results = [];
    for (const stock of stocks) {
      try {
        const r = await axios.get('https://api.dhan.co/v2/marketfeed/quote', {
          headers: { 'access-token': DHAN_TOKEN, 'client-id': DHAN_CLIENT_ID },
          params: { NSE: stock }
        });
        if (r.data) {
          const d = r.data.data?.[stock] || r.data;
          results.push({ symbol: stock, price: d.last_price || 0, change: d.net_change || 0, pct: d.percent_change || 0 });
        }
      } catch {}
    }
    results.sort((a, b) => b.pct - a.pct);
    res.json({ gainers: results.slice(0, 5), losers: results.slice(-5).reverse() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sectors', async (req, res) => {
  const sectors = {
    'IT': ['TCS','INFY','WIPRO','HCLTECH','TECHM'],
    'Banking': ['HDFCBANK','ICICIBANK','SBIN','AXISBANK','KOTAKBANK'],
    'Pharma': ['SUNPHARMA','DRREDDY','CIPLA'],
    'Auto': ['TATAMOTORS','MARUTI','M&M'],
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
      try {
        const r = await axios.get('https://api.dhan.co/v2/marketfeed/quote', {
          headers: { 'access-token': DHAN_TOKEN, 'client-id': DHAN_CLIENT_ID },
          params: { NSE: stock }
        });
        const d = r.data.data?.[stock] || r.data;
        const pct = d.percent_change || 0;
        result[sector].stocks.push({ symbol: stock, price: d.last_price || 0, pct });
        total += pct; count++;
      } catch {}
    }
    result[sector].avgChange = count > 0 ? (total/count).toFixed(2) : 0;
  }
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`NiftyRadar Backend running on port ${PORT}`));
