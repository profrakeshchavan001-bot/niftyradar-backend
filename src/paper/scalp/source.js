'use strict';
// Binance public 1-minute klines (no key, no orders). Same two hosts as the intraday crypto source; read-only.
function createScalpSource({ axios, hosts = ['https://data-api.binance.vision', 'https://api.binance.com'] }) {
  async function get(pathname, params) {
    let lastErr;
    for (const h of hosts) {
      try { return (await axios.get(`${h}${pathname}`, { params, timeout: 15000 })).data; } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
  return {
    async candles1m(symbol, limit = 120) {
      const rows = await get('/api/v3/klines', { symbol, interval: '1m', limit });
      return rows.map((r) => ({ t: r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] })).filter((k) => [k.t, k.o, k.h, k.l, k.c].every(Number.isFinite));
    },
  };
}
module.exports = { createScalpSource };
