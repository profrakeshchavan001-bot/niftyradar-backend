const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const express = require('express');
const { createDerivsDeskRouter, defaultDeps, DESK_DISCLAIMER } = require('../src/routes/derivsDesk.js');

async function withServer(deps, fn) {
  const app = express(); app.use('/api', createDerivsDeskRouter(deps));
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}/api/derivs/desk`;
  try { await fn(base); } finally { srv.close(); }
}

test('route: validates symbol, returns results only (no weights or thresholds)', async () => {
  await withServer(defaultDeps, async (base) => {
    assert.equal((await fetch(`${base}?symbol=../etc`)).status, 400);
    assert.equal((await fetch(`${base}?symbol=ZZZZ`)).status, 400);
    assert.equal((await fetch(`${base}?symbol=A&symbol=B`)).status, 400);
    const r = await fetch(`${base}?symbol=nifty`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control'), /max-age=60/);
    const j = await r.json();
    assert.equal(j.symbol, 'NIFTY'); assert.equal(j.source, 'sample'); assert.equal(j.disclaimer, DESK_DISCLAIMER);
    assert.equal(j.overview.signals.length, 8);
    assert.ok(Array.isArray(j.screeners.bigBull) && Array.isArray(j.screeners.bigBear));
    const text = JSON.stringify(j);
    for (const leak of ['threshold', 'weight', 'powerMin', 'longHeavy', 'bigSkew', 'pcrHigh']) assert.ok(!text.includes(leak), `leaked ${leak}`);
    assert.ok(!/\b(buy|sell)\b/i.test(text), 'no buy/sell language');
  });
});

test('route: a failing loader becomes a 500, not a crash', async () => {
  const app = express();
  app.use('/api', createDerivsDeskRouter({ symbols: () => ['NIFTY'], load: async () => { throw new Error('boom'); } }));
  app.use((err, req, res, next) => { res.status(500).json({ error: 'x' }); }); // eslint-disable-line no-unused-vars
  const srv = app.listen(0);
  try { assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/api/derivs/desk`)).status, 500); } finally { srv.close(); }
});

test('page: shows results only, escapes text, no engine logic shipped to the browser', async () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/derivs-desk.js'), 'utf8');
  assert.ok(!/india_edge|pcrHigh|powerMin|bigSkew|longHeavy/.test(js), 'page must not contain engine logic');
  assert.ok(!/\b(buy|sell)\b/i.test(js) && !/\b(buy|sell)\b/i.test(fs.readFileSync(path.join(__dirname, '../public/derivs-desk.html'), 'utf8')), 'no buy/sell language');
  const win = { location: { hash: '' } };
  const doc = { getElementById: () => null, createElement: () => ({}), head: { appendChild() {} } };
  const ctx = vm.createContext({ window: win, document: doc, location: win.location });
  vm.runInContext(js, ctx);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let data; await withServer(defaultDeps, async (base) => { data = await (await fetch(`${base}?symbol=BANKNIFTY`)).json(); });
  data.disclaimer = 'x <script>alert(1)</script>';
  const app = { innerHTML: '', querySelectorAll: () => [] };
  let asked;
  await win.PictoDerivsDesk.render(app, { api: async (p) => { asked = p; return data; }, esc, setBanner() {}, symbol: 'banknifty' });
  assert.equal(asked, '/derivs/desk?symbol=BANKNIFTY');
  assert.ok(app.innerHTML.includes('aria-label="Open interest by strike'), 'ladder');
  assert.ok(app.innerHTML.includes('Positioning'), 'gauge label');
  assert.equal((app.innerHTML.match(/class="dd-s"/g) || []).length, 8);
  assert.ok(!app.innerHTML.includes('<script>'), 'escaped');
  assert.ok(!app.innerHTML.includes('<table'), 'picture first, no tables');
  await win.PictoDerivsDesk.render(app, { api: async () => { throw new Error('x'); }, esc, setBanner() {}, symbol: '' });
  assert.match(app.innerHTML, /could not be loaded/);
});
