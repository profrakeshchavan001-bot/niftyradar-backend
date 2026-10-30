// Option-chain engine. Every formula, threshold and weight lives in this file.
// analyse() returns the private working; publicView() returns only WHAT was found.
// Input shape: see fixtures/chain_cur.json. No network, no database.

const sum = (a) => a.reduce((s, x) => s + x, 0);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const r1 = (x) => Math.round(x * 10) / 10;

const sorted = (snap) => [...snap.strikes].sort((a, b) => a.k - b.k);

function argMax(strikes, pick) {
  let best = null;
  for (const s of strikes) {
    const v = pick(s);
    if (best === null || v > best.v) best = { k: s.k, v };
  }
  return best;
}

function stepOf(strikes) {
  let m = Infinity;
  for (let i = 1; i < strikes.length; i++) m = Math.min(m, strikes[i].k - strikes[i - 1].k);
  return Number.isFinite(m) ? m : 0;
}

export function levelsOf(snap) {
  const s = sorted(snap);
  const side = (leg) => ({
    oi: argMax(s, (x) => x[leg].oi)?.k ?? null,
    vol: argMax(s, (x) => x[leg].vol)?.k ?? null,
    chg: argMax(s, (x) => x[leg].chg)?.k ?? null,
    wallOi: argMax(s, (x) => x[leg].oi)?.v ?? 0,
    total: sum(s.map((x) => x[leg].oi)),
  });
  return { support: side('pe'), resistance: side('ce') };
}

// Spot level where CE(K) premium equals PE(K - step) premium (linear between strikes).
export function reversalOf(snap) {
  const s = sorted(snap);
  const d = (i) => s[i].ce.ltp - s[i - 1].pe.ltp;
  for (let i = 1; i < s.length - 1; i++) {
    const d1 = d(i);
    const d2 = d(i + 1);
    if (d1 === 0) return s[i].k;
    if (d1 > 0 && d2 <= 0) return s[i].k + ((s[i + 1].k - s[i].k) * d1) / (d1 - d2);
  }
  return null;
}

function shiftOf(cur, prev) {
  if (!prev) return { sft: false, sfb: false };
  const a = levelsOf(cur);
  const b = levelsOf(prev);
  const ds = a.support.oi - b.support.oi;
  const dr = a.resistance.oi - b.resistance.oi;
  return { sft: ds > 0 && dr > 0, sfb: ds < 0 && dr < 0 };
}

function screenersOf(lv) {
  const both = (f) => ({ support: f(lv.support), resistance: f(lv.resistance) });
  return {
    triple: both((x) => x.oi === x.vol && x.vol === x.chg),
    power: both((x) => x.total > 0 && x.wallOi * 100 >= 30 * x.total),
    oi2oi: both((x) => x.oi === x.chg),
  };
}

