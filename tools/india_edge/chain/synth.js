/* Deterministic synthetic option chains for tests and the Derivatives Desk until real data is wired in (CC8). Labelled "sample" everywhere. */
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const SYMBOLS = {
  NIFTY: { spot: 24500, step: 50 }, BANKNIFTY: { spot: 53200, step: 100 }, FINNIFTY: { spot: 23400, step: 50 },
  RELIANCE: { spot: 1420, step: 20 }, HDFCBANK: { spot: 1010, step: 10 }, INFY: { spot: 1620, step: 20 },
};

function synthChain(symbol, asOf, { seed = 1, drift = 0 } = {}) {
  const cfg = SYMBOLS[symbol];
  if (!cfg) throw new RangeError(`unknown symbol ${symbol}`);
  const rnd = rng(seed * 7919 + symbol.length * 31 + symbol.charCodeAt(0));
  const spot = Math.round(cfg.spot * (1 + drift) / cfg.step) * cfg.step;
  const rows = [];
  for (let i = -12; i <= 12; i++) {
    const strike = spot + i * cfg.step, dist = Math.abs(i);
    const base = 100000 * Math.exp(-dist / 6) * (0.6 + rnd() * 0.8);
    const tilt = (k) => (k === 'pe' ? (i < 0 ? 1.4 : 0.6) : (i > 0 ? 1.4 : 0.6));
    const mk = (k) => {
      const oi = Math.round(base * tilt(k)), vol = Math.round(oi * (0.5 + rnd() * 1.5));
      const intrinsic = k === 'ce' ? Math.max(0, spot - strike) : Math.max(0, strike - spot);
      const time = cfg.step * 3 * Math.exp(-dist / 4);
      return { oi, vol, oiChg: Math.round(oi * (rnd() * 0.5 - 0.15)), ltp: Math.round((intrinsic + time) * 100) / 100 };
    };
    rows.push({ strike, ce: mk('ce'), pe: mk('pe') });
  }
  return { symbol, asOf, expiry: '2026-11-27', spot, rows };
}

function synthParticipants(seed = 1) {
  const rnd = rng(seed * 104729);
  const mk = () => ({ longs: Math.round(60000 + rnd() * 80000), shorts: Math.round(60000 + rnd() * 80000) });
  return { fii: mk(), pro: mk() };
}

module.exports = { SYMBOLS, synthChain, synthParticipants };
