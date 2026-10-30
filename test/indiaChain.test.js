import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { analyse, publicView, runChain, reversalOf } from '../tools/india_edge/chain/engine.js';
import { fromBhavcopy } from '../tools/india_edge/chain/adapter.js';

const load = (n) => JSON.parse(fs.readFileSync(new URL(`../tools/india_edge/chain/fixtures/${n}.json`, import.meta.url), 'utf8'));
const cur = () => load('chain_cur');
const prev = () => load('chain_prev');

// All expected values below were worked out by hand from the fixture tables.
test('support/resistance from OI, volume and OI change', () => {
  const o = runChain(cur(), prev());
  // CE OI max 900 @24200; CE vol max 600 @24100; CE chg max 260 @24300
  assert.deepEqual(o.levels.resistance, { oi: 24200, volume: 24100, change: 24300 });
  // PE OI max 1000 @24000; PE vol max 700 @24000; PE chg max 300 @24000
  assert.deepEqual(o.levels.support, { oi: 24000, volume: 24000, change: 24000 });
});

test('reversal price: CE(K) = PE(K-100)', () => {
  // d(24100)=100-60=40, d(24200)=50-110=-60 -> 24100 + 100*40/(40+60) = 24140
  assert.equal(reversalOf(cur()), 24140);
  assert.equal(runChain(cur(), prev()).reversal, 24140);
});

test('SFT/SFB shift flags', () => {
  // prev walls: res 24100, sup 23900; now res 24200, sup 24000 -> both up
  assert.deepEqual(runChain(cur(), prev()).shift, { SFT: true, SFB: false });
  assert.deepEqual(runChain(prev(), cur()).shift, { SFT: false, SFB: true });
  assert.deepEqual(runChain(cur(), null).shift, { SFT: false, SFB: false });
});

test('screeners: triple S/R, power, oi2oi', () => {
  const s = runChain(cur(), prev()).screeners;
  assert.deepEqual(s.triple_sr, { support: true, resistance: false });
  // PE wall 1000 of total 3050 = 32.8% >= 30%; CE wall 900 of 3050 = 29.5% < 30%
  assert.deepEqual(s.power, { support: true, resistance: false });
  assert.deepEqual(s.oi2oi, { support: true, resistance: false });
  assert.equal(s.big_bull, false);
  assert.equal(s.big_bear, false);
});

test('8-signal overview: net +1 -> score 56', () => {
  // oi 1.00:0, vol 1580/1780=0.888:-1, chg 585/640=0.914:0, spot<rev:-1,
  // pos (24100-24000)/200=0.5:0, shift:+1, vix down:+1, breadth 30/20:+1 => +1; (1+8)/16*100=56.25
  const o = runChain(cur(), prev()).overview;
  assert.equal(o.score, 56);
  assert.deepEqual(o.signals.map((x) => x.tilt),
    ['neutral', 'negative', 'neutral', 'negative', 'neutral', 'positive', 'positive', 'positive']);
});

test('FII and Pro pulse', () => {
  // FII 120/220=.54545 prev 110/215=.51163 -> 54.545+3.383=57.93; Pro 80/170=.47059 prev .5 -> 47.059-2.941=44.12
  const p = runChain(cur(), prev()).pulse;
  assert.deepEqual(p.fii, { score: 58, direction: 'up' });
  assert.deepEqual(p.pro, { score: 44, direction: 'down' });
});

test('MMI meter and derivatives score', () => {
  // parts: vix (30-13.5)/20*100=82.5; pcr (1-.5)*100=50; breadth 60; fii 57.93; pos 50 -> 300.43/5=60.09
  const o = runChain(cur(), prev());
  assert.deepEqual(o.mmi, { value: 60.1, zone: 'Greed' });
  // 0.4*56.25 + 0.3*60.0857 + 0.3*51.0229 = 22.5+18.0257+15.3069 = 55.83
  assert.deepEqual(o.signal_group, { id: 'derivatives', score: 55.8, label: 'Leaning firm' });
});

test('Big Bull: all eight signals positive', () => {
  const s = cur();
  const m = s.strikes.find((x) => x.k === 24000);
  m.pe.oi = 2000; m.pe.vol = 2500; m.pe.chg = 800;
  s.spot = 24300;
  const o = runChain(s, prev());
  // net +8 -> (8+8)/16*100 = 100; PE wall 2000*100 >= 30*4050
  assert.equal(o.overview.score, 100);
  assert.equal(o.screeners.big_bull, true);
  assert.equal(o.screeners.big_bear, false);
});

test('Big Bear: net -7 with a power resistance wall', () => {
  const s = cur();
  s.strikes.find((x) => x.k === 24200).ce.oi = 2000;
  s.strikes.find((x) => x.k === 24100).ce.vol = 3000;
  s.strikes.find((x) => x.k === 24300).ce.chg = 1500;
  s.spot = 23700; s.vix = 15; s.vixPrev = 14; s.adv = 20; s.dec = 30;
  const o = runChain(s, null);
  // oi 3050/4150=.735, vol 1580/4180=.378, chg 585/1880=.311, spot<rev, pos -1.5, breadth .667, vix up = -7; shift 0
  // (-7+8)/16*100 = 6.25
  assert.equal(o.overview.score, 6);
  assert.equal(o.screeners.big_bear, true);
  assert.equal(o.screeners.big_bull, false);
  assert.equal(o.screeners.power.resistance.valueOf(), true);
});

test('public JSON shows results only, never formulas or weights', () => {
  const txt = JSON.stringify(runChain(cur(), prev())).toLowerCase();
  for (const w of ['weight', 'threshold', 'formula', 'ratio', 'pcr', '0.4', 'wall', 'total']) {
    assert.ok(!txt.includes(w), `leaked: ${w}`);
  }
  assert.ok(analyse(cur(), prev()).derivatives > 0);
  assert.deepEqual(Object.keys(publicView(analyse(cur(), prev()))).includes('weights'), false);
});

test('bhavcopy adapter reads UDiFF and legacy columns', () => {
  const rows = [
    { TckrSymb: 'NIFTY', XpryDt: '2026-01-22', StrkPric: '24000', OptnTp: 'CE', OpnIntrst: '400', ChngInOpnIntrst: '50', TtlTradgVol: '300', ClsPric: '170' },
    { SYMBOL: 'NIFTY', EXPIRY_DT: '2026-01-22', STRIKE_PR: '24000', OPTION_TYP: 'PE', OPEN_INT: '1,000', CHG_IN_OI: '300', CONTRACTS: '700', CLOSE: '60' },
    { SYMBOL: 'BANKNIFTY', EXPIRY_DT: '2026-01-22', STRIKE_PR: '50000', OPTION_TYP: 'CE', OPEN_INT: '1' },
  ];
  const s = fromBhavcopy(rows, { symbol: 'NIFTY', expiry: '2026-01-22', spot: 24100 });
  assert.equal(s.strikes.length, 1);
  assert.deepEqual(s.strikes[0].ce, { oi: 400, chg: 50, vol: 300, ltp: 170 });
  assert.deepEqual(s.strikes[0].pe, { oi: 1000, chg: 300, vol: 700, ltp: 60 });
});
