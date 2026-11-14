'use strict';
// Displacement candle: a body much bigger than the average of the candles
// before it - the kind of move that leaves an order block / FVG behind it.
// CC2 round 2 item 2.
const { body, avg, isGreen, isRed, round } = require('../indicators');

// `candles`: closed candles, oldest first. Looks at the LAST candle only,
// against the average body of the `look` candles before it (never itself).
function isDisplacement(candles, opt = {}) {
  const look = opt.look || 5;
  const mult = opt.mult || 2;
  if (!candles || candles.length < look + 1) return null;
  const last = candles[candles.length - 1];
  const prior = candles.slice(-(look + 1), -1);
  const avgBody = avg(prior.map(body));
  if (!(avgBody > 0)) return null;
  const bodyRatio = round(body(last) / avgBody, 2);
  return { displaced: body(last) >= mult * avgBody, bodyRatio, direction: isGreen(last) ? 'up' : isRed(last) ? 'down' : 'flat' };
}

module.exports = { isDisplacement };
