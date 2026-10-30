/* India option-chain engine (server side only). Pure functions: a snapshot in, a result out; no clock, no I/O, no mutation.
   The browser receives results only (strikes, labels, scores), never weights or thresholds from this file.
   Snapshot: { symbol, asOf: 'YYYY-MM-DD', expiry, spot, rows: [{ strike, ce: { oi, oiChg, vol, ltp }, pe: { oi, oiChg, vol, ltp } }] }
   `prev` is an EARLIER snapshot of the same symbol (never a later one: enforced by assertEarlier). Statistics only, not advice. */

const T = { // thresholds live here and are never sent to the browser
  pcrHigh: 1.2, pcrLow: 0.8, skew: 0.15, range: 0.35, stepFrac: 0.25,
  power: { oi: 0.4, vol: 0.3, chg: 0.3 }, powerMin: 0.8,
  bigSkew: 0.3, longHeavy: 0.55, shortHeavy: 0.45,
};
const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function validateSnapshot(s) {
  if (!s || typeof s !== 'object') throw new RangeError('snapshot missing');
  if (!(s.spot > 0)) throw new RangeError('spot must be positive');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s.asOf))) throw new RangeError('asOf must be YYYY-MM-DD');
  if (!Array.isArray(s.rows) || s.rows.length < 2) throw new RangeError('need at least 2 strikes');
  for (let i = 0; i < s.rows.length; i++) {
    const r = s.rows[i];
    if (!(r && r.strike > 0 && r.ce && r.pe)) throw new RangeError(`bad row ${i}`);
    if (i && !(r.strike > s.rows[i - 1].strike)) throw new RangeError('strikes must be strictly increasing');
  }
  return s;
}

function assertEarlier(prev, cur) {
  if (prev && !(String(prev.asOf) < String(cur.asOf))) throw new RangeError('prev snapshot must be strictly earlier than the current one (lookahead guard)');
}

const side = (r, k) => r[k] || {};
function top(rows, k, metric, n = 3) {
  const vals = rows.map((r) => ({ strike: r.strike, v: Math.max(0, num(side(r, k)[metric])) }));
  const total = sum(vals.map((x) => x.v));
  return vals.filter((x) => x.v > 0).sort((a, b) => b.v - a.v || a.strike - b.strike).slice(0, n)
    .map((x) => ({ strike: x.strike, value: x.v, sharePct: total ? r2((x.v / total) * 100) : 0 }));
}

/** Resistance = call side, support = put side, ranked by OI, volume and OI change. */
function levels(snap) {
  const rows = validateSnapshot(snap).rows;
  const out = {};
  for (const [name, metric] of [['oi', 'oi'], ['volume', 'vol'], ['oiChange', 'oiChg']]) {
    out[name] = { resistance: top(rows, 'ce', metric), support: top(rows, 'pe', metric) };
  }
  return out;
}

/** Reversal price: where CE premium at strike K equals PE premium at K-1 step (linear between strikes). null if premiums are missing or never cross. */
function reversalPrice(snap) {
  const rows = validateSnapshot(snap).rows;
  const d = [];
  for (let i = 1; i < rows.length; i++) {
    const c = rows[i].ce.ltp, p = rows[i - 1].pe.ltp;
    if (!Number.isFinite(c) || !Number.isFinite(p)) continue;
    d.push({ k: rows[i].strike, diff: c - p });
  }
  for (let i = 1; i < d.length; i++) {
    const a = d[i - 1], b = d[i];
    if (a.diff === 0) return a.k;
    if (a.diff > 0 && b.diff <= 0) return r2(a.k + (a.diff / (a.diff - b.diff)) * (b.k - a.k));
  }
  return d.length && d[d.length - 1].diff === 0 ? d[d.length - 1].k : null;
}

function maxPain(snap) {
  const rows = validateSnapshot(snap).rows;
  let best = null;
  for (const t of rows) {
    const pain = sum(rows.map((r) => num(r.ce.oi) * Math.max(0, t.strike - r.strike) + num(r.pe.oi) * Math.max(0, r.strike - t.strike)));
    if (!best || pain < best.pain) best = { strike: t.strike, pain };
  }
  return best.strike;
}