const tilt = (v) => (v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral');
const ratioTilt = (r) => (r > 1.1 ? 1 : r < 0.9 ? -1 : 0);

function overviewOf(snap, lv, rev, shift) {
  const s = sorted(snap);
  const tot = (leg, f) => sum(s.map((x) => x[leg][f]));
  const pcrOi = tot('ce', 'oi') ? tot('pe', 'oi') / tot('ce', 'oi') : 1;
  const pcrVol = tot('ce', 'vol') ? tot('pe', 'vol') / tot('ce', 'vol') : 1;
  const chgRatio = tot('ce', 'chg') > 0 ? tot('pe', 'chg') / tot('ce', 'chg') : 1;
  const span = lv.resistance.oi - lv.support.oi;
  const pos = span > 0 ? (snap.spot - lv.support.oi) / span : 0.5;
  const sig = [
    ['OI balance', ratioTilt(pcrOi)],
    ['Volume balance', ratioTilt(pcrVol)],
    ['OI change flow', ratioTilt(chgRatio)],
    ['Spot vs reversal', rev == null ? 0 : snap.spot > rev ? 1 : snap.spot < rev ? -1 : 0],
    ['Range position', pos > 0.6 ? 1 : pos < 0.4 ? -1 : 0],
    ['Level shift', shift.sft ? 1 : shift.sfb ? -1 : 0],
    ['Volatility trend', snap.vix == null || snap.vixPrev == null ? 0 : snap.vix < snap.vixPrev ? 1 : snap.vix > snap.vixPrev ? -1 : 0],
    ['Breadth', snap.adv && snap.dec ? (snap.adv / snap.dec > 1.2 ? 1 : snap.adv / snap.dec < 0.8 ? -1 : 0) : 0],
  ];
  const net = sum(sig.map((x) => x[1]));
  return { sig, net, score: ((net + 8) / 16) * 100, pcrOi, pos };
}

function pulseOf(p) {
  if (!p) return null;
  const ratio = p.long / (p.long + p.short);
  const prev = p.prevLong != null ? p.prevLong / (p.prevLong + p.prevShort) : ratio;
  const score = clamp(100 * ratio + 100 * (ratio - prev), 0, 100);
  return { score, dir: ratio > prev ? 'up' : ratio < prev ? 'down' : 'flat' };
}

const zoneOf = (v) => (v < 30 ? 'Extreme Fear' : v < 50 ? 'Fear' : v < 70 ? 'Greed' : 'Extreme Greed');
const labelOf = (v) => (v < 35 ? 'Soft' : v < 50 ? 'Leaning soft' : v < 65 ? 'Leaning firm' : 'Firm');

function mmiOf(snap, ov, fii) {
  const parts = [];
  if (snap.vix != null) parts.push(clamp(((30 - snap.vix) / 20) * 100, 0, 100));
  parts.push(clamp((ov.pcrOi - 0.5) * 100, 0, 100));
  if (snap.adv && snap.dec) parts.push((snap.adv / (snap.adv + snap.dec)) * 100);
  if (fii) parts.push(fii.score);
  parts.push(clamp(ov.pos * 100, 0, 100));
  return sum(parts) / parts.length;
}

const WEIGHTS = { overview: 0.4, mmi: 0.3, pulse: 0.3 };

export function analyse(snap, prev = null) {
  const lv = levelsOf(snap);
  const rev = reversalOf(snap);
  const shift = shiftOf(snap, prev);
  const sc = screenersOf(lv);
  const ov = overviewOf(snap, lv, rev, shift);
  const fii = pulseOf(snap.fii);
  const pro = pulseOf(snap.pro);
  const mmi = mmiOf(snap, ov, fii);
  const pulses = [fii, pro].filter(Boolean).map((x) => x.score);
  const pulse = pulses.length ? sum(pulses) / pulses.length : null;
  const parts = [[WEIGHTS.overview, ov.score], [WEIGHTS.mmi, mmi]];
  if (pulse != null) parts.push([WEIGHTS.pulse, pulse]);
  const wsum = sum(parts.map((p) => p[0]));
  const derivatives = sum(parts.map((p) => p[0] * p[1])) / wsum;
  const bigBull = ov.net >= 5 && sc.power.support;
  const bigBear = ov.net <= -5 && sc.power.resistance;
  return { snap, lv, rev, shift, sc, ov, fii, pro, pulse, mmi, derivatives, bigBull, bigBear };
}

// Public JSON: results only. No weights, thresholds or intermediate maths.
export function publicView(a) {
  const lvl = (x) => ({ oi: x.oi, volume: x.vol, change: x.chg });
  return {
    symbol: a.snap.symbol,
    date: a.snap.date,
    expiry: a.snap.expiry,
    spot: a.snap.spot,
    levels: { support: lvl(a.lv.support), resistance: lvl(a.lv.resistance) },
    reversal: a.rev == null ? null : Math.round(a.rev * 100) / 100,
    shift: { SFT: a.shift.sft, SFB: a.shift.sfb },
    screeners: {
      triple_sr: a.sc.triple,
      power: a.sc.power,
      oi2oi: a.sc.oi2oi,
      big_bull: a.bigBull,
      big_bear: a.bigBear,
    },
    overview: {
      score: Math.round(a.ov.score),
      signals: a.ov.sig.map(([name, v]) => ({ name, tilt: tilt(v) })),
    },
    pulse: {
      fii: a.fii && { score: Math.round(a.fii.score), direction: a.fii.dir },
      pro: a.pro && { score: Math.round(a.pro.score), direction: a.pro.dir },
    },
    mmi: { value: r1(a.mmi), zone: zoneOf(a.mmi) },
    signal_group: { id: 'derivatives', score: r1(a.derivatives), label: labelOf(a.derivatives) },
  };
}

export const runChain = (snap, prev) => publicView(analyse(snap, prev));
