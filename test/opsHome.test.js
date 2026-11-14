'use strict';
// GET /api/paper/home (src/paper/ops/home.js): one mobile index, hiding links to pages not registered yet.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { attachHomeRoute, routeExists, CANDIDATE_LINKS } = require('../src/paper/ops/home');
const { createHealthTracker } = require('../src/paper/ops/health');
const { createMemoryStore } = require('../paperbot/store');

test('routeExists: true only for a GET route actually registered on the app', () => {
  const app = express();
  app.get('/api/paper/report', (req, res) => res.end());
  app.post('/api/paper/report', (req, res) => res.end()); // same path, different method: GET check still true
  assert.equal(routeExists(app, '/api/paper/report'), true);
  assert.equal(routeExists(app, '/api/paper/bots-report'), false); // never registered
});

test('home page lists only the candidate links that are actually registered, in order', async () => {
  const app = express();
  const secret = 'shh';
  const okSecret = (given) => given === secret;
  app.get('/api/paper/health', (req, res) => res.end()); // registered
  app.get('/api/paper/report', (req, res) => res.end()); // registered
  // scalp-report, bots-report, replay-report, news-check, universe, summaries: NOT registered
  const tracker = createHealthTracker();
  const state = { enabled: true, ready: true, store: createMemoryStore() };
  attachHomeRoute(app, { secret, okSecret, tracker, state });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/home?key=shh`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Health/);
    assert.match(html, /Report/);
    assert.doesNotMatch(html, /Scalp report/);
    assert.doesNotMatch(html, /Bots report/);
    assert.doesNotMatch(html, /News check/);
  } finally { server.close(); }
});

test('401 without the right key; carries ?key= through to every link href', async () => {
  const app = express();
  const secret = 'shh';
  const okSecret = (given) => given === secret;
  app.get('/api/paper/health', (req, res) => res.end());
  const tracker = createHealthTracker();
  const state = { enabled: true, ready: true, store: createMemoryStore() };
  attachHomeRoute(app, { secret, okSecret, tracker, state });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const bad = await fetch(`http://localhost:${port}/api/paper/home?key=wrong`);
    assert.equal(bad.status, 401);
    const ok = await fetch(`http://localhost:${port}/api/paper/home?key=shh`);
    const html = await ok.text();
    assert.match(html, /\/api\/paper\/health\?key=shh/);
  } finally { server.close(); }
});

test('shows ALIVE/PROBLEM from the shared health snapshot (same tracker as /api/paper/health)', async () => {
  const app = express();
  const secret = 'shh';
  const okSecret = () => true;
  const tracker = createHealthTracker();
  const state = { enabled: false, ready: false, store: null }; // disabled -> PROBLEM
  attachHomeRoute(app, { secret, okSecret, tracker, state });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/home?key=shh`);
    const html = await res.text();
    assert.match(html, /PROBLEM/);
    assert.match(html, /disabled/);
  } finally { server.close(); }
});

test('no summary stored yet is shown honestly, not as a fake "0" summary', async () => {
  const app = express();
  const secret = 'shh';
  const okSecret = () => true;
  const tracker = createHealthTracker();
  const state = { enabled: true, ready: true, store: createMemoryStore() };
  attachHomeRoute(app, { secret, okSecret, tracker, state });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/home?key=shh`);
    const html = await res.text();
    assert.match(html, /No summary stored yet/);
  } finally { server.close(); }
});

test('latest summary is shown when one exists in the store', async () => {
  const app = express();
  const secret = 'shh';
  const okSecret = () => true;
  const tracker = createHealthTracker();
  const store = createMemoryStore();
  await store.saveSummary({ market: 'nse', summary_date: '2026-11-13', text: 'test summary' });
  const state = { enabled: true, ready: true, store };
  attachHomeRoute(app, { secret, okSecret, tracker, state });
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const res = await fetch(`http://localhost:${port}/api/paper/home?key=shh`);
    const html = await res.text();
    assert.match(html, /Latest summary/);
    assert.match(html, /2026-11-13/);
  } finally { server.close(); }
});

test('CANDIDATE_LINKS covers every page named in the overnight brief', () => {
  const paths = CANDIDATE_LINKS.map((l) => l.path);
  for (const p of ['/api/paper/health', '/api/paper/report', '/api/paper/scalp-report', '/api/paper/bots-report', '/api/paper/replay-report', '/api/paper/news-check', '/api/paper/universe']) {
    assert.ok(paths.includes(p), `missing ${p}`);
  }
});
