'use strict';
// IST clock helpers. IST is UTC+5:30 all year (no daylight saving).
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istParts(ms = Date.now()) {
  const d = new Date(ms + IST_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0 = Sunday
  };
}

const toMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

// Start of the IST day (as a UTC timestamp in ms) that contains `ms`.
function istDayStart(ms = Date.now()) {
  const shifted = ms + IST_OFFSET_MS;
  return shifted - (shifted % 86400000) - IST_OFFSET_MS;
}

// NSE cash session: Mon-Fri 09:15-15:30 IST, not on a listed holiday.
function nseSession(ms, holidays = []) {
  const p = istParts(ms);
  if (p.dow === 0 || p.dow === 6) return { open: false, reason: 'weekend' };
  if (holidays.includes(p.date)) return { open: false, reason: 'NSE holiday' };
  if (p.minutes < 555 || p.minutes > 930) return { open: false, reason: 'outside 09:15-15:30 IST' };
  return { open: true, reason: '' };
}

module.exports = { istParts, toMinutes, istDayStart, nseSession, IST_OFFSET_MS };
