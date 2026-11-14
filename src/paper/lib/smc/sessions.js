'use strict';
// Trading sessions. CC2 round 2 item 2.
//   crypto: Asia / London / New York, by UTC hour (round-the-clock market,
//     so these are non-overlapping clock bands, not a claim about real
//     institutional session overlap - a simplifying, documented assumption).
//   NSE: open drive / lunch / close, by IST minutes-since-midnight (same
//     unit paperbot/time.js istParts().minutes already uses).
const { istParts } = require('../../../../paperbot/time');

// ms (UTC) -> 'asia' [00:00-08:00) | 'london' [08:00-13:00) | 'new_york' [13:00-21:00) | 'after_hours' [21:00-24:00)
function cryptoSession(ms) {
  const hour = new Date(ms).getUTCHours();
  if (hour < 8) return 'asia';
  if (hour < 13) return 'london';
  if (hour < 21) return 'new_york';
  return 'after_hours';
}

// ms (any) -> NSE session label, using the IST minute-of-day (paperbot/time.js istParts)
//   'closed'      outside 09:15-15:30 IST
//   'open_drive'  09:15-09:45 IST (first 30 minutes)
//   'lunch'       12:00-13:00 IST
//   'close'       15:00-15:30 IST (last 30 minutes)
//   'mid_session' everything else inside market hours
function nseDaySession(ms) {
  const m = istParts(ms).minutes;
  if (m < 555 || m > 930) return 'closed';
  if (m < 585) return 'open_drive';
  if (m >= 900) return 'close';
  if (m >= 720 && m < 780) return 'lunch';
  return 'mid_session';
}

module.exports = { cryptoSession, nseDaySession };
