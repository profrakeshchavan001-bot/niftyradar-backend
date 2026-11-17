'use strict';
// Market-hours gate for the NSE currency derivatives segment (USDINR/EURINR/GBPINR/JPYINR futures),
// reused by the four ccy_* bots (src/paper/bots/ccy_usdinr/ etc) and their mirrors.
//
// Currency futures trade Mon-Fri 09:00-17:00 IST on the NSE currency segment (wider than the NSE CASH
// session 09:15-15:30 that paperbot/time.js's nseSession() already gates - a separate function on
// purpose, so this never changes that bot's own hours) and follow the SAME NSE trading-holiday calendar
// as NSE equities (the task's own instruction, and NSE publishes one shared holiday list for cash +
// currency + equity derivatives - paperbot/config.js DEFAULTS.nse.holidays is reused as-is, never copied,
// so one list stays the single source of truth; the caller passes it in, exactly like nseSession() does).
//
// Like paperbot/time.js's nseJobWindow(), ccyJobWindow() is a cheap, database-free check (weekday/time
// only, no holiday list needed) meant to run FIRST on every cron tick so a weekend or overnight tick
// costs nothing beyond a clock read; the real open/closed decision (ccySession(), holiday-aware) runs
// inside the bot's own scan() once the config (and its holiday list) has been loaded - same two-step
// convention as the NSE cash bot, so a currency bot never produces a "has not scanned" alert outside
// hours: callers skip silently (optionally logging once per day) when either check says closed.
const { istParts } = require('../../../paperbot/time');

const SESSION_START_MIN = 9 * 60; // 09:00 IST
const SESSION_END_MIN = 17 * 60; // 17:00 IST
const JOB_WINDOW_START_MIN = SESSION_START_MIN - 15; // 08:45 IST - small buffer either side, same idea as nseJobWindow()
const JOB_WINDOW_END_MIN = SESSION_END_MIN + 15; // 17:15 IST

// Cheap weekday/time-only gate (deliberately NOT holiday-aware - same convention as nseJobWindow()).
function ccyJobWindow(ms) {
  const p = istParts(ms);
  if (p.dow === 0 || p.dow === 6) return { open: false, reason: 'weekend' };
  if (p.minutes < JOB_WINDOW_START_MIN || p.minutes > JOB_WINDOW_END_MIN) return { open: false, reason: 'outside 08:45-17:15 IST job window' };
  return { open: true, reason: '' };
}

// Real NSE currency-segment session: Mon-Fri 09:00-17:00 IST, not on a listed (NSE equity/cash) holiday.
// `holidays` is the caller's own loaded list (paperbot/config.js DEFAULTS.nse.holidays via loadConfig, or
// the raw defaults in a test) - this function never reads or stores a holiday list of its own.
function ccySession(ms, holidays = []) {
  const p = istParts(ms);
  if (p.dow === 0 || p.dow === 6) return { open: false, reason: 'weekend' };
  if (holidays.includes(p.date)) return { open: false, reason: 'NSE holiday' };
  if (p.minutes < SESSION_START_MIN || p.minutes > SESSION_END_MIN) return { open: false, reason: 'outside 09:00-17:00 IST' };
  return { open: true, reason: '' };
}

module.exports = { ccyJobWindow, ccySession, SESSION_START_MIN, SESSION_END_MIN };
