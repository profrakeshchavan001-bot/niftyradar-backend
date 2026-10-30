const { Router } = require('express');
const { analyse, bigScreeners } = require('../../tools/india_edge/chain/index.js');
const { SYMBOLS, synthChain, synthParticipants } = require('../../tools/india_edge/chain/synth.js');

const DESK_DISCLAIMER = 'Option-chain positioning statistics only. Not investment advice. Sample data until the live feed is connected.';

// Fixture-backed loader. A live loader (CC8) replaces this one and returns the same shape: { snap, prev, participants, prevParticipants }.
const defaultDeps = {
  symbols: () => Object.keys(SYMBOLS),
  load: async (symbol) => ({
    snap: synthChain(symbol, '2026-10-29', { seed: 2, drift: 0.004 }),
    prev: synthChain(symbol, '2026-10-28', { seed: 1 }),
    participants: synthParticipants(2), prevParticipants: synthParticipants(1),
  }),
};

/**
 * GET /api/derivs/desk?symbol=NIFTY -> levels, reversal price, shift flags, triple/power levels, 8-signal score, FII+Pro pulse, Big Bull/Bear screeners.
 * Public market data (not per-user), open behind the site gate. Results only: no weights or thresholds are sent.
 */
function createDerivsDeskRouter(deps = defaultDeps) {
  const router = Router();
  router.get('/derivs/desk', async (req, res, next) => {
    try {
      const names = deps.symbols();
      const raw = req.query.symbol === undefined ? names[0] : req.query.symbol;
      const symbol = typeof raw === 'string' ? raw.toUpperCase() : '';
      if (!/^[A-Z]{2,12}$/.test(symbol) || !names.includes(symbol)) return res.status(400).json({ error: 'unknown symbol', symbols: names });
      const d = await deps.load(symbol);
      const all = await Promise.all(names.map(async (n) => (n === symbol ? d.snap : (await deps.load(n)).snap)));
      res.set('Cache-Control', 'public, max-age=60');
      res.json({
        source: 'sample', disclaimer: DESK_DISCLAIMER, symbols: names,
        ...analyse(d.snap, d.prev, d.participants, d.prevParticipants),
        screeners: bigScreeners(all),
        strikes: d.snap.rows.map((r) => ({ strike: r.strike, ceOi: r.ce.oi, peOi: r.pe.oi, ceChg: r.ce.oiChg, peChg: r.pe.oiChg })),
      });
    } catch (err) { next(err); }
  });
  return router;
}
module.exports = { createDerivsDeskRouter, defaultDeps, DESK_DISCLAIMER };
