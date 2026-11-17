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

// Buffered NSE job window: Mon-Fri 09:00-15:45 IST (the 15-min buffer either side of the real
// 09:15-15:30 session, for open/close handling), weekday/time only - deliberately NOT holiday-aware.
// This is the cheap, database-free gate nseScan/nseMonitor check FIRST, before loadConfig() even
// reads the holiday list, so a weekend or an overnight tick costs nothing beyond a clock read (root
// cause of the Neon compute waste: every cron tick used to hit the database before checking the time).
// The real market-open decision (session.open, including holidays) still happens inside nseScan via
// nseSession() once cfg.nse.holidays is loaded; this window is only ever wider, never narrower.
function nseJobWindow(ms) {
  const p = istParts(ms);
  if (p.dow === 0 || p.dow === 6) return { open: false, reason: 'weekend' };
  if (p.minutes < 540 || p.minutes > 945) return { open: false, reason: 'outside 09:00-15:45 IST job window' };
  return { open: true, reason: '' };
}

// MCX commodity session (gold/crude futures, non-agri): Mon-Fri 09:00-23:30 IST, not on a listed MCX
// holiday. Same shape and convention as nseSession() above, just a different window and its own holiday
// list (MCX holidays are not identical to NSE's - each bot passes its own cfg.holidays).
function mcxSession(ms, holidays = []) {
  const p = istParts(ms);
  if (p.dow === 0 || p.dow === 6) return { open: false, reason: 'weekend' };
  if (holidays.includes(p.date)) return { open: false, reason: 'MCX holiday' };
  if (p.minutes < 540 || p.minutes > 1410) return { open: false, reason: 'outside 09:00-23:30 IST MCX session' };
  return { open: true, reason: '' };
}

module.exports = { istParts, toMinutes, istDayStart, nseSession, nseJobWindow, mcxSession, IST_OFFSET_MS };
