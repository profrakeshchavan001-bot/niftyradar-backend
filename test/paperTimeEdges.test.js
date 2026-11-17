'use strict';
// CC2 overnight extra: IST/UTC edge tests at 09:15, 15:15, 15:30 and midnight.
// IST = UTC+5:30 all year (no DST), so every UTC time below is the IST clock
// time minus 5:30. Monday 16 Nov 2026 is used throughout (not a holiday, not
// a weekend) so nseSession's own day-of-week/holiday checks stay out of the way.
const test = require('node:test');
const assert = require('node:assert/strict');
const { istParts, istDayStart, nseSession, nseJobWindow } = require('../paperbot/time');

const utc = (h, m = 0, s = 0, day = 16) => Date.UTC(2026, 10, day, h, m, s);

test('09:15 IST (the open): minutes 555, market open, 1 second before it is still closed', () => {
  // 09:15 IST = 09:15 - 05:30 = 03:45 UTC
  const open = utc(3, 45, 0);
  assert.deepEqual([istParts(open).hhmm, istParts(open).minutes], ['09:15', 555]);
  assert.equal(nseSession(open).open, true);
  assert.equal(nseSession(open - 1000).open, false); // 09:14:59 IST
});

test('15:15 IST: minutes 915, still open (15 minutes before the close)', () => {
  // 15:15 IST = 15:15 - 05:30 = 09:45 UTC
  const t = utc(9, 45, 0);
  assert.deepEqual([istParts(t).hhmm, istParts(t).minutes], ['15:15', 915]);
  assert.equal(nseSession(t).open, true);
});

test('15:30 IST (the close): minutes 930, the whole 15:30 minute counts as open; 15:31 is closed', () => {
  // 15:30 IST = 15:30 - 05:30 = 10:00 UTC. `minutes` is whole-minute resolution (seconds are
  // dropped), so the session stays open for the entire 15:30:00-15:30:59 minute and only closes
  // at the next whole minute, 15:31 IST - not 1 second after 15:30:00.
  const close = utc(10, 0, 0);
  assert.deepEqual([istParts(close).hhmm, istParts(close).minutes], ['15:30', 930]);
  assert.equal(nseSession(close).open, true, 'the close minute itself is still inside the session (< / > compare, not <=)');
  assert.equal(nseSession(close + 59000).open, true, '15:30:59 IST is still the 15:30 minute');
  const after = nseSession(close + 60000); // 15:31:00 IST
  assert.deepEqual([after.open, after.reason], [false, 'outside 09:15-15:30 IST']);
});

test('midnight IST: the IST day rolls over 5:30 BEFORE UTC midnight, not at it', () => {
  // Midnight IST on 16 Nov 2026 is 18:30 UTC on 15 Nov 2026 (one IST day = one IST date; the UTC date is still the 15th at that instant)
  const midnightIst = Date.UTC(2026, 10, 15, 18, 30, 0);
  const p = istParts(midnightIst);
  assert.deepEqual([p.hhmm, p.minutes, p.date], ['00:00', 0, '2026-11-16']);
  // 1 second earlier is still 23:59:59 IST on the 15th
  const before = istParts(midnightIst - 1000);
  assert.deepEqual([before.hhmm, before.date], ['23:59', '2026-11-15']);
  // istDayStart of any time during 16 Nov IST must land exactly back on this instant
  assert.equal(istDayStart(midnightIst + 3600000), midnightIst); // 1 hour into the day
  assert.equal(istDayStart(utc(10, 0, 0)), midnightIst); // 15:30 IST the same day
});

test('nseSession: 09:15-15:30 IST holds across the UTC date line (UTC midnight falls at 05:30 IST, mid-session)', () => {
  // UTC midnight on 16 Nov 2026 = 05:30 IST on 16 Nov - before the 09:15 open, same IST day
  const utcMidnight = Date.UTC(2026, 10, 16, 0, 0, 0);
  const p = istParts(utcMidnight);
  assert.deepEqual([p.hhmm, p.date], ['05:30', '2026-11-16']);
  assert.equal(nseSession(utcMidnight).open, false); // before 09:15 IST
});

