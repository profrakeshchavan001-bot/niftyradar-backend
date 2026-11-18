'use strict';
// Group 1 (2026-11): generic "retry with backoff, then at most one alert per day" wrapper, pulled out of
// server.js so it is unit-testable with fakes (no real timers, no real Telegram, no real Dhan call) -
// server.js wires its own renewDhanToken() and the real Telegram sender into this. Every dependency is
// injected (sleep/now/sendAlert/dateKeyOf), so a test can drive it deterministically.
//
// renewFn(): async () => { ok: boolean, error?: any } - the thing being retried (server.js's
// renewDhanToken). delaysMs: backoff between attempts after the first failure (does not delay before
// the FIRST attempt). sendAlert(lastError): called at most ONCE per calendar day (dateKeyOf(now())) -
// once every attempt for a call is exhausted and an alert has already gone out for today, no further
// alert is sent that day even if a later call also fails (a 6-hourly cron that stays broken all day
// must not spam Telegram six times). The retrier tracks the already-alerted day via its own closure
// state, not a database (a restart naturally resets it, same as every other in-memory-only guard in
// this repo when there is no store to persist it in) - acceptable here since a restart is rare and the
// cost of one possible extra alert around a restart is far smaller than silence.
function createRenewRetrier({ renewFn, sendAlert, delaysMs = [30000, 120000, 300000], sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date(), dateKeyOf = (d) => d.toISOString().slice(0, 10), log = () => {} }) {
  let lastAlertDateKey = null;

  async function renewWithRetry() {
    let result = await renewFn();
    for (let i = 0; i < delaysMs.length && !result.ok; i++) {
      await sleep(delaysMs[i]);
      log(`retry ${i + 1}/${delaysMs.length} after failure: ${typeof result.error === 'string' ? result.error : JSON.stringify(result.error)}`);
      result = await renewFn();
    }
    if (result.ok) return result; // a success is never alerted
    const today = dateKeyOf(now());
    if (lastAlertDateKey !== today) {
      await sendAlert(result.error);
      lastAlertDateKey = today;
    }
    return result;
  }

  return { renewWithRetry };
}

module.exports = { createRenewRetrier };
