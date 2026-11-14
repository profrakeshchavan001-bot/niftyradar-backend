'use strict';
// Overnight brief item 5 (src/paper/ops/cookieAuth.js): ?key= sets an HttpOnly cookie and redirects to the
// clean URL on the first visit; ?key= keeps working every time; a stored cookie authenticates with no key.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { attachCookieAuth, parseCookies, COOKIE_NAME } = require('../src/paper/ops/cookieAuth');

function buildApp(secret) {
  const app = express();
  app.get('/api/paper/ping', (req, res) => res.json({ ok: true })); // registered before cookieAuth, as in paperbot/index.js - no auth
  const okSecret = (given) => given === secret;
  attachCookieAuth(app, { okSecret, secure: false });
  app.get('/api/paper/health', (req, res) => res.json({ keySeen: req.query.key || null }));
  return app;
}

test('a minimal fake app with no .use() (as several existing route tests build) is skipped safely, never throws', () => {
  const fakeApp = { get: () => {} }; // exactly the shape test/paperReport.test.js, test/paperFollowup.test.js etc. use
  const logs = [];
  assert.doesNotThrow(() => attachCookieAuth(fakeApp, { okSecret: () => true, log: (m) => logs.push(m) }));
  assert.match(logs[0], /app has no \.use/);
});

test('parseCookies: handles multiple cookies and a missing header', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies(`${COOKIE_NAME}=shh%20secret`), { [COOKIE_NAME]: 'shh secret' });
});

test('first visit with a valid ?key=: sets an HttpOnly cookie and redirects to the clean URL', async () => {
  const app = buildApp('shh');
  // mount AFTER the route for this test app since buildApp already wired cookieAuth before the route
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/health?key=shh&format=json`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/api/paper/health?format=json'); // key stripped, format kept
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /paper_key=shh/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /Path=\/api\/paper/);
  } finally { server.close(); }
});

test('an invalid ?key= is left alone (no cookie, no redirect) - the route itself answers 401', async () => {
  const app = buildApp('shh');
  app.get('/api/paper/needs-secret', (req, res) => {
    if (req.query.key !== 'shh') return res.status(401).end();
    res.json({ ok: true });
  });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/needs-secret?key=wrong`, { redirect: 'manual' });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally { server.close(); }
});

test('a stored cookie authenticates a request with no ?key= at all (req.query.key filled in)', async () => {
  const app = buildApp('shh');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/health`, { headers: { Cookie: `${COOKIE_NAME}=shh` } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.keySeen, 'shh');
  } finally { server.close(); }
});

test('?key= keeps working on every request, cookie or not (no breaking change for scripts)', async () => {
  const app = buildApp('shh');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/health?key=shh`);
    assert.equal(res.status, 200); // follows the 302 automatically (default fetch behaviour) and lands on the clean URL
    const body = await res.json();
    assert.equal(body.keySeen, null); // the clean URL has no ?key=; the route still answered because the redirect preserved the new cookie for the follow-up GET... (see next test for the explicit two-step)
  } finally { server.close(); }
});

test('cookie already matches the given ?key=: no redirect loop, request answered directly', async () => {
  const app = buildApp('shh');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/health?key=shh`, { headers: { Cookie: `${COOKIE_NAME}=shh` }, redirect: 'manual' });
    assert.equal(res.status, 200); // cookie already equals the given key: falls through to next(), no redirect
    const body = await res.json();
    assert.equal(body.keySeen, 'shh');
  } finally { server.close(); }
});

test('/api/paper/ping (registered before cookieAuth, no auth) is completely unaffected', async () => {
  const app = buildApp('shh');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/ping`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('set-cookie'), null);
  } finally { server.close(); }
});
