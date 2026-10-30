const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const {
  levels, reversalPrice, maxPain, totals, tripleLevels, powerLevels, oiToOi, shiftFlags, overview,
  participantPulse, bigScreeners, analyse, validateSnapshot,
} = require('../tools/india_edge/chain/index.js');
const { synthChain, synthParticipants, SYMBOLS } = require('../tools/india_edge/chain/synth.js');

const F = JSON.parse(readFileSync(require('node:path').join(__dirname, '../tools/india_edge/chain/fixtures/hand.json'), 'utf8'));
const { cur, prev } = F;

// Hand fixture (strikes 100..140, spot 121):
//  Call OI 100,200,500,900,300 (sum 2000); put OI 400,800,600,150,50 (sum 2000) -> put/call OI = 2000/2000 = 1
//  Call vol 50,120,400,700,200 (1470); put vol 300,500,450,100,30 (1380) -> 1380/1470 = 0.93878 -> 0.94
//  Top call OI 130 (900 of 2000 = 45%), top put OI 110 (800 of 2000 = 40%); same strikes on volume (700/1470 = 47.62%) and OI change (300 of 440... see totals)
//  OI change: call 10-20+100+300+50 = 440, put 50+200+150-30-10 = 360 -> skew (360-440)/(360+440) = -0.1
test('levels: top strikes and shares by OI, volume, OI change', () => {
  const L = levels(cur);
  assert.deepEqual(L.oi.resistance[0], { strike: 130, value: 900, sharePct: 45 });
  assert.deepEqual(L.oi.support[0], { strike: 110, value: 800, sharePct: 40 });
  assert.equal(L.oi.resistance[1].strike, 120);
  assert.equal(L.volume.resistance[0].strike, 130);
  assert.equal(L.volume.support[0].strike, 110);
  assert.equal(L.volume.resistance[0].sharePct, 47.62); // 700 / 1470
  assert.equal(L.oiChange.resistance[0].strike, 130);
  assert.equal(L.oiChange.support[0].strike, 110);
  assert.equal(L.oiChange.support[0].value, 200);
});

test('totals: put/call ratios and OI-change skew', () => {
  const t = totals(cur);
  assert.equal(t.pcrOi, 1);
  assert.equal(t.pcrVol, 0.94); // 1380/1470 = 0.9388
  assert.equal(t.chgSkew, -0.1);
});

// Reversal: d(K) = CE(K) - PE(K-10): 110: 15-0.5 = 14.5; 120: 8-2 = 6; 130: 4-6 = -2; 140: 1.5-12 = -10.5
// zero between 120 and 130 at 120 + 6/(6+2)*10 = 127.5.  Prev: 110: 11-1 = 10; 120: 6-2 = 4; 130: 2-6 = -4 -> 120 + 4/8*10 = 125.
test('reversal price is where CE(K) = PE(K-1) (interpolated)', () => {
  assert.equal(reversalPrice(cur), 127.5);
  assert.equal(reversalPrice(prev), 125);
});

test('reversal price is null when premiums are missing or never cross', () => {
  const noLtp = structuredClone(cur); noLtp.rows.forEach((r) => { delete r.ce.ltp; });
  assert.equal(reversalPrice(noLtp), null);
  const noCross = structuredClone(cur); noCross.rows.forEach((r) => { r.ce.ltp = 100; });
  assert.equal(reversalPrice(noCross), null);
});

// Max pain: total payout to option buyers at each expiry strike; the minimum is 120 (6500 vs 26500, 11500, 12500, 29000)
test('max pain', () => assert.equal(maxPain(cur), 120));

test('triple levels: same strike tops OI, volume and OI change', () => {
  assert.deepEqual(tripleLevels(cur), { resistance: 130, support: 110 });
  const x = structuredClone(cur); x.rows[2].ce.vol = 5000; // volume now tops at 120, so no triple resistance
  assert.equal(tripleLevels(x).resistance, null);
  assert.equal(tripleLevels(x).support, 110);
});

