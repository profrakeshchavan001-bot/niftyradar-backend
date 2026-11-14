'use strict';
// Exit accuracy against every candle's high/low since the last check (CC2
// overnight item 3), not only the latest tick price. Pure function, no I/O.
//
// Problem this fixes: the old crypto monitor checked the stop/target only
// against the single live price read once a minute, so a spike that hit the
// target (or stop) between two checks was missed entirely. This walks every
// closed candle since entry in order and books the exit at the level itself
// (target or stop), not at whatever price happened to be showing at the next
// poll - a more accurate (and, if anything, more conservative) fill.
//
// If a candle's high AND low both reach the target and the stop (a wide
// candle, or a stop that is close to the entry), the stop is booked: we
// cannot know from OHLC alone which was touched first, so the brief's rule
// is to assume the worse outcome.
function simulateExit({ entry, target, stop, short = false, breakevenAt = 0.5, breakevenDone = false, candles = [] }) {
  let stopActive = stop;
  let doneBE = !!breakevenDone;
  for (const k of candles) {
    const hitStop = short ? k.h >= stopActive : k.l <= stopActive;
    const hitTarget = short ? k.l <= target : k.h >= target;
    if (hitStop && hitTarget) {
      return { exit: true, reason: doneBE ? 'breakeven_stop' : 'stop', price: stopActive, candle: k, bothHitSameCandle: true, breakevenDone: doneBE, stopActive };
    }
    if (hitTarget) return { exit: true, reason: 'target', price: target, candle: k, breakevenDone: doneBE, stopActive };
    if (hitStop) return { exit: true, reason: doneBE ? 'breakeven_stop' : 'stop', price: stopActive, candle: k, breakevenDone: doneBE, stopActive };
    if (!doneBE) {
      const dir = short ? -1 : 1;
      const favourableExtreme = short ? k.l : k.h;
      const progress = (favourableExtreme - entry) * dir;
      const needed = breakevenAt * Math.abs(target - entry);
      if (progress >= needed) { doneBE = true; stopActive = entry; }
    }
  }
  const movedToBreakeven = doneBE && stopActive !== stop && !breakevenDone;
  return { exit: false, action: movedToBreakeven ? 'breakeven' : 'hold', breakevenDone: doneBE, stopActive };
}

module.exports = { simulateExit };
