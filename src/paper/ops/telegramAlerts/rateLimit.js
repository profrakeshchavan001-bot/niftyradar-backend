'use strict';
/**
 * Add-on v2 item 4: 30 messages/hour; beyond that, one digest message per 10 minutes instead of one per
 * event. Pure, injectable clock - no setTimeout, no store. Ephemeral (resets on redeploy): the real
 * "never send the same trade event twice" guarantee is the DB dedupe in register.js, not this counter.
 */
const HOUR_MS = 3600000;
const DIGEST_WINDOW_MS = 10 * 60000;

function createRateLimiter({ now = Date.now, maxPerHour = 30, digestWindowMs = DIGEST_WINDOW_MS } = {}) {
  const sentAt = []; // timestamps of messages actually sent in the last hour
  let pendingDigest = []; // texts held back since the last digest flush
  let lastDigestAt = 0;

  function prune(t) { while (sentAt.length && t - sentAt[0] > HOUR_MS) sentAt.shift(); }

  /**
   * Call once per message that wants to go out. Returns one of:
   *  { action: 'send' } - under the hourly cap, send it now.
   *  { action: 'hold' } - over the cap; held for the next digest, nothing sent now.
   *  { action: 'digest', text } - over the cap AND the digest window has elapsed: send this combined text
   *    (the held messages + this one), clearing the held list.
   */
  function take(text) {
    const t = now();
    prune(t);
    if (sentAt.length < maxPerHour) { sentAt.push(t); return { action: 'send' }; }
    pendingDigest.push(text);
    if (t - lastDigestAt < digestWindowMs) return { action: 'hold' };
    lastDigestAt = t;
    const combined = `⚠️ ${pendingDigest.length} trade alert(s) in the last few minutes (rate limit, 30/hour):\n\n${pendingDigest.join('\n---\n')}`;
    pendingDigest = [];
    return { action: 'digest', text: combined };
  }

  return { take, _sentCount: () => sentAt.length };
}

module.exports = { createRateLimiter, HOUR_MS, DIGEST_WINDOW_MS };