test('nseSession: Saturday and Sunday are closed at every hour, even 09:15-15:30', () => {
  const satOpenHour = Date.UTC(2026, 10, 14, 3, 45, 0); // Sat 14 Nov 2026, 09:15 IST
  const sunOpenHour = Date.UTC(2026, 10, 15, 3, 45, 0); // Sun 15 Nov 2026, 09:15 IST
  assert.deepEqual([nseSession(satOpenHour).open, nseSession(satOpenHour).reason], [false, 'weekend']);
  assert.deepEqual([nseSession(sunOpenHour).open, nseSession(sunOpenHour).reason], [false, 'weekend']);
});

test('nseSession: a listed holiday closes the market even at 09:15 IST on a weekday', () => {
  const t = utc(3, 45, 0); // Monday 16 Nov 2026, 09:15 IST
  assert.deepEqual([nseSession(t, ['2026-11-16']).open, nseSession(t, ['2026-11-16']).reason], [false, 'NSE holiday']);
  assert.equal(nseSession(t, ['2026-11-24']).open, true); // a different holiday date does not affect this day
});

// nseJobWindow: the buffered 09:00-15:45 IST window nseScan/nseMonitor check BEFORE touching the
// database (root cause of the Neon compute waste - see paperbot/time.js and paperbot/bot.js). It is
// deliberately wider than nseSession and deliberately NOT holiday-aware (see its own header comment).
test('nseJobWindow: 09:00 IST open, 08:59 IST closed (the 15-minute pre-open buffer)', () => {
  const open = utc(3, 30, 0); // 09:00 IST
  assert.equal(nseJobWindow(open).open, true);
  assert.equal(nseJobWindow(open - 1000).open, false); // 08:59:59 IST
});

test('nseJobWindow: 15:45 IST still open (the whole minute), 15:46 IST closed (the 15-minute post-close buffer)', () => {
  const t = utc(10, 15, 0); // 15:45 IST
  assert.equal(nseJobWindow(t).open, true);
  assert.equal(nseJobWindow(t + 59000).open, true); // 15:45:59 IST
  assert.equal(nseJobWindow(t + 60000).open, false); // 15:46:00 IST
});

test('nseJobWindow: wider than nseSession on both edges (09:05 and 15:40 IST are job-window-open, session-closed)', () => {
  const preOpen = utc(3, 35, 0); // 09:05 IST: before the 09:15 session open
  const postClose = utc(10, 10, 0); // 15:40 IST: after the 15:30 session close
  assert.deepEqual([nseJobWindow(preOpen).open, nseSession(preOpen).open], [true, false]);
  assert.deepEqual([nseJobWindow(postClose).open, nseSession(postClose).open], [true, false]);
});

test('nseJobWindow: Saturday and Sunday are closed at every hour, even 09:00-15:45', () => {
  const satOpenHour = Date.UTC(2026, 10, 14, 3, 30, 0); // Sat 14 Nov 2026, 09:00 IST
  const sunOpenHour = Date.UTC(2026, 10, 15, 3, 30, 0); // Sun 15 Nov 2026, 09:00 IST
  assert.deepEqual([nseJobWindow(satOpenHour).open, nseJobWindow(satOpenHour).reason], [false, 'weekend']);
  assert.deepEqual([nseJobWindow(sunOpenHour).open, nseJobWindow(sunOpenHour).reason], [false, 'weekend']);
});

test('nseJobWindow: NOT holiday-aware by itself (a listed NSE holiday still reads open; nseScan still checks nseSession for that)', () => {
  const t = utc(3, 45, 0); // Monday 16 Nov 2026, 09:15 IST, pretend-listed as a holiday below
  assert.equal(nseJobWindow(t).open, true);
  assert.equal(nseSession(t, ['2026-11-16']).open, false); // the real holiday gate, checked separately inside nseScan
});
