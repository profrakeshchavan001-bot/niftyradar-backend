'use strict';
// Add-on v2 item 4: 30 messages/hour, then one digest per 10 minutes (src/paper/ops/telegramAlerts/rateLimit.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/paper/ops/telegramAlerts/rateLimit');

test('first 30 messages in an hour all send immediately', () => {
  let t = 0;
  const rl = createRateLimiter({ now: () => t, maxPerHour: 30 });
  for (let i = 0; i < 30; i++) { t += 1000; assert.deepEqual(rl.take(`m${i}`), { action: 'send' }); }
  assert.equal(rl._sentCount(), 30);
});

test('the 31st message within the hour is held, not sent, until a digest window elapses', () => {
  let t = 0;
  const rl = createRateLimiter({ now: () => t, maxPerHour: 2, digestWindowMs: 600000 });
  assert.deepEqual(rl.take('a'), { action: 'send' });
  assert.deepEqual(rl.take('b'), { action: 'send' });
  t += 1000;
  assert.deepEqual(rl.take('c'), { action: 'hold' }); // over cap, digest window not elapsed yet
  t += 1000;
  assert.deepEqual(rl.take('d'), { action: 'hold' });
});

test('after the digest window elapses, one combined digest message is returned, holding the batch', () => {
  let t = 0;
  const rl = createRateLimiter({ now: () => t, maxPerHour: 1, digestWindowMs: 600000 });
  assert.deepEqual(rl.take('first'), { action: 'send' });
  t += 1000; rl.take('held-1');
  t += 2000; rl.take('held-2');
  t += 600000; // digest window elapsed
  const d = rl.take('held-3');
  assert.equal(d.action, 'digest');
  assert.match(d.text, /3 trade alert\(s\)/);
  assert.match(d.text, /held-1/);
  assert.match(d.text, /held-2/);
  assert.match(d.text, /held-3/);
});

test('messages older than 1 hour fall out of the cap window, so sending resumes', () => {
  let t = 0;
  const rl = createRateLimiter({ now: () => t, maxPerHour: 1 });
  assert.deepEqual(rl.take('a'), { action: 'send' });
  t += 1000;
  assert.deepEqual(rl.take('b').action, 'hold');
  t += 3600000 + 1; // just past 1 hour since 'a'
  assert.deepEqual(rl.take('c'), { action: 'send' });
});