function totals(snap) {
  const rows = validateSnapshot(snap).rows;
  const t = (k, m) => sum(rows.map((r) => Math.max(0, num(side(r, k)[m]))));
  const ceOi = t('ce', 'oi'), peOi = t('pe', 'oi'), ceVol = t('ce', 'vol'), peVol = t('pe', 'vol');
  const ceChg = sum(rows.map((r) => num(r.ce.oiChg))), peChg = sum(rows.map((r) => num(r.pe.oiChg)));
  return {
    ceOi, peOi, ceVol, peVol, ceChg, peChg,
    pcrOi: ceOi ? r2(peOi / ceOi) : null, pcrVol: ceVol ? r2(peVol / ceVol) : null,
    chgSkew: ceChg + peChg !== 0 && Math.abs(ceChg) + Math.abs(peChg) ? r2((peChg - ceChg) / (Math.abs(peChg) + Math.abs(ceChg))) : 0,
  };
}

/** A strike that is the single top strike on its side by OI, volume AND OI change at once. */
function tripleLevels(snap) {
  const L = levels(snap);
  const pick = (s) => {
    const a = L.oi[s][0], b = L.volume[s][0], c = L.oiChange[s][0];
    return a && b && c && a.strike === b.strike && b.strike === c.strike ? a.strike : null;
  };
  return { resistance: pick('resistance'), support: pick('support') };
}

/** Power level: weighted blend of OI, volume and positive OI change, each scaled to the side's maximum. */
function powerLevels(snap) {
  const rows = validateSnapshot(snap).rows;
  const one = (k) => {
    const mx = (m) => Math.max(1e-9, ...rows.map((r) => Math.max(0, num(side(r, k)[m]))));
    const [mo, mv, mc] = [mx('oi'), mx('vol'), mx('oiChg')];
    let best = null;
    for (const r of rows) {
      const x = side(r, k);
      const sc = T.power.oi * Math.max(0, num(x.oi)) / mo + T.power.vol * Math.max(0, num(x.vol)) / mv + T.power.chg * Math.max(0, num(x.oiChg)) / mc;
      if (!best || sc > best.sc) best = { strike: r.strike, sc };
    }
    return best && best.sc > 0 ? { strike: best.strike, scorePct: r2(best.sc * 100), strong: best.sc >= T.powerMin } : null;
  };
  return { resistance: one('ce'), support: one('pe') };
}

/** OI-to-OI: the heaviest put-side OI against the heaviest call-side OI, and where spot sits between those two strikes (0 = at support, 1 = at resistance). */
function oiToOi(snap) {
  const L = levels(snap);
  const res = L.oi.resistance[0], sup = L.oi.support[0];
  if (!res || !sup) return null;
  const span = res.strike - sup.strike;
  return {
    support: sup.strike, resistance: res.strike, ratio: r2(sup.value / res.value),
    spotPosition: span > 0 ? r2((snap.spot - sup.strike) / span) : null,
  };
}

/** Shift flags against an earlier snapshot: direction and size of the move in the top OI support, top OI resistance and reversal price. */
function shiftFlags(cur, prev) {
  if (!prev) return null;
  assertEarlier(prev, validateSnapshot(cur));
  const a = levels(cur).oi, b = levels(prev).oi;
  const mv = (x, y) => {
    if (x == null || y == null) return { flag: 'n/a', by: null };
    return { flag: x > y ? 'up' : x < y ? 'down' : 'same', by: r2(x - y) };
  };
  return {
    support: mv(a.support[0]?.strike, b.support[0]?.strike),
    resistance: mv(a.resistance[0]?.strike, b.resistance[0]?.strike),
    reversal: mv(reversalPrice(cur), reversalPrice(prev)),
  };
}

const sig = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const STATE = { 1: 'higher', 0: 'neutral', '-1': 'lower' };