// Power: 0.4*oi/max + 0.3*vol/max + 0.3*oiChg/max.  Call 130 -> 0.4+0.3+0.3 = 1.0; put 110 -> 1.0.
test('power levels', () => {
  assert.deepEqual(powerLevels(cur).resistance, { strike: 130, scorePct: 100, strong: true });
  assert.deepEqual(powerLevels(cur).support, { strike: 110, scorePct: 100, strong: true });
});

// OI-to-OI: 800/900 = 0.89; spot position (121-110)/(130-110) = 0.55
test('OI-to-OI', () => assert.deepEqual(oiToOi(cur), { support: 110, resistance: 130, ratio: 0.89, spotPosition: 0.55 }));

// Prev: top put OI at 100, top call OI at 140. Now 110 and 130: support up 10, resistance down 10, reversal up 2.5
test('shift flags', () => {
  assert.deepEqual(shiftFlags(cur, prev), {
    support: { flag: 'up', by: 10 }, resistance: { flag: 'down', by: -10 }, reversal: { flag: 'up', by: 2.5 },
  });
  assert.equal(shiftFlags(cur, null), null);
  assert.equal(shiftFlags(cur, cur.rows && { ...cur, asOf: '2026-10-28' }).support.flag, 'same');
});

// Signals (step 10): pcrOi 1 -> 0; pcrVol 0.94 -> 0; skew -0.1 (inside +-0.15) -> 0; range 0.55 -> 0; reversal (127.5-121)/10 = 0.65 -> +1;
// max pain (120-121)/10 = -0.1 -> 0; support up -> +1; resistance down -> -1.  raw = +1; score = (1+8)/16 = 56.25
test('overview: eight signals and score', () => {
  const o = overview(cur, prev);
  assert.equal(o.signals.length, 8);
  assert.deepEqual(o.signals.map((s) => s.value), [0, 0, 0, 0, 1, 0, 1, -1]);
  assert.equal(o.raw, 1);
  assert.equal(o.score, 56.25);
  assert.equal(o.label, 'Positioning balanced');
  assert.equal(o.partial, false);
  const alone = overview(cur);
  assert.equal(alone.partial, true);
  assert.equal(alone.raw, 1 /* reversal +1, shifts 0 */);
});

// FII 120000/(120000+80000) = 60% long-heavy, net +40000, prev net +10000 -> change +30000
// Pro 85000/200000 = 42.5% short-heavy, net -30000, prev net -10000 -> change -20000; one long-heavy, one short-heavy -> diverging
test('FII + Pro pulse', () => {
  const p = participantPulse(F.participants, F.prevParticipants);
  assert.deepEqual(p.fii, { longs: 120000, shorts: 80000, net: 40000, longSharePct: 60, stance: 'long-heavy', netChange: 30000 });
  assert.equal(p.pro.longSharePct, 42.5);
  assert.equal(p.pro.stance, 'short-heavy');
  assert.equal(p.pro.netChange, -20000);
  assert.equal(p.alignment, 'diverging');
  assert.equal(participantPulse(null).alignment, 'n/a');
  const both = participantPulse({ fii: { longs: 70, shorts: 30 }, pro: { longs: 60, shorts: 40 } });
  assert.equal(both.alignment, 'aligned');
});

// Big Bull: skew >= 0.3 and put/call >= 1.2.  Skew = (put chg - call chg)/(|put chg|+|call chg|).
// Bull: call chg 100, put chg 400 -> 300/500 = 0.6 ; put OI 1500, call OI 1000 -> 1.5.  Bear mirrors.
test('Big Bull / Big Bear screeners', () => {
  const mk = (symbol, ceChg, peChg, ceOi, peOi) => ({ symbol, asOf: '2026-10-29', spot: 10, rows: [
    { strike: 9, ce: { oi: ceOi, vol: 1, oiChg: ceChg, ltp: 1 }, pe: { oi: peOi, vol: 1, oiChg: peChg, ltp: 1 } },
    { strike: 10, ce: { oi: 0, vol: 0, oiChg: 0, ltp: 1 }, pe: { oi: 0, vol: 0, oiChg: 0, ltp: 1 } }] });
  const r = bigScreeners([mk('UP', 100, 400, 1000, 1500), mk('DN', 400, 100, 1500, 1000), mk('FLAT', 100, 100, 1000, 1000), mk('UP2', 100, 700, 1000, 1500)]);
  assert.deepEqual(r.bigBull.map((x) => x.symbol), ['UP2', 'UP']); // skew 0.75 then 0.6
  assert.deepEqual(r.bigBear.map((x) => x.symbol), ['DN']);
  assert.equal(r.bigBull[1].chgSkew, 0.6);
});

