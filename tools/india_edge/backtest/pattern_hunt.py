"""Pattern hunt on real NSE data: SMC-style concepts (own implementation) + 10 classic patterns.

    python backtest/pattern_hunt.py

Concepts only (swing structure, displacement, gaps, liquidity sweeps); no third-party indicator code.
Signal is known at the close of day i; entry = open of i+1; stop 1.5 ATR(14) from entry, target 2R,
time exit at close of i+5; stop is assumed hit first when a bar touches both. Cost 0.1R per trade.
Split/bonus-adjusted prices. Universe: top 300 by prior-20-day turnover on the signal day.
Train = signal dates 2015-2022, test = 2023 to latest. Nothing is tuned: rules are fixed up front.
Lookahead audit: signals recomputed on truncated history must equal the full-history signals.
Output: backtest/edge_stats.json (survivors = positive net R on BOTH train and test, >=100 trades each).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from common import load_dataset  # noqa: E402
from robust import adjust_corporate_actions, new_notes  # noqa: E402

COST_R, STOP_ATR, TARGET_R, HOLD = 0.1, 1.5, 2.0, 5
TRAIN_END, MIN_TRADES, TOP_N, SW = "2022-12-31", 100, 300, 3
OUT = Path(__file__).resolve().parent / "edge_stats.json"


def S(a):
    return pd.Series(a)


def signals(o, h, l, c, atr):
    """dict rule -> bool array. Every flag at i uses bars <= i only."""
    n = len(c)
    B = lambda: np.zeros(n, bool)  # noqa: E731
    sig = {}
    sh = lambda k: S(h).shift(k)  # noqa: E731
    sl = lambda k: S(l).shift(k)  # noqa: E731
    sc = lambda k: S(c).shift(k)  # noqa: E731
    so = lambda k: S(o).shift(k)  # noqa: E731

    def add(name, arr):
        sig[name] = np.nan_to_num(np.asarray(arr, dtype=float)).astype(bool)

    # ---- swing structure (fractal SW bars each side; known SW bars after the pivot)
    hh = S(h).rolling(2 * SW + 1).max().shift(-SW)  # centred window: used only after the delay below
    ll = S(l).rolling(2 * SW + 1).min().shift(-SW)
    piv_h = np.where((S(h) == hh).values, h, np.nan)
    piv_l = np.where((S(l) == ll).values, l, np.nan)
    lvl_h = S(piv_h).shift(SW).ffill().values  # pivot at j visible from j+SW
    lvl_l = S(piv_l).shift(SW).ffill().values
    lh1, ll1 = S(lvl_h).shift(1).values, S(lvl_l).shift(1).values
    bos_up = (c > lvl_h) & ~(sc(1).values > lvl_h)
    bos_dn = (c < lvl_l) & ~(sc(1).values < lvl_l)
    add("smc_bos_long", bos_up)
    add("smc_bos_short", bos_dn)

    # ---- liquidity sweep of the prior 20-day extreme, close back inside
    p_hi, p_lo = S(h).rolling(20).max().shift(1).values, S(l).rolling(20).min().shift(1).values
    add("smc_sweep_long", (l < p_lo) & (c > p_lo))
    add("smc_sweep_short", (h > p_hi) & (c < p_hi))

    # ---- fair value gap retest + order block retest (stateful, first touch only)
    fvg_l, fvg_s, ob_l, ob_s = B(), B(), B(), B()
    zf_up, zf_dn, zo_up, zo_dn = [], [], [], []  # (born, lo, hi)
    for i in range(2, n):
        a = atr[i]
        if not np.isfinite(a):
            continue
        # retests of zones born before i
        for zs, out, up in ((zf_up, fvg_l, True), (zf_dn, fvg_s, False), (zo_up, ob_l, True), (zo_dn, ob_s, False)):
            keep = []
            for born, lo, hi in zs:
                life = 10 if zs is zf_up or zs is zf_dn else 15
                if i - born > life:
                    continue
                if up:
                    if c[i] < lo:
                        continue                    # invalidated
                    if l[i] <= hi:
                        if c[i] > lo and c[i] > o[i]:
                            out[i] = True
                        continue                    # first touch consumes the zone
                else:
                    if c[i] > hi:
                        continue
                    if h[i] >= lo:
                        if c[i] < hi and c[i] < o[i]:
                            out[i] = True
                        continue
                keep.append((born, lo, hi))
            zs[:] = keep
        # new zones born at i
        if l[i] > h[i - 2] and (l[i] - h[i - 2]) >= 0.5 * a:
            zf_up.append((i, h[i - 2], l[i]))
        if h[i] < l[i - 2] and (l[i - 2] - h[i]) >= 0.5 * a:
            zf_dn.append((i, h[i], l[i - 2]))
        if bos_up[i] and c[i] - c[i - 3] >= 1.5 * a:           # displacement + break of structure
            for j in range(i - 1, max(i - 6, 0), -1):
                if c[j] < o[j]:
                    zo_up.append((i, l[j], h[j]))
                    break
        if bos_dn[i] and c[i - 3] - c[i] >= 1.5 * a:
            for j in range(i - 1, max(i - 6, 0), -1):
                if c[j] > o[j]:
                    zo_dn.append((i, l[j], h[j]))
                    break
    sig["smc_fvg_long"], sig["smc_fvg_short"], sig["smc_ob_long"], sig["smc_ob_short"] = fvg_l, fvg_s, ob_l, ob_s

    # ---- 10 classic patterns
    o1, c1, h1, l1 = so(1).values, sc(1).values, sh(1).values, sl(1).values
    body, rng = np.abs(c - o), h - l
    add("engulf_long", (c1 < o1) & (c > o) & (o <= c1) & (c >= o1))
    add("engulf_short", (c1 > o1) & (c < o) & (o >= c1) & (c <= o1))
    lw, uw = np.minimum(o, c) - l, h - np.maximum(o, c)
    down4, up4 = c < sc(4).values, c > sc(4).values
    add("hammer_long", (lw >= 2 * body) & (uw <= 0.5 * body + 1e-9) & (rng > 0) & down4)
    add("star_short", (uw >= 2 * body) & (lw <= 0.5 * body + 1e-9) & (rng > 0) & up4)
    inside1 = (h1 < sh(2).values) & (l1 > sl(2).values)
    add("inside_break_long", inside1 & (c > h1))
    add("inside_break_short", inside1 & (c < l1))
    r = S(rng)
    nr7 = (r.shift(1) == r.rolling(7).min().shift(1)).values
    add("nr7_break_long", nr7 & (c > h1))
    add("nr7_break_short", nr7 & (c < l1))
    add("donchian20_long", c > p_hi)
    add("donchian20_short", c < p_lo)
    s20, s50 = S(c).rolling(20).mean(), S(c).rolling(50).mean()
    add("ma20_50_cross_long", ((s20 > s50) & (s20.shift(1) <= s50.shift(1))).values)
    add("ma20_50_cross_short", ((s20 < s50) & (s20.shift(1) >= s50.shift(1))).values)
    d = S(c).diff()
    ru, rd = d.clip(lower=0).ewm(alpha=0.5, adjust=False).mean(), (-d.clip(upper=0)).ewm(alpha=0.5, adjust=False).mean()
    rsi2 = (100 - 100 / (1 + ru / rd.replace(0, np.nan))).values
    s200 = S(c).rolling(200).mean().values
    add("rsi2_long", (rsi2 < 10) & (c > s200))
    add("rsi2_short", (rsi2 > 90) & (c < s200))
    gap = o / c1 - 1
    add("gap_fade_long", (gap <= -0.02) & (c > o))
    add("gap_fade_short", (gap >= 0.02) & (c < o))
    hi252, lo252 = S(h).rolling(252).max().shift(1).values, S(l).rolling(252).min().shift(1).values
    add("high52w_long", c > hi252)
    add("low52w_short", c < lo252)
    big = body >= 0.5 * np.where(rng > 0, rng, np.inf)
    mid1 = (np.abs(c1 - o1) <= 0.3 * np.maximum(h1 - l1, 1e-9))
    o2, c2 = so(2).values, sc(2).values
    add("morning_star_long", (c2 < o2) & mid1 & (c > o) & (c > (o2 + c2) / 2) & big)
    add("evening_star_short", (c2 > o2) & mid1 & (c < o) & (c < (o2 + c2) / 2) & big)
    return sig


def prep(g: pd.DataFrame):
    o, h, l, c = (g[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    pc = np.concatenate([[np.nan], c[:-1]])
    tr = np.maximum(h - l, np.maximum(np.abs(h - pc), np.abs(l - pc)))
    atr = S(tr).rolling(14).mean().to_numpy()
    return o, h, l, c, atr


def outcomes(idx, o, h, l, c, atr, direction):
    """R per signal at positions idx (entry open i+1). Returns (valid_idx, R_net)."""
    n = len(c)
    idx = idx[idx + HOLD < n]
    idx = idx[np.isfinite(atr[idx]) & (atr[idx] > 0)]
    if len(idx) == 0:
        return idx, np.array([])
    e = o[idx + 1]
    risk = STOP_ATR * atr[idx]
    stop, tgt = e - direction * risk, e + direction * TARGET_R * risk
    res = np.full(len(idx), np.nan)
    done = np.zeros(len(idx), bool)
    for k in range(1, HOLD + 1):
        hk, lk = h[idx + k], l[idx + k]
        hit_s = (lk <= stop) if direction == 1 else (hk >= stop)
        hit_t = (hk >= tgt) if direction == 1 else (lk <= tgt)
        m = ~done & hit_s
        res[m], done[m] = -1.0, True
        m = ~done & hit_t
        res[m], done[m] = TARGET_R, True
    m = ~done
    res[m] = direction * (c[idx[m] + HOLD] - e[m]) / risk[m]
    return idx, res - COST_R


def stats(r):
    n = len(r)
    if n == 0:
        return dict(trades=0, win_pct=None, avg_r=None, pf=None, t=None)
    w, lo = r[r > 0].sum(), -r[r <= 0].sum()
    sd = r.std(ddof=1) if n > 1 else np.nan
    return dict(trades=int(n), win_pct=round(float((r > 0).mean() * 100), 1), avg_r=round(float(r.mean()), 3),
                pf=round(float(w / lo), 2) if lo > 0 else None,
                t=round(float(r.mean() / (sd / np.sqrt(n))), 2) if sd and sd > 0 else None)


def lookahead_audit(groups, seed=7):
    """Signals on history truncated at a cut must equal the full-history signals up to that cut."""
    rng = np.random.default_rng(seed)
    keys = list(groups)
    bad, checked = [], 0
    for key in rng.choice(len(keys), size=min(25, len(keys)), replace=False):
        g = groups[keys[key]]
        if len(g) < 600:
            continue
        o, h, l, c, atr = prep(g)
        full = signals(o, h, l, c, atr)
        for cut in rng.integers(400, len(g), size=3):
            part = signals(o[:cut], h[:cut], l[:cut], c[:cut], atr[:cut])
            for name, arr in part.items():
                checked += 1
                if not np.array_equal(arr, full[name][:cut]):
                    bad.append((keys[key], int(cut), name))
    # sensitivity: a deliberately leaky rule must be caught by the same comparison
    g = next(g for g in groups.values() if len(g) > 800)
    o, h, l, c, atr = prep(g)
    leak = lambda cc: np.concatenate([cc[1:] > cc[:-1], [False]])  # noqa: E731
    caught = not np.array_equal(leak(c[:600]), leak(c)[:600])
    # entry/exit only read bars strictly after the signal bar by construction (idx+1 .. idx+HOLD)
    return dict(comparisons=checked, mismatches=len(bad), examples=bad[:5], leak_detector_works=bool(caught))


def main() -> int:
    notes = new_notes()
    cash = load_dataset("cash")
    cash = adjust_corporate_actions(cash, notes, 0.10, 0.40).sort_values(["symbol", "date"]).reset_index(drop=True)
    last = cash["date"].max()
    cash["turn"] = cash["close"] * cash["volume"]
    cash["liq"] = cash.groupby("symbol")["turn"].transform(lambda s: s.rolling(20, min_periods=20).mean().shift(1))
    cash["rank"] = cash.groupby("date")["liq"].rank(ascending=False)
    cash = cash[cash["close"] > 0]
    keep = cash.loc[cash["rank"] <= TOP_N, "symbol"].unique()
    groups = {s: g.reset_index(drop=True) for s, g in cash[cash["symbol"].isin(keep)].groupby("symbol")}
    audit = lookahead_audit(groups)
    rows = {}
    for sym, g in groups.items():
        o, h, l, c, atr = prep(g)
        dates, rank, px = g["date"].to_numpy(), g["rank"].to_numpy(), c
        for name, arr in signals(o, h, l, c, atr).items():
            idx = np.flatnonzero(arr & (rank <= TOP_N) & (px >= 20))
            d = 1 if name.endswith("long") else -1
            v, r = outcomes(idx, o, h, l, c, atr, d)
            if len(v):
                rows.setdefault(name, []).append(pd.DataFrame({"date": dates[v], "r": r, "sym": sym}))
    result, survivors = {}, []
    for name, parts in sorted(rows.items()):
        df = pd.concat(parts)
        tr, te = df[df["date"] <= TRAIN_END]["r"].to_numpy(), df[df["date"] > TRAIN_END]["r"].to_numpy()
        st, se = stats(tr), stats(te)
        ok = bool(st["trades"] >= MIN_TRADES and se["trades"] >= MIN_TRADES and st["avg_r"] > 0 and se["avg_r"] > 0)
        result[name] = dict(direction="long" if name.endswith("long") else "short", train=st, test=se, positive_both=ok)
        if ok:
            survivors.append(name)
    out = dict(
        generated=str(pd.Timestamp.today().date()), data_last_day=str(last.date()),
        method=dict(entry="next open", stop=f"{STOP_ATR} ATR14", target=f"{TARGET_R}R", exit=f"close of day {HOLD}",
                    cost_r=COST_R, train=f"2015-01-01..{TRAIN_END}", test=f"2023-01-01..{last.date()}",
                    universe=f"top {TOP_N} by prior-20d turnover", prices="split/bonus adjusted",
                    rules_tested=len(result)),
        lookahead_audit=audit, survivors=survivors, rules=result,
        disclaimer=("Historical base rates after a 0.1R cost; not a forecast and not advice. "
                    f"{len(result)} rules were tested, so a few will look positive on both halves by chance. "
                    "Past results do not guarantee future profit."))
    OUT.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print("audit", audit)
    print("rules", len(result), "survivors", survivors)
    for n_, r_ in result.items():
        print(f"{n_:22s} tr {r_['train']['trades']:6d} {r_['train']['avg_r']!s:7} | te {r_['test']['trades']:6d} {r_['test']['avg_r']!s:7} t={r_['test']['t']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
