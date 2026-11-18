'use strict';
// GROUP 3 (confluence_flow bot): order-flow reading from Binance's PUBLIC REST market data - the exact
// same exchange, same no-key/no-order public endpoints paperbot/sources.js's createCryptoSource() already
// uses for candles (data-api.binance.vision / api.binance.com). This is not a new exchange integration:
// it reads two more public endpoints on the same host (depth snapshot, recent trades) that bot already
// calls against. No order is ever placed; no websocket is opened - a handful of REST samples over the
// trailing window are enough for a directional read, which is all confluence_flow needs.
const DEFAULT_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];

const round = (x, n = 4) => (Number.isFinite(x) ? Math.round(x * 10 ** n) / 10 ** n : null);

// Bid/ask imbalance over the top `depth` levels of the order book: +1 = all bids, -1 = all asks, 0 = even.
function imbalance(bids, asks, depth) {
  const b = (bids || []).slice(0, depth).reduce((s, [, q]) => s + Number(q), 0);
  const a = (asks || []).slice(0, depth).reduce((s, [, q]) => s + Number(q), 0);
  if (!(b + a > 0)) return 0;
  return (b - a) / (b + a);
}

function createOrderFlow({ axios, log = console.log, now = Date.now, hosts = DEFAULT_HOSTS, timeoutMs = 6000 }) {
  const trailing = new Map(); // symbol -> [{ t, qty, isBuyerMaker }], kept to ~125s

  async function get(pathname, params) {
    let lastErr;
    for (const h of hosts) {
      try { return (await axios.get(`${h}${pathname}`, { params, timeout: timeoutMs })).data; } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  async function depthSnapshot(symbol, limit = 20) {
    const d = await get('/api/v3/depth', { symbol, limit });
    return { bids: d.bids || [], asks: d.asks || [] };
  }

  async function recentTrades(symbol, limit = 500) {
    const rows = await get('/api/v3/trades', { symbol, limit });
    return rows.map((t) => ({ t: t.time, qty: Number(t.qty), isBuyerMaker: !!t.isBuyerMaker }));
  }

  function recordTrades(symbol, trades) {
    const list = trailing.get(symbol) || [];
    const cutoff = now() - 125000; // a little over the widest (120s) window
    trailing.set(symbol, [...list, ...trades].filter((x) => x.t >= cutoff));
  }

  // Aggressor delta (CVD) over the trailing `windowMs`: a taker BUY (isBuyerMaker === false, the resting
  // order was a sell, so the taker bought) adds qty; a taker sell subtracts it.
  function cvd(symbol, windowMs) {
    const list = trailing.get(symbol) || [];
    const cutoff = now() - windowMs;
    let delta = 0;
    for (const t of list) { if (t.t < cutoff) continue; delta += t.isBuyerMaker ? -t.qty : t.qty; }
    return delta;
  }

  /**
   * One order-flow reading for `symbol`: { direction: 'buy'|'sell'|'neutral', strength (0-1), detail }.
   * `detail` carries the raw numbers (top5/top10 book imbalance, 30/60/120s aggressor delta) for the
   * Telegram alert and the shadow-log sample (Group 4's own small persisted table). Never throws - a feed
   * failure returns neutral with strength 0 and the error, exactly like every other source in this repo
   * that degrades rather than crashes the bot loop.
   */
  async function read(symbol) {
    try {
      const [depth, trades] = await Promise.all([depthSnapshot(symbol, 20), recentTrades(symbol, 500)]);
      recordTrades(symbol, trades);
      const top5 = imbalance(depth.bids, depth.asks, 5);
      const top10 = imbalance(depth.bids, depth.asks, 10);
      const d30 = cvd(symbol, 30000);
      const d60 = cvd(symbol, 60000);
      const d120 = cvd(symbol, 120000);
      const bookScore = (top5 + top10) / 2;
      const cvdScore = d60 === 0 ? 0 : Math.sign(d60) * Math.min(1, Math.abs(d60) / (Math.abs(d60) + 1));
      const score = bookScore * 0.5 + cvdScore * 0.5;
      const direction = score > 0.1 ? 'buy' : score < -0.1 ? 'sell' : 'neutral';
      const strength = Math.min(1, Math.abs(score));
      return {
        direction, strength: round(strength, 2),
        detail: { top5: round(top5), top10: round(top10), cvd30: round(d30, 2), cvd60: round(d60, 2), cvd120: round(d120, 2) },
      };
    } catch (e) {
      log(`[orderFlow] ${symbol} read failed: ${e.response?.status || e.message}`);
      return { direction: 'neutral', strength: 0, error: e.message };
    }
  }

  return { read, depthSnapshot, recentTrades, imbalance, cvd };
}

module.exports = { createOrderFlow, imbalance };