test('validation rejects bad snapshots', () => {
  assert.throws(() => validateSnapshot(null), RangeError);
  assert.throws(() => validateSnapshot({ ...cur, spot: 0 }), /spot/);
  assert.throws(() => validateSnapshot({ ...cur, asOf: 'today' }), /asOf/);
  assert.throws(() => validateSnapshot({ ...cur, rows: [cur.rows[0]] }), /2 strikes/);
  assert.throws(() => validateSnapshot({ ...cur, rows: [cur.rows[1], cur.rows[0]] }), /increasing/);
});

// ---- audit loop: lookahead / leak, consistency, speed ----

test('lookahead guard: a prev snapshot from the same or a later day is refused', () => {
  assert.throws(() => shiftFlags(cur, { ...prev, asOf: cur.asOf }), /lookahead/);
  assert.throws(() => overview(prev, cur), /lookahead/);
});

test('no leak: result depends only on the two snapshots given (future changes cannot alter it)', () => {
  const before = analyse(cur, prev, F.participants, F.prevParticipants);
  assert.deepEqual(analyse(structuredClone(cur), structuredClone(prev), F.participants, F.prevParticipants), before);
});

test('purity: inputs are not mutated and results are deterministic', () => {
  const frozen = structuredClone(F);
  const deep = (o) => { Object.freeze(o); Object.values(o).forEach((v) => { if (v && typeof v === 'object') deep(v); }); return o; };
  deep(frozen);
  const a = analyse(frozen.cur, frozen.prev, frozen.participants, frozen.prevParticipants);
  const b = analyse(frozen.cur, frozen.prev, frozen.participants, frozen.prevParticipants);
  assert.deepEqual(a, b);
});

test('consistency: every synthetic symbol gives sane, mutually consistent levels', () => {
  for (const s of Object.keys(SYMBOLS)) {
    const c = synthChain(s, '2026-10-29', { seed: 2 }), p = synthChain(s, '2026-10-28', { seed: 1 });
    const a = analyse(c, p, synthParticipants(2), synthParticipants(1));
    assert.equal(a.levels.oi.support[0].strike, a.oiToOi.support);
    assert.equal(a.levels.oi.resistance[0].strike, a.oiToOi.resistance);
    assert.ok(a.overview.score >= 0 && a.overview.score <= 100);
    assert.equal(a.overview.raw, a.overview.signals.reduce((x, y) => x + y.value, 0));
    const strikes = c.rows.map((r) => r.strike);
    assert.ok(a.maxPain >= strikes[0] && a.maxPain <= strikes[strikes.length - 1]);
    if (a.reversal != null) assert.ok(a.reversal >= strikes[0] && a.reversal <= strikes[strikes.length - 1]);
    assert.deepEqual(synthChain(s, '2026-10-29', { seed: 2 }), c, 'synthetic data is deterministic');
  }
});

test('speed: 200 symbols x 25 strikes analysed well under a second', () => {
  const snaps = Array.from({ length: 200 }, (_, i) => synthChain(Object.keys(SYMBOLS)[i % 6], '2026-10-29', { seed: i + 1 }));
  const t0 = performance.now();
  for (const s of snaps) analyse(s, null);
  bigScreeners(snaps);
  assert.ok(performance.now() - t0 < 1000, 'engine too slow');
});
