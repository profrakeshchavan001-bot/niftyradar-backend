"""Backtest of 3 rule-fixed Nifty options structures on EOD data (Black-Scholes, VIX as flat IV).

Rules are taken verbatim from the brief and are NOT tuned. Every judgement call is listed in ASSUMPTIONS
and echoed into docs/NEEDS-RAKESH-CC8.md. Nothing here is advice; it measures what the rules would have done
on modelled prices (no real Nifty option prices exist in the free dataset).
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
from common import data_root  # noqa: E402

LOT = 75                # fixed lot so the Rs thresholds in the brief stay comparable across 2015-2026
RATE, DIV = 0.065, 0.012
STEP = 50
# costs (per leg, per transaction)
BROKERAGE, EXCH, STT_SELL, STAMP_BUY, SEBI, GST = 20.0, 0.000503, 0.001, 0.00003, 1e-7, 0.18
SLIP = 1.0              # Rs per unit per leg per transaction
GAP_CAP = 0.03          # ETF open prints further than 3% from prev close are treated as bad prints
LONG_ADD = 13.5         # calendar: long premium = short premium + 13.5 (brief says 12-15)
TRAIN_FRAC = 0.60

ASSUMPTIONS = [
    "No Nifty index option prices exist in data/fo (only STO/STF stock rows). All option prices are Black-Scholes "
    f"with flat IV = India VIX/100 (no skew, no term structure), r={RATE}, q={DIV}, strikes in steps of {STEP}.",
    "Nifty open is unavailable; proxy = prev Nifty close x (NIFTYBEES open / NIFTYBEES prev_close). The ETF open is noisy "
    f"(median |gap| 0.42% vs index), so a print is used only if |gap|<={GAP_CAP:.0%} and (|gap|<=0.2% or it has the same sign "
    "as the day's index move and is no bigger than |move|+0.2%); otherwise open = prev close (no open-gap information). "
    "This validation uses the same-day close to reject bad prints, never to pick trades. Real gaps that reverse "
    "intraday are therefore under-represented; counts of rejected prints reported.",
    "Entries fill at the next-day open proxy using the prior-day VIX (decision at close, fill next open); open marks use the previous close's time-to-expiry (no overnight theta credited at the open). Exits and "
    "adjustments are checked at the close mark; SL/TP are also checked at the open proxy and, if breached there, "
    "fill at that open mark, never at the SL level. Intraday excursions are invisible, so intraday stop-outs are missed.",
    f"Fixed lot = {LOT} for all years (real lot changed 75/50/25/75/65). Rs figures are per 1 lot.",
    "Expiries are synthetic: monthly = last Thursday (last Tuesday from Sep 2025), weekly = every Thursday/Tuesday, "
    "rolled back to the previous trading day on holidays. Real Nifty weeklies did not exist before 2019.",
    f"Costs per leg per transaction: brokerage Rs{BROKERAGE:.0f}, exchange {EXCH:.4%}, GST 18% on brokerage+exchange, "
    f"SEBI 0.00001%, STT {STT_SELL:.2%} on premium of short-opening and long-closing transactions (flat, conservative before Oct 2024), stamp {STAMP_BUY:.3%} "
    f"on long-opening and short-closing transactions, slippage Rs{SLIP:.1f}/unit/leg/transaction. Worthless (<Rs0.05) exits carry no cost.",
    "Strangle strike: 18 delta (middle of the 16-20 option; the ~Rs100-premium alternative is not run). Strangle first "
    "adjustment trigger: Rs1,400 loss (middle of 1,300-1,500). Calendar long-leg premium add-on: Rs13.5 (middle of 12-15).",
    "Strangle 7-DTE rule: at the first close with DTE<=7, exit if gross P&L < 0 (unstable); else hold to expiry "
    "settlement with SL/TP still active. 'Cost-to-cost' cannot be targeted on EOD data, so exit is at the mark.",
    "Strangle further adjustments (same close-profitable-leg / re-short-at-matching-premium move) happen once each when "
    "the loss first reaches 4,000 / 8,000 / 12,000 after the straddle stage; the 1,400-type adjustment is not repeated.",
    "Condor: 30-delta shorts, 16-delta wings (15 and 17 tried only if the 1:2 check fails), 'risk:reward not worse than "
    "1:2' read as max loss <= 2 x net credit; entries failing the check are skipped and counted.",
    "Calendar straddle test: short strikes within one strike step. Adjustment counter is per calendar month.",
    "Walk-forward: rules have no fitted parameters, so walk-forward is frozen-rule evaluation on consecutive "
    "calendar-year windows 2018 onward (2015-2017 is burn-in). Trades belong to the window of their entry date.",
    "Survivor test (fixed before running): test-period net > 0 AND walk-forward total > 0 AND >= half of WF windows positive.",
]


# ------------------------------------------------------------------ pricing
def _ncdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2.0))


def bs(S: float, K: float, T: float, sig: float, cp: str) -> float:
    if T <= 0 or sig <= 0:
        return max(S - K, 0.0) if cp == "C" else max(K - S, 0.0)
    sq = sig * math.sqrt(T)
    d1 = (math.log(S / K) + (RATE - DIV + 0.5 * sig * sig) * T) / sq
    d2 = d1 - sq
    if cp == "C":
        return S * math.exp(-DIV * T) * _ncdf(d1) - K * math.exp(-RATE * T) * _ncdf(d2)
    return K * math.exp(-RATE * T) * _ncdf(-d2) - S * math.exp(-DIV * T) * _ncdf(-d1)


def delta_abs(S: float, K: float, T: float, sig: float, cp: str) -> float:
    sq = sig * math.sqrt(T)
    d1 = (math.log(S / K) + (RATE - DIV + 0.5 * sig * sig) * T) / sq
    return math.exp(-DIV * T) * (_ncdf(d1) if cp == "C" else _ncdf(-d1))


def _grid(S: float):
    base = round(S / STEP) * STEP
    return [base + STEP * i for i in range(-int(0.22 * S / STEP), int(0.22 * S / STEP) + 1)]


def strike_for_delta(S, T, sig, cp, target):
    return min((k for k in _grid(S) if (k > S if cp == "C" else k < S)),
               key=lambda k: abs(delta_abs(S, k, T, sig, cp) - target))


def strike_for_premium(S, T, sig, cp, target):
    return min(_grid(S), key=lambda k: abs(bs(S, k, T, sig, cp) - target))


def txn_cost(px: float, sell: bool) -> float:
    if px < 0.05:
        return 0.0
    turn = px * LOT
    exch = EXCH * turn
    c = BROKERAGE + exch + GST * (BROKERAGE + exch) + SEBI * turn + SLIP * LOT
    return c + (STT_SELL * turn if sell else STAMP_BUY * turn)


# ------------------------------------------------------------------ market data
def load_series() -> pd.DataFrame:
    cache = HERE / "out" / "yt_market.csv"
    if cache.exists():
        return pd.read_csv(cache, parse_dates=["date"]).set_index("date")
    rows = []
    for f in sorted((data_root() / "idx").glob("*.parquet")):
        d = pd.read_parquet(f, columns=["date", "index_name", "close"])
        d = d[d.index_name.isin(["Nifty 50", "India VIX"])]
        if len(d) == 2:
            r = {"date": pd.Timestamp(d.date.iloc[0])}
            r.update({("spot" if n == "Nifty 50" else "vix"): c for n, c in zip(d.index_name, d.close)})
            rows.append(r)
    m = pd.DataFrame(rows).set_index("date").sort_index()
    gaps = {}
    for f in sorted((data_root() / "cash").glob("*.parquet")):
        c = pd.read_parquet(f, columns=["date", "symbol", "prev_close", "open"],
                            filters=[("symbol", "==", "NIFTYBEES")])
        if len(c):
            gaps[pd.Timestamp(c.date.iloc[0])] = c.open.iloc[0] / c.prev_close.iloc[0] - 1.0
    m["etf_gap"] = pd.Series(gaps)
    m.to_csv(cache)
    return m


def prepare(m: pd.DataFrame):
    m = m.dropna(subset=["spot", "vix"]).copy()
    m["prev_spot"] = m.spot.shift(1)
    m["prev_vix"] = m.vix.shift(1)
    ret = m.spot / m.prev_spot - 1.0
    g = m.etf_gap
    ok = g.notna() & (g.abs() <= GAP_CAP) & ((g.abs() <= 0.002) | ((g * ret > 0) & (g.abs() <= ret.abs() + 0.002)))
    bad = ~ok
    m["open"] = m.prev_spot * (1 + g.where(ok, 0.0))
    return m.iloc[1:], int(bad.iloc[1:].sum())


def expiry_calendar(days: pd.DatetimeIndex):
    di = pd.DatetimeIndex(days)

    def roll(d):
        return di[di <= d][-1] if (di <= d).any() else None

    monthly, weekly = [], []
    for p in pd.period_range(di[0], di[-1] + pd.Timedelta(days=62), freq="M"):
        end = p.to_timestamp(how="end").normalize()
        wd = 1 if end >= pd.Timestamp("2025-09-01") else 3
        while end.weekday() != wd:
            end -= pd.Timedelta(days=1)
        monthly.append(end)
    d = di[0]
    while d <= di[-1] + pd.Timedelta(days=62):
        wd = 1 if d >= pd.Timestamp("2025-09-01") else 3
        weekly.append(d + pd.Timedelta(days=(wd - d.weekday()) % 7))
        d += pd.Timedelta(days=7)

    def fix(lst):
        out = []
        for e in lst:
            r = roll(e) if e <= di[-1] else e
            if r is not None:
                out.append(r)
        return sorted(set(out))
    return fix(monthly), fix(weekly)


# ------------------------------------------------------------------ position machinery
@dataclass
class Leg:
    side: int          # +1 long, -1 short
    cp: str
    K: float
    exp: pd.Timestamp
    entry: float
    tag: str = ""


@dataclass
class Pos:
    legs: list = field(default_factory=list)
    realized: float = 0.0      # gross, from closed legs
    costs: float = 0.0
    entry_date: pd.Timestamp = None
    credit_inr: float = 0.0
    adjustments: int = 0
    notes: dict = field(default_factory=dict)


def T_of(exp, t):
    return max((exp - t).days, 0) / 365.0


def leg_px(L, S, iv, t):
    return bs(S, L.K, T_of(L.exp, t), iv, L.cp)


def open_leg(pos, side, cp, K, exp, S, iv, t, tag=""):
    px = bs(S, K, T_of(exp, t), iv, cp)
    pos.legs.append(Leg(side, cp, K, exp, px, tag))
    pos.costs += txn_cost(px, sell=(side < 0))
    return px


def close_leg(pos, L, S, iv, t):
    px = leg_px(L, S, iv, t)
    pos.realized += L.side * (px - L.entry) * LOT
    pos.costs += txn_cost(px, sell=(L.side > 0))
    pos.legs.remove(L)
    return px


def gross(pos, S, iv, t):
    return pos.realized + sum(L.side * (leg_px(L, S, iv, t) - L.entry) * LOT for L in pos.legs)


def close_all(pos, S, iv, t):
    for L in list(pos.legs):
        close_leg(pos, L, S, iv, t)


def straddle_rebalance(pos, S, iv, t, exp_sold):
    """Close the profitable short leg and re-short the same type at the strike whose premium matches the other leg."""
    shorts = [L for L in pos.legs if L.side < 0]
    prem = {L.cp: leg_px(L, S, iv, t) for L in shorts}
    win = min(shorts, key=lambda L: prem[L.cp])
    other = max(shorts, key=lambda L: prem[L.cp])
    target = prem[other.cp]
    cp = win.cp
    close_leg(pos, win, S, iv, t)
    K = strike_for_premium(S, T_of(exp_sold, t), iv, cp, target)
    open_leg(pos, -1, cp, K, exp_sold, S, iv, t, "rebuilt")
    pos.adjustments += 1


# ------------------------------------------------------------------ strategies
def run_strategy(name, m, monthly, weekly):
    """One independent book entry per expiry cycle. Strangle entries (45-50 DTE) overlap the previous cycle's
    exit, so concurrent 1-lot positions are allowed there; condor and calendar hold at most one position."""
    dates = list(m.index)
    trades, equity = [], {}
    cum = 0.0
    book = []            # dicts: pos, meta, straddle, stage_hit
    done_exp = set()
    skipped = 0
    month_adj = {}
    for i, t in enumerate(dates):
        tp = dates[i - 1] if i else t      # open marks: no overnight theta (time basis = previous close)
        S_o, iv_o = m.open.iat[i], m.prev_vix.iat[i] / 100.0
        S_c, iv_c = m.spot.iat[i], m.vix.iat[i] / 100.0
        # ---- entry (fills at today's open proxy, decision uses yesterday's information)
        if name == "strangle" or not book:
            pos, meta = None, {}
            if name == "condor":
                E = next((e for e in monthly if 40 <= (e - tp).days <= 50 and e not in done_exp), None)
                if E:
                    done_exp.add(E)
                    pos = _enter_condor(S_o, iv_o, tp, E)
                    if pos is None:
                        skipped += 1
                    else:
                        meta = {"E": E}
            elif name == "strangle":
                E = next((e for e in monthly if 45 <= (e - tp).days <= 50 and e not in done_exp), None)
                if E:
                    done_exp.add(E)
                    pos = Pos(entry_date=t)
                    T = T_of(E, tp)
                    for cp in "CP":
                        K = strike_for_delta(S_o, T, iv_o, cp, 0.18)
                        open_leg(pos, -1, cp, K, E, S_o, iv_o, tp)
                    meta = {"E": E}
            elif name == "calendar":
                E1 = next((e for e in weekly if 10 <= (e - tp).days <= 12), None)
                if E1:
                    E2 = next(e for e in monthly if (e - E1).days >= 7)
                    pos = Pos(entry_date=t)
                    for cp in "CP":
                        Ks = strike_for_delta(S_o, T_of(E1, tp), iv_o, cp, 0.20)
                        ps = open_leg(pos, -1, cp, Ks, E1, S_o, iv_o, tp)
                        Kl = strike_for_premium(S_o, T_of(E2, tp), iv_o, cp, ps + LONG_ADD)
                        open_leg(pos, +1, cp, Kl, E2, S_o, iv_o, tp, "long")
                    meta = {"E": E1, "E2": E2}
            if pos is not None:
                pos.entry_date = t
                pos.credit_inr = sum(-L.side * L.entry for L in pos.legs) * LOT
                meta["entry_credit"] = pos.credit_inr
                book.append({"pos": pos, "meta": meta, "straddle": False, "stage_hit": set()})
        # ---- evaluate each older position: open-gap check, then close-of-day checks/adjustments
        for b in list(book):
            pos, meta = b["pos"], b["meta"]
            if pos.entry_date == t:
                continue
            g = gross(pos, S_o, iv_o, tp)
            why = _price_exit(name, pos, g)
            if why:
                _finish(pos, name, S_o, iv_o, tp, why + "@open", trades, meta, t)
                cum += trades[-1]["net"]
                book.remove(b)
                continue
            g = gross(pos, S_c, iv_c, t)
            why = _price_exit(name, pos, g) or _date_exit(name, pos, meta, t, dates, i, g)
            if why:
                _finish(pos, name, S_c, iv_c, t, why, trades, meta)
                cum += trades[-1]["net"]
                book.remove(b)
                continue
            if name == "strangle":
                loss = -g
                if not b["straddle"] and loss >= 1400:
                    straddle_rebalance(pos, S_c, iv_c, t, meta["E"])
                    b["straddle"] = True
                elif b["straddle"]:
                    for lv in (4000, 8000, 12000):
                        if loss >= lv and lv not in b["stage_hit"]:
                            b["stage_hit"].add(lv)
                            straddle_rebalance(pos, S_c, iv_c, t, meta["E"])
                            break
            elif name == "calendar":
                _calendar_adjust(pos, S_c, iv_c, t, meta, month_adj)
        equity[t] = cum + sum(gross(b["pos"], S_c, iv_c, t) - b["pos"].costs for b in book)
    return trades, pd.Series(equity), {"skipped": skipped, "open_at_end": len(book)}


def _enter_condor(S, iv, t, E):
    T = T_of(E, t)
    for wing in (0.16, 0.17, 0.15):
        pos = Pos(entry_date=t)
        ok = True
        for cp in "CP":
            Ks = strike_for_delta(S, T, iv, cp, 0.30)
            Kw = strike_for_delta(S, T, iv, cp, wing)
            if (cp == "C" and Kw <= Ks) or (cp == "P" and Kw >= Ks):
                ok = False
                break
            open_leg(pos, -1, cp, Ks, E, S, iv, t)
            open_leg(pos, +1, cp, Kw, E, S, iv, t, "wing")
        if not ok:
            continue
        credit = sum(-L.side * L.entry for L in pos.legs)
        width = max(abs(L.K - s.K) for L in pos.legs if L.side > 0 for s in pos.legs if s.side < 0 and s.cp == L.cp)
        if credit > 0 and width - credit <= 2 * credit:
            pos.notes["wing_delta"] = wing
            pos.notes["max_loss_inr"] = (width - credit) * LOT
            return pos
    return None


def _price_exit(name, pos, g):
    if name == "condor":
        if g >= 0.5 * pos.credit_inr:
            return "TP50"
        if g <= -pos.credit_inr:
            return "SL100"
    elif name == "strangle":
        if g >= 13000:
            return "TP"
        if g <= -13000:
            return "SL"
    elif name == "calendar":
        if g >= 5000:
            return "TP"
        if g <= -6000:
            return "SL"
    return None


def _date_exit(name, pos, meta, t, dates, i, g):
    E = meta["E"]
    dte = (E - t).days
    if name == "condor" and dte <= 15:
        return "15DTE"
    if name == "strangle":
        if t >= E:
            return "EXPIRY"
        if dte <= 7 and g < 0:
            return "7DTE_UNSTABLE"
    if name == "calendar" and (i + 1 < len(dates) and dates[i + 1] >= E):
        return "PRE_EXPIRY"
    return None


def _calendar_adjust(pos, S, iv, t, meta, month_adj):
    shorts = [L for L in pos.legs if L.side < 0]
    if len(shorts) != 2 or abs(shorts[0].K - shorts[1].K) <= STEP:
        return
    key = (t.year, t.month)
    if month_adj.get(key, 0) >= 4:
        return
    p = {L.cp: leg_px(L, S, iv, t) for L in shorts}
    hi, lo = max(p, key=p.get), min(p, key=p.get)
    if p[hi] < 2 * max(p[lo], 0.05):
        return
    E1, E2 = meta["E"], meta["E2"]
    for L in [x for x in pos.legs if x.cp == lo]:
        close_leg(pos, L, S, iv, t)
    Ks = strike_for_premium(S, T_of(E1, t), iv, lo, p[hi])
    ps = open_leg(pos, -1, lo, Ks, E1, S, iv, t, "rebuilt")
    Kl = strike_for_premium(S, T_of(E2, t), iv, lo, ps + LONG_ADD)
    open_leg(pos, +1, lo, Kl, E2, S, iv, t, "long")
    pos.adjustments += 1
    month_adj[key] = month_adj.get(key, 0) + 1


def _finish(pos, name, S, iv, t, why, trades, meta, exit_date=None):
    g_before = gross(pos, S, iv, t)
    close_all(pos, S, iv, t)
    exit_date = exit_date or t
    net = pos.realized - pos.costs
    sl = {"condor": pos.credit_inr, "strangle": 13000.0, "calendar": 6000.0}[name]
    trades.append({
        "strategy": name, "entry": pos.entry_date, "exit": exit_date, "reason": why, "gross": round(g_before, 2),
        "costs": round(pos.costs, 2), "net": round(net, 2), "sl_inr": round(sl, 2),
        "r": round(net / sl, 3) if sl else 0.0, "adjustments": pos.adjustments,
        "credit_inr": round(pos.credit_inr, 2), "days_held": (exit_date - pos.entry_date).days,
    })


# ------------------------------------------------------------------ statistics
def max_dd(eq: pd.Series) -> float:
    if eq.empty:
        return 0.0
    return float((eq.cummax() - eq).max())


def summarize(tr: pd.DataFrame, eq: pd.Series) -> dict:
    if tr.empty:
        return {"trades": 0}
    eq = eq - (eq.iloc[0] if len(eq) else 0.0)
    return {
        "trades": int(len(tr)), "win_pct": round(float((tr.net > 0).mean() * 100), 1),
        "avg_inr": round(float(tr.net.mean()), 0), "avg_r": round(float(tr.r.mean()), 3),
        "total_inr": round(float(tr.net.sum()), 0), "max_dd_inr": round(max_dd(eq), 0),
        "worst_inr": round(float(tr.net.min()), 0),
        "worst_vs_sl": round(float(-tr.net.min() / tr.sl_inr.iloc[tr.net.values.argmin()]), 2),
        "costs_inr": round(float(tr.costs.sum()), 0),
    }


def evaluate(name, trades, eq, cut, last):
    tr = pd.DataFrame(trades)
    out = {}
    if tr.empty:
        return {"train": {"trades": 0}, "test": {"trades": 0}, "walk_forward": {}, "survivor": False}
    tr["entry"] = pd.to_datetime(tr.entry)
    out["train"] = summarize(tr[tr.entry < cut], eq[eq.index < cut])
    out["test"] = summarize(tr[tr.entry >= cut], eq[eq.index >= cut])
    wins = {}
    for y in range(2018, last.year + 1):
        sub = tr[(tr.entry.dt.year == y)]
        if len(sub):
            wins[str(y)] = {"trades": int(len(sub)), "total_inr": round(float(sub.net.sum()), 0)}
    tot = sum(w["total_inr"] for w in wins.values())
    pos_w = sum(1 for w in wins.values() if w["total_inr"] > 0)
    out["walk_forward"] = {"windows": wins, "total_inr": tot, "positive_windows": pos_w, "n_windows": len(wins)}
    out["survivor"] = bool(out["test"].get("total_inr", 0) > 0 and tot > 0 and wins and pos_w >= len(wins) / 2)
    out["exit_reasons"] = tr.reason.value_counts().to_dict()
    out["avg_adjustments"] = round(float(tr.adjustments.mean()), 2)
    out["gap_breach_over_sl"] = int((tr.net < -1.1 * tr.sl_inr).sum())
    return out


def main():
    m, bad_gaps = prepare(load_series())
    monthly, weekly = expiry_calendar(m.index)
    cut = m.index[int(len(m) * TRAIN_FRAC)]
    res = {"generated": str(pd.Timestamp.now().date()), "data_first": str(m.index[0].date()),
           "data_last": str(m.index[-1].date()), "split_date": str(cut.date()),
           "bad_etf_open_prints": bad_gaps, "lot": LOT, "assumptions": ASSUMPTIONS, "strategies": {}}
    outdir = HERE / "results"
    outdir.mkdir(exist_ok=True)
    all_tr = []
    for name in ("condor", "strangle", "calendar"):
        trades, eq, extra = run_strategy(name, m, monthly, weekly)
        ev = evaluate(name, trades, eq, cut, m.index[-1])
        ev.update(extra)
        res["strategies"][name] = ev
        all_tr += trades
    pd.DataFrame(all_tr).to_csv(outdir / "options_yt_trades.csv", index=False)
    (outdir / "options_yt.json").write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
    _merge_edge_stats(res)
    print(json.dumps({k: {kk: vv for kk, vv in v.items() if kk in ("train", "test", "survivor")}
                      for k, v in res["strategies"].items()}, indent=1, default=str))
    return res


def _merge_edge_stats(res):
    p = HERE / "edge_stats.json"
    es = json.loads(p.read_text(encoding="utf-8"))
    es["options_yt"] = {
        "generated": res["generated"], "split_date": res["split_date"], "pricing": "Black-Scholes, flat IV = India VIX",
        "per": "1 lot (75), net of costs, Rs",
        "strategies": {k: {"train": v["train"], "test": v["test"],
                          "walk_forward_total_inr": v["walk_forward"].get("total_inr"),
                          "wf_positive_windows": f'{v["walk_forward"].get("positive_windows")}/{v["walk_forward"].get("n_windows")}',
                          "survivor": v["survivor"]} for k, v in res["strategies"].items()}}
    names = [f"options_yt:{k}" for k, v in res["strategies"].items() if v["survivor"]]
    es["survivors"] = [s for s in es.get("survivors", []) if not str(s).startswith("options_yt:")] + names
    p.write_text(json.dumps(es, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
