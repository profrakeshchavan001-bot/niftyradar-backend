"""Backtest of the 3 rule-fixed Nifty option structures on REAL NSE settle prices (no Black-Scholes pricing).

Prices: SETTLE_PR / SttlmPric of the actual NIFTY index-option contracts (data/idxopt). Black-Scholes is used ONLY to turn
a real settle price into an implied vol so a delta can be read off (rules are phrased in delta); it never prices a trade.
Entries: decided on the close of D-1 (strikes from the D-1 chain), filled on D at the contract's real opening price
(first-trade price in the bhavcopy; D settle if it did not trade at the open). Exits/adjustments/stops: evaluated ONLY on
real daily settle prices, so intraday stop touches are invisible and a gap loss is booked at that day's settle.
Costs are DOUBLED versus the modelled run (brokerage, exchange, STT, stamp, slippage all x2).
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.special import ndtr

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))
from common import DATA_DIR  # noqa: E402
import options_yt as oy  # noqa: E402  (shared costs/statistics helpers; its pricing is NOT used here)

LOT = oy.LOT
RATE, DIV = oy.RATE, oy.DIV
COST_MULT = 2.0
LONG_ADD = oy.LONG_ADD
TRAIN_END = pd.Timestamp("2022-12-31")
SYMBOL = "NIFTY"
SPOT_FILE = "nifty50_ohlc.csv"
STRIKE_STEP = 50.0


def configure(symbol="NIFTY", cost_mult=2.0):
    """Switch the study to another index (NIFTY / BANKNIFTY) and cost multiplier. Rupee rules stay frozen; the lot is
    chosen so the notional is comparable to 1 Nifty lot (75 x ~20k = 1.5M; BANKNIFTY 30 x ~45k = 1.35M)."""
    global SYMBOL, SPOT_FILE, STRIKE_STEP, LOT, COST_MULT
    SYMBOL, COST_MULT = symbol, cost_mult
    if symbol == "BANKNIFTY":
        SPOT_FILE, STRIKE_STEP, LOT = "banknifty_ohlc.csv", 100.0, 30
    else:
        SPOT_FILE, STRIKE_STEP, LOT = "nifty50_ohlc.csv", 50.0, 75
    oy.LOT = LOT
    spot_table.cache_clear()


def cost(px, sell):
    return COST_MULT * oy.txn_cost(px, sell)


# ------------------------------------------------------------------ implied vol / delta from REAL prices
def _bs_vec(S, K, T, sig, call):
    sq = sig * np.sqrt(T)
    d1 = (np.log(S / K) + (RATE - DIV + 0.5 * sig * sig) * T) / sq
    d2 = d1 - sq
    c = S * np.exp(-DIV * T) * ndtr(d1) - K * np.exp(-RATE * T) * ndtr(d2)
    p = K * np.exp(-RATE * T) * ndtr(-d2) - S * np.exp(-DIV * T) * ndtr(-d1)
    return np.where(call, c, p), d1


def iv_delta(price, S, K, T, call):
    """Implied vol by bisection on the real price, then |delta|. NaN where the price is not attainable."""
    price, K, call = map(np.asarray, (price, K, call))
    lo, hi = np.full(price.shape, 0.01), np.full(price.shape, 3.0)
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        v, _ = _bs_vec(S, K, T, mid, call)
        up = v < price
        lo, hi = np.where(up, mid, lo), np.where(up, hi, mid)
    iv = 0.5 * (lo + hi)
    v, d1 = _bs_vec(S, K, T, iv, call)
    ok = (np.abs(v - price) < 0.5) & (iv > 0.011) & (iv < 2.99)
    dl = np.where(call, np.exp(-DIV * T) * ndtr(d1), np.exp(-DIV * T) * ndtr(-d1))
    return np.where(ok, iv, np.nan), np.where(ok, dl, np.nan)


# ------------------------------------------------------------------ data
@lru_cache(maxsize=1)
def spot_table() -> pd.DataFrame:
    return pd.read_csv(DATA_DIR / "nifty" / SPOT_FILE, parse_dates=["date"]).set_index("date")


class Day:
    """One session: spot OHLC plus the NIFTY option chain with real settle/open prices."""

    def __init__(self, d: pd.Timestamp):
        self.date = d
        sp = spot_table().loc[d]
        self.S_open, self.S_close = float(sp.open), float(sp.close)
        df = pd.read_parquet(DATA_DIR / "idxopt" / f"{d:%Y-%m-%d}.parquet")
        df = df[(df.symbol == SYMBOL) & (df.kind == "O")].copy()
        df["expiry"] = pd.to_datetime(df.expiry)
        df["cp"] = df.opt_type
        # On expiry day the bhavcopy stamps the index settlement value in the settle column of EVERY strike (not the
        # option payoff), so expiring contracts are valued at intrinsic value against the Nifty close (cash settlement).
        ex = df.expiry == d
        intr = np.where(df.cp == "C", np.maximum(self.S_close - df.strike, 0.0), np.maximum(df.strike - self.S_close, 0.0))
        df.loc[ex, "settle"] = intr[ex.values]
        self.chain = df
        keys = list(zip(df.expiry, df.strike, df.cp))
        self.settle = dict(zip(keys, df.settle))
        self.opn = dict(zip(keys, df.open))
        self.expiries = sorted(df.expiry.unique())

    def table(self, expiry, tref: pd.Timestamp):
        """OTM, open-interest contracts of one expiry with settle, implied vol and |delta| (spot = this day's close)."""
        df = self.chain[(self.chain.expiry == expiry) & (self.chain.oi > 0) & (self.chain.settle >= 1.0)]
        df = df[((df.cp == "C") & (df.strike > self.S_close)) | ((df.cp == "P") & (df.strike < self.S_close))]
        T = max((expiry - tref).days, 0.5) / 365.0
        iv, dl = iv_delta(df.settle.values, self.S_close, df.strike.values, T, (df.cp == "C").values)
        return df.assign(iv=iv, delta=dl).dropna(subset=["delta"])


def pick_delta(tb, cp, target, tol=0.07):
    t = tb[tb.cp == cp]
    if t.empty:
        return None
    r = t.iloc[(t.delta - target).abs().argmin()]
    return r if abs(r.delta - target) <= tol else None


def pick_prem(tb, cp, target):
    t = tb[tb.cp == cp]
    return None if t.empty else t.iloc[(t.settle - target).abs().argmin()]


# ------------------------------------------------------------------ positions
@dataclass
class Leg:
    side: int
    cp: str
    K: float
    exp: pd.Timestamp
    entry: float
    last: float
    tag: str = ""


@dataclass
class Pos:
    legs: list = field(default_factory=list)
    realized: float = 0.0
    costs: float = 0.0
    entry_date: pd.Timestamp = None
    credit_inr: float = 0.0
    adjustments: int = 0
    stale_marks: int = 0
    open_fallbacks: int = 0
    meta: dict = field(default_factory=dict)
    straddle: bool = False
    stage_hit: set = field(default_factory=set)


def mark(L: Leg, day: Day, pos: Pos) -> float:
    k = (L.exp, L.K, L.cp)
    v = day.settle.get(k)
    if v is not None and v == v:
        L.last = float(v)
    else:
        pos.stale_marks += 1
    return L.last


def open_leg(pos, day, side, cp, K, exp, tag="", at_close=False):
    k = (exp, K, cp)
    if at_close:
        px = float(day.settle[k])
    else:
        px = float(day.opn.get(k, 0.0))
        if not px > 0:
            px = float(day.settle.get(k, np.nan))
            pos.open_fallbacks += 1
    pos.legs.append(Leg(side, cp, K, exp, px, float(day.settle.get(k, px)), tag))
    pos.costs += cost(px, sell=side < 0)
    return px


def close_leg(pos, L, day):
    px = mark(L, day, pos)
    pos.realized += L.side * (px - L.entry) * LOT
    pos.costs += cost(px, sell=L.side > 0)
    pos.legs.remove(L)
    return px


def gross(pos, day):
    return pos.realized + sum(L.side * (mark(L, day, pos) - L.entry) * LOT for L in pos.legs)


def close_all(pos, day):
    for L in list(pos.legs):
        close_leg(pos, L, day)


def rebalance(pos, day, exp):
    """Close the profitable short leg, re-short that type at the real strike whose settle matches the other leg's."""
    shorts = [L for L in pos.legs if L.side < 0]
    pr = {L.cp: mark(L, day, pos) for L in shorts}
    win = min(shorts, key=lambda L: pr[L.cp])
    oth = max(shorts, key=lambda L: pr[L.cp])
    cp, target = win.cp, pr[oth.cp]
    close_leg(pos, win, day)
    t = day.chain[(day.chain.expiry == exp) & (day.chain.cp == cp) & (day.chain.oi > 0) & (day.chain.settle > 1.0)]
    if t.empty:
        return False
    r = t.iloc[(t.settle - target).abs().argmin()]
    open_leg(pos, day, -1, cp, float(r.strike), exp, "rebuilt", at_close=True)
    pos.adjustments += 1
    return True


def monthly_expiries(exps):
    s = pd.Series(sorted(set(exps)))
    return list(s.groupby([s.dt.year, s.dt.month]).max())


def price_exit(name, pos, g):
    P = pos.meta.get("P", {})
    if name == "condor":
        if g >= 0.5 * pos.credit_inr:
            return "TP50"
        if g <= -P.get("sl_mult", 1.0) * pos.credit_inr:
            return "SL100"
    elif name.startswith("strangle"):
        if g >= P.get("tp", 13000):
            return "TP"
        if g <= -P.get("sl", 13000):
            return "SL"
    elif name == "calendar":
        if g >= 5000:
            return "TP"
        if g <= -6000:
            return "SL"
    return None


def sl_of(name, pos):
    P = pos.meta.get("P", {})
    if name == "condor":
        return P.get("sl_mult", 1.0) * pos.credit_inr
    return float(P.get("sl", 13000)) if name.startswith("strangle") else 6000.0


def finish(pos, name, day, why, trades):
    g = gross(pos, day)
    close_all(pos, day)
    sl = sl_of(name, pos)
    net = pos.realized - pos.costs
    trades.append({"strategy": name, "entry": pos.entry_date, "exit": day.date, "reason": why, "gross": round(g, 2),
                   "costs": round(pos.costs, 2), "net": round(net, 2), "sl_inr": round(sl, 2),
                   "r": round(net / sl, 3) if sl else 0.0, "adjustments": pos.adjustments,
                   "credit_inr": round(pos.credit_inr, 2), "days_held": (day.date - pos.entry_date).days,
                   "open_fallbacks": pos.open_fallbacks, "stale_marks": pos.stale_marks,
                   "spot_entry": pos.meta.get("spot_entry"), "spot_exit": day.S_close,
                   "margin_est": pos.meta.get("margin_est"), "expiry": pos.meta.get("E")})


DEFAULTS = {
    "condor": {"short_delta": 0.30, "wing_delta": (0.16, 0.17, 0.15), "dte_lo": 40, "dte_hi": 50, "exit_dte": 15},
    "strangle_d18": {"mode": "delta", "delta": 0.18, "dte_lo": 45, "dte_hi": 50, "adj_loss": 1400},
    "strangle_p100": {"mode": "premium", "premium": 100.0, "dte_lo": 45, "dte_hi": 50, "adj_loss": 1400},
    "calendar": {"delta": 0.20, "dte_lo": 10, "dte_hi": 12},
}


def margin_estimate(name, S, pos):
    """No SPAN file is available. Rough broker-style estimate (labelled as such in the report)."""
    notional = S * LOT
    if name == "condor":
        width = max(abs(a.K - b.K) for a in pos.legs if a.side > 0 for b in pos.legs if b.side < 0 and b.cp == a.cp)
        return round(width * LOT + 0.02 * notional)
    if name.startswith("strangle"):
        return round(0.115 * notional)
    return round(0.06 * notional)  # calendar: short near-expiry legs hedged by long farther-dated legs


LAST_STATE: dict = {}  # open book / last session after run(); read by the paper-forward harness


def run(name, days, params=None):
    P = {**DEFAULTS[name], **(params or {})}
    trades, equity, book = [], {}, []
    cum = 0.0
    done = set()
    skipped = 0
    month_adj = {}
    prev = None
    sess_idx = {d: k for k, d in enumerate(days)}
    for i, d in enumerate(days):
        try:
            day = Day(d)
        except Exception:
            day = None
        if day is None or day.chain.empty:
            equity[d] = cum + (sum(gross(p, prev) - p.costs for p in book) if (book and prev) else 0.0)
            continue
        # ---- entry: decide on the previous session's chain, fill at today's real opens
        if prev is not None and (name.startswith("strangle") or not book):
            pos = None
            if name in ("condor", "strangle_d18", "strangle_p100"):
                if "entry_pick" in P:  # null test: one pre-drawn fill day per expiry
                    cand = [e for e in prev.expiries if P["entry_pick"].get(e) == d]
                elif P.get("entry_tdays") is not None:  # N SESSIONS before the (real, listed) expiry
                    cand = [e for e in prev.expiries if _sess_pos(e, sess_idx, days) - i == P["entry_tdays"]]
                elif P.get("weekly"):  # any listed expiry, DTE counted from the fill day (0 = expiry-day entry)
                    cand = [e for e in prev.expiries if P["entry_lo"] <= (e - d).days <= P["entry_hi"]]
                else:
                    cand = [e for e in monthly_expiries(prev.expiries) if P["dte_lo"] <= (e - prev.date).days <= P["dte_hi"]]
                E = next((e for e in cand if e not in done), None)
                if E is not None:
                    done.add(E)
                    pos = enter_condor(prev, day, E, P) if name == "condor" else enter_strangle(prev, day, E, P)
                    skipped += pos is None
            elif name == "calendar":
                E1 = next((e for e in prev.expiries
                           if P["dte_lo"] <= (e - prev.date).days <= P["dte_hi"] and e not in done), None)
                if E1 is not None:
                    done.add(E1)
                    pos = enter_calendar(prev, day, E1, P)
                    skipped += pos is None
            if pos is not None:
                pos.entry_date = d
                pos.credit_inr = sum(-L.side * L.entry for L in pos.legs) * LOT
                pos.meta["spot_entry"] = prev.S_close
                pos.meta["margin_est"] = margin_estimate(name, prev.S_close, pos)
                pos.meta["P"] = P
                if pos.meta["E"] <= d:  # expiry-day entry: cash-settled at the day's settle, no overnight exposure
                    finish(pos, name, day, "EXPIRY0", trades)
                    cum += trades[-1]["net"]
                else:
                    book.append(pos)
        # ---- evaluate older positions on today's real settles
        for pos in list(book):
            if pos.entry_date == d:
                continue
            g = gross(pos, day)
            why = price_exit(name, pos, g) or date_exit(name, pos, day, P, days, i, g)
            if why:
                finish(pos, name, day, why, trades)
                cum += trades[-1]["net"]
                book.remove(pos)
                continue
            if name.startswith("strangle"):
                loss = -g
                if not pos.straddle and loss >= P["adj_loss"]:
                    rebalance(pos, day, pos.meta["E"])
                    pos.straddle = True
                elif pos.straddle:
                    for lv in (4000, 8000, 12000):
                        if loss >= lv and lv not in pos.stage_hit:
                            pos.stage_hit.add(lv)
                            rebalance(pos, day, pos.meta["E"])
                            break
            elif name == "calendar":
                calendar_adjust(pos, day, month_adj)
        equity[d] = cum + sum(gross(p, day) - p.costs for p in book)
        prev = day
    LAST_STATE.update({"book": book, "done": done, "prev": prev, "params": P})
    return trades, pd.Series(equity), {"skipped": skipped, "open_at_end": len(book)}


def _sess_pos(e, sess_idx, days):
    """Session index of expiry e. Past the last stored session (live use) weekdays are counted instead, because the NSE
    holiday calendar is not in the data (indicative only); returns -inf for dates that are neither."""
    if e in sess_idx:
        return sess_idx[e]
    last = days[-1]
    if e > last:
        return len(days) - 1 + int(np.busday_count(last.date(), e.date()))
    return -10 ** 9


def date_exit(name, pos, day, P, days, i, g):
    E = pos.meta["E"]
    dte = (E - day.date).days
    if name == "condor" and dte <= P["exit_dte"]:
        return "15DTE"
    if name == "condor" and day.date >= E:
        return "EXPIRY"
    if name.startswith("strangle"):
        if day.date >= E:
            return "EXPIRY"
        if dte <= P.get("unstable_dte", 7) and g < 0:
            return "7DTE_UNSTABLE"
    if name == "calendar" and (day.date >= E or (i + 1 < len(days) and days[i + 1] >= E)):
        return "PRE_EXPIRY"
    return None


def enter_condor(prev, day, E, P):
    tb = prev.table(E, prev.date)
    for wing in P["wing_delta"]:
        legs, ok = {}, True
        for cp in "CP":
            s, w = pick_delta(tb, cp, P["short_delta"]), pick_delta(tb, cp, wing)
            if s is None or w is None or (cp == "C" and w.strike <= s.strike) or (cp == "P" and w.strike >= s.strike):
                ok = False
                break
            legs[cp] = (s, w)
        if not ok:
            continue
        if any((E, x.strike, cp) not in day.settle for cp, pair in legs.items() for x in pair):
            return None
        pos = Pos()
        pos.meta["E"] = E
        for cp, (s, w) in legs.items():
            open_leg(pos, day, -1, cp, float(s.strike), E)
            open_leg(pos, day, +1, cp, float(w.strike), E, "wing")
        credit = sum(-L.side * L.entry for L in pos.legs)
        width = max(abs(a.K - b.K) for a in pos.legs if a.side > 0 for b in pos.legs if b.side < 0 and b.cp == a.cp)
        if credit > 0 and width - credit <= 2 * credit:
            pos.meta["wing"] = wing
            return pos
    return None


def enter_strangle(prev, day, E, P):
    tb = prev.table(E, prev.date)
    pos = Pos()
    pos.meta["E"] = E
    for cp in "CP":
        r = pick_delta(tb, cp, P["delta"], 0.09) if P["mode"] == "delta" else pick_prem(tb, cp, P["premium"])
        if r is None or (E, r.strike, cp) not in day.settle:
            return None
        open_leg(pos, day, -1, cp, float(r.strike), E)
    return pos


def enter_calendar(prev, day, E1, P):
    later = [e for e in monthly_expiries(prev.expiries) if (e - E1).days >= 7]
    if not later:
        return None
    E2 = later[0]
    t1, t2 = prev.table(E1, prev.date), prev.table(E2, prev.date)
    pos = Pos()
    pos.meta.update({"E": E1, "E2": E2})
    for cp in "CP":
        s = pick_delta(t1, cp, P["delta"])
        if s is None or (E1, s.strike, cp) not in day.settle:
            return None
        sp = float(day.opn.get((E1, s.strike, cp), 0.0)) or float(day.settle[(E1, s.strike, cp)])
        lg = pick_prem(t2, cp, sp + LONG_ADD)
        if lg is None or (E2, lg.strike, cp) not in day.settle:
            return None
        open_leg(pos, day, -1, cp, float(s.strike), E1)
        open_leg(pos, day, +1, cp, float(lg.strike), E2, "long")
    return pos


def calendar_adjust(pos, day, month_adj):
    shorts = [L for L in pos.legs if L.side < 0]
    if len(shorts) != 2 or abs(shorts[0].K - shorts[1].K) <= STRIKE_STEP:
        return
    key = (day.date.year, day.date.month)
    if month_adj.get(key, 0) >= 4:
        return
    pr = {L.cp: mark(L, day, pos) for L in shorts}
    hi, lo = max(pr, key=pr.get), min(pr, key=pr.get)
    if pr[hi] < 2 * max(pr[lo], 0.05):
        return
    E1, E2 = pos.meta["E"], pos.meta["E2"]

    def side(exp):
        return day.chain[(day.chain.expiry == exp) & (day.chain.cp == lo) & (day.chain.oi > 0) & (day.chain.settle > 1.0)]
    c1, c2 = side(E1), side(E2)
    if c1.empty or c2.empty:
        return
    for L in [x for x in pos.legs if x.cp == lo]:
        close_leg(pos, L, day)
    s = c1.iloc[(c1.settle - pr[hi]).abs().argmin()]
    open_leg(pos, day, -1, lo, float(s.strike), E1, "rebuilt", at_close=True)
    lg = c2.iloc[(c2.settle - (float(s.settle) + LONG_ADD)).abs().argmin()]
    open_leg(pos, day, +1, lo, float(lg.strike), E2, "long", at_close=True)
    pos.adjustments += 1
    month_adj[key] = month_adj.get(key, 0) + 1


# ------------------------------------------------------------------ statistics
def evaluate(trades, eq):
    tr = pd.DataFrame(trades)
    if tr.empty:
        return {"train": {"trades": 0}, "test": {"trades": 0},
                "walk_forward": {"windows": {}, "total_inr": 0, "positive_windows": 0, "n_windows": 0},
                "survivor": False, "verdict": "not enough data"}
    tr["entry"] = pd.to_datetime(tr.entry)
    cut = TRAIN_END + pd.Timedelta(days=1)
    out = {"train": oy.summarize(tr[tr.entry < cut], eq[eq.index < cut]),
           "test": oy.summarize(tr[tr.entry >= cut], eq[eq.index >= cut])}
    wins = {}
    for y in sorted(tr.entry.dt.year.unique()):
        sub = tr[tr.entry.dt.year == y]
        wins[str(y)] = {"trades": int(len(sub)), "total_inr": round(float(sub.net.sum()), 0)}
    tot = sum(w["total_inr"] for w in wins.values())
    pos_w = sum(w["total_inr"] > 0 for w in wins.values())
    out["walk_forward"] = {"windows": wins, "total_inr": tot, "positive_windows": pos_w, "n_windows": len(wins)}
    t = out["test"]
    enough = t.get("trades", 0) >= 20 and out["train"].get("trades", 0) >= 20
    out["survivor"] = bool(enough and t.get("total_inr", 0) > 0 and tot > 0 and pos_w >= len(wins) / 2)
    out["verdict"] = "not enough data" if not enough else ("survives" if out["survivor"] else "dies")
    out["exit_reasons"] = tr.reason.value_counts().to_dict()
    out["avg_adjustments"] = round(float(tr.adjustments.mean()), 2)
    out["trades_over_1_1x_sl"] = int((tr.net < -1.1 * tr.sl_inr).sum())
    out["open_fallback_entries"] = int((tr.open_fallbacks > 0).sum())
    out["stale_mark_trades"] = int((tr.stale_marks > 0).sum())
    out["margin_est_inr"] = {"median": float(tr.margin_est.median()), "max": float(tr.margin_est.max())}
    out["return_on_margin_pct_test"] = (round(100 * t["total_inr"] / out["margin_est_inr"]["median"], 1)
                                        if t.get("trades") else None)
    return out


def trading_days():
    have = {p.stem for p in (DATA_DIR / "idxopt").glob("*.parquet")}
    return [d for d in spot_table().index if f"{d:%Y-%m-%d}" in have]


def main(names=None, tag=""):
    days = trading_days()
    res = {"generated": str(pd.Timestamp.now().date()), "first": str(days[0].date()), "last": str(days[-1].date()),
           "n_days": len(days), "train": "entries to 2022-12-31", "test": "entries from 2023-01-01",
           "cost_multiplier": COST_MULT, "lot": LOT, "symbol": SYMBOL, "strategies": {}}
    outdir = HERE / "results"
    outdir.mkdir(exist_ok=True)
    all_tr = []
    for name in names or ("condor", "strangle_d18", "strangle_p100", "calendar"):
        trades, eq, extra = run(name, days)
        ev = evaluate(trades, eq)
        ev.update(extra)
        res["strategies"][name] = ev
        all_tr += trades
        print(name, ev["train"], ev["test"], ev["verdict"], flush=True)
    pd.DataFrame(all_tr).to_csv(outdir / f"options_real{tag}_trades.csv", index=False)
    (outdir / f"options_real{tag}.json").write_text(json.dumps(res, indent=1, default=str), encoding="utf-8")
    return res


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*")
    ap.add_argument("--symbol", default="NIFTY")
    ap.add_argument("--cost", type=float, default=2.0)
    a = ap.parse_args()
    configure(a.symbol, a.cost)
    tag = "" if (a.symbol == "NIFTY" and a.cost == 2.0) else f"_{a.symbol.lower()}_x{a.cost:g}"
    main(a.names or None, tag)