/** Eight positioning signals, each -1/0/+1, combined to a 0..100 score (50 = balanced). Descriptive of option positioning only. */
function overview(snap, prev = null) {
  const t = totals(snap), L = levels(snap), step = snap.rows[1].strike - snap.rows[0].strike;
  const sup = L.oi.support[0]?.strike, res = L.oi.resistance[0]?.strike;
  const rev = reversalPrice(snap), mp = maxPain(snap), sh = shiftFlags(snap, prev);
  const pos = sup != null && res != null && res > sup ? (snap.spot - sup) / (res - sup) : null;
  const bands = (v, hi, lo) => (v == null ? 0 : v > hi ? 1 : v < lo ? -1 : 0);
  const s = [
    ['pcrOi', 'Put/call OI ratio', bands(t.pcrOi, T.pcrHigh, T.pcrLow)],
    ['pcrVol', 'Put/call volume ratio', bands(t.pcrVol, T.pcrHigh, T.pcrLow)],
    ['oiChange', 'Fresh OI build', bands(t.chgSkew, T.skew, -T.skew)],
    ['range', 'Spot inside OI range', pos == null ? 0 : pos > 1 - T.range ? 1 : pos < T.range ? -1 : 0],
    ['reversal', 'Reversal price vs spot', rev == null ? 0 : bands((rev - snap.spot) / step, T.stepFrac, -T.stepFrac)],
    ['maxPain', 'Max pain vs spot', bands((mp - snap.spot) / step, T.stepFrac, -T.stepFrac)],
    ['supportShift', 'Support moved', sh ? sig(sh.support.by) : 0],
    ['resistanceShift', 'Resistance moved', sh ? sig(sh.resistance.by) : 0],
  ].map(([key, label, value]) => ({ key, label, value, state: STATE[value] }));
  const raw = sum(s.map((x) => x.value));
  const scorePct = r2(((raw + 8) / 16) * 100);
  return {
    score: scorePct, raw, signals: s, partial: !prev,
    label: raw >= 3 ? 'Positioning leans higher' : raw <= -3 ? 'Positioning leans lower' : 'Positioning balanced',
  };
}

/** FII + Pro pulse from index-futures long/short contracts. p = { fii: { longs, shorts }, pro: { longs, shorts } }. */
function participantPulse(p, prevP = null) {
  const one = (x, px) => {
    if (!x || !(x.longs >= 0) || !(x.shorts >= 0) || x.longs + x.shorts === 0) return null;
    const ratio = x.longs / (x.longs + x.shorts), net = x.longs - x.shorts;
    const stance = ratio >= T.longHeavy ? 'long-heavy' : ratio <= T.shortHeavy ? 'short-heavy' : 'mixed';
    const pnet = px && px.longs >= 0 && px.shorts >= 0 ? px.longs - px.shorts : null;
    return { longs: x.longs, shorts: x.shorts, net, longSharePct: r2(ratio * 100), stance, netChange: pnet == null ? null : net - pnet };
  };
  const fii = one(p?.fii, prevP?.fii), pro = one(p?.pro, prevP?.pro);
  let alignment = 'n/a';
  if (fii && pro) alignment = fii.stance === pro.stance && fii.stance !== 'mixed' ? 'aligned' : (fii.stance === 'mixed' || pro.stance === 'mixed') ? 'mixed' : 'diverging';
  return { fii, pro, alignment };
}

/** Screeners over many snapshots: Big Bull build (heavy put-side build) / Big Bear build (heavy call-side build). Ranked by |OI-change skew|. */
function bigScreeners(snaps) {
  const bull = [], bear = [];
  for (const s of snaps) {
    const t = totals(s);
    const row = { symbol: s.symbol, pcrOi: t.pcrOi, chgSkew: t.chgSkew, spot: s.spot };
    if (t.chgSkew >= T.bigSkew && t.pcrOi >= T.pcrHigh) bull.push(row);
    else if (t.chgSkew <= -T.bigSkew && t.pcrOi != null && t.pcrOi <= T.pcrLow) bear.push(row);
  }
  const byStrength = (a, b) => Math.abs(b.chgSkew) - Math.abs(a.chgSkew) || a.symbol.localeCompare(b.symbol);
  return { bigBull: bull.sort(byStrength), bigBear: bear.sort(byStrength) };
}

/** Everything the Derivatives Desk shows for one symbol. */
function analyse(snap, prev = null, participants = null, prevParticipants = null) {
  validateSnapshot(snap);
  return {
    symbol: snap.symbol, asOf: snap.asOf, expiry: snap.expiry, spot: snap.spot,
    totals: (({ pcrOi, pcrVol, chgSkew }) => ({ pcrOi, pcrVol, chgSkew }))(totals(snap)),
    levels: levels(snap), reversal: reversalPrice(snap), maxPain: maxPain(snap),
    shifts: shiftFlags(snap, prev), triple: tripleLevels(snap), power: powerLevels(snap), oiToOi: oiToOi(snap),
    overview: overview(snap, prev), pulse: participantPulse(participants, prevParticipants),
  };
}

module.exports = { validateSnapshot, levels, reversalPrice, maxPain, totals, tripleLevels, powerLevels, oiToOi, shiftFlags, overview, participantPulse, bigScreeners, analyse };
