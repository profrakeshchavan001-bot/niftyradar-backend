"""Signal backtest core (CC4): point-in-time trade simulation for ANY NiftyRadar signal.

Zero lookahead: a signal dated D uses data up to D's close; the trade enters at D+1's open.
Two ways to trade every signal:
  (a) the underlying stock (stop/target/time rule on the stock's own daily bars),
  (b) an option buy (ATM or 1-ITM call for longs / put for shorts, expiry >= 10 days out) priced from
      EOD bhavcopy. Entry = the option's real next-day OPEN. The exit follows the SAME underlying stop/
      target/time rule; because only EOD option data exists the intraday option path is APPROXIMATE:
        time exit      -> option's real EOD close that day,
        gap through    -> option's real open that day,
        intraday level -> Black-Scholes price at the stop/target level, vol implied from that day's EOD close.
Capital model: Rs 1,00,000, risk 1.5% of equity per trade, max 2 open positions, costs and slippage at 2x
normal (stock leg costed as stock futures; option leg with option STT/exchange/GST). Train = entries to 2022-12-31, test = entries from 2023-01-01 (independent Rs 1,00,000 runs).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

CAPITAL = 100_000.0
RISK_PCT = 1.5
MAX_OPEN = 2
NOTIONAL_CAP = 0.5            # a stock position may use at most 50% of equity (no leverage)
OPTION_OUTLAY_CAP = 0.25      # a premium outlay may use at most 25% of equity
COST_MULT = 2.0
TRAIN_END = pd.Timestamp("2022-12-31")
TEST_START = pd.Timestamp("2023-01-01")
MIN_TRADES = 30               # per period, else TOO FEW TRADES
RATE = 0.07


# ------------------------------------------------------------------ world (daily bars, point in time)
class World:
    def __init__(self, cash: pd.DataFrame):
        cash = cash.drop_duplicates(["date", "symbol"], keep="last")
        w = lambda c: cash.pivot(index="date", columns="symbol", values=c).sort_index()  # noqa: E731
        self.O, self.H, self.L, self.C, self.PC = (w(c) for c in ("open", "high", "low", "close", "prev_close"))
        self.V = w("volume")
        self.dates = self.C.index
        self.cols = {s: i for i, s in enumerate(self.C.columns)}
        self.pos = {d: i for i, d in enumerate(self.dates)}
        tr = np.maximum(self.H - self.L, np.maximum((self.H - self.PC).abs(), (self.L - self.PC).abs()))
        self.ATR = tr.rolling(14, min_periods=14).mean()
        self.o, self.h, self.l, self.c, self.atr = (x.to_numpy() for x in (self.O, self.H, self.L, self.C, self.ATR))


# ------------------------------------------------------------------ underlying trade rule
def sim_underlying(w: World, sym: str, di: int, side: str, atr_mult: float = 1.5, rr: float = 2.0, hold: int = 5,
                   stop_dist: float | None = None, target_px: float | None = None) -> dict | None:
    """Enter at the next open, stop `atr_mult` x ATR(D) away, target `rr` R, time exit on the `hold`-th day's close.
    Same-day stop and target -> stop first. Gaps fill at the open."""
    j = w.cols.get(sym)
    e = di + 1
    n = len(w.dates)
    if j is None or e >= n:
        return None
    entry = w.o[e, j]
    risk = stop_dist if stop_dist is not None else atr_mult * w.atr[di, j]
    if not (entry > 0 and risk and risk > 0 and not np.isnan(risk)):
        return None
    sgn = 1.0 if side == "long" else -1.0
    stop = entry - sgn * risk
    target = target_px if target_px is not None else entry + sgn * rr * risk
    if (sgn > 0 and target <= entry) or (sgn < 0 and target >= entry):
        return None
    px = kind = None
    last = min(e + hold - 1, n - 1)
    d = e
    for d in range(e, last + 1):
        k = d - e
        o, h, l, c = w.o[d, j], w.h[d, j], w.l[d, j], w.c[d, j]
        if np.isnan(c):
            continue
        if sgn > 0:
            if o <= stop and k > 0:
                px, kind = o, "gap_stop"
            elif l <= stop:
                px, kind = stop, "stop"
            elif o >= target and k > 0:
                px, kind = o, "gap_target"
            elif h >= target:
                px, kind = target, "target"
        else:
            if o >= stop and k > 0:
                px, kind = o, "gap_stop"
            elif h >= stop:
                px, kind = stop, "stop"
            elif o <= target and k > 0:
                px, kind = o, "gap_target"
            elif l <= target:
                px, kind = target, "target"
        if px is None and d == last:
            px, kind = c, "time"
        if px is not None:
            break
    if px is None:
        return None
    return dict(entry_idx=e, exit_idx=d, entry=float(entry), exit=float(px), kind=kind, risk=float(risk),
                stop=float(stop), target=float(target), side=side, sym=sym, atr=float(w.atr[di, j]))


# ------------------------------------------------------------------ costs (Indian, doubled)
def stock_costs(value_in: float, value_out: float, side: str, slip_frac: float) -> float:
    """Round-trip Rs cost, x COST_MULT. Every signal lives in the F&O universe, so the stock leg is costed as a
    stock-futures trade (long or short): brokerage 0.03% of turnover, STT 0.02% of the sell value, exchange
    0.00183%, stamp 0.002% of the buy value, 18% GST on brokerage+exchange, plus slippage of 5% of ATR per side."""
    sell, buy = (value_out, value_in) if side == "long" else (value_in, value_out)
    brok = 0.0003 * (value_in + value_out)
    stt = 0.0002 * sell
    exch = 0.0000183 * (value_in + value_out)
    stamp = 0.00002 * buy
    gst = 0.18 * (brok + exch)
    slip = slip_frac * (value_in + value_out)    # slip_frac = 5% of ATR/price per side
    return COST_MULT * (brok + stt + exch + gst + stamp + slip)


def option_costs(prem_in: float, prem_out: float, qty: float) -> float:
    vin, vout = prem_in * qty, prem_out * qty
    brok = 2 * 20.0
    stt = 0.001 * vout
    exch = 0.0003503 * (vin + vout)
    stamp = 0.00003 * vin
    gst = 0.18 * (brok + exch)
    slip = 0.01 * (vin + vout)                   # 1% of premium per side, doubled below
    return COST_MULT * (brok + stt + exch + stamp + gst + slip)


# ------------------------------------------------------------------ Black-Scholes
def _ncdf(x: float) -> float:
    return 0.5 * math.erfc(-x / math.sqrt(2))


def bs_price(S: float, K: float, T: float, sig: float, call: bool, r: float = RATE) -> float:
    if S <= 0:
        S = 1e-6
    if T <= 0 or sig <= 0:
        return max(S - K, 0.0) if call else max(K - S, 0.0)
    d1 = (math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * math.sqrt(T))
    d2 = d1 - sig * math.sqrt(T)
    if call:
        return S * _ncdf(d1) - K * math.exp(-r * T) * _ncdf(d2)
    return K * math.exp(-r * T) * _ncdf(-d2) - S * _ncdf(-d1)


def implied_vol(price: float, S: float, K: float, T: float, call: bool) -> float | None:
    intrinsic = max(S - K, 0.0) if call else max(K - S, 0.0)
    if price <= intrinsic + 1e-6 or T <= 0:
        return None
    lo, hi = 0.01, 4.0
    if bs_price(S, K, T, hi, call) < price:
        return None
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if bs_price(S, K, T, mid, call) < price:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ------------------------------------------------------------------ option chain store
class OptionStore:
    """Stock option rows, one parquet per trading day (data/stockopt_days), read lazily with a small cache."""

    def __init__(self, folder: Path, keep: int = 40):
        self.folder, self.keep, self.cache = Path(folder), keep, {}

    def _load(self, date) -> pd.DataFrame | None:
        d = pd.Timestamp(date)
        if d in self.cache:
            return self.cache[d]
        p = self.folder / f"{d:%Y-%m-%d}.parquet"
        df = pd.read_parquet(p) if p.exists() else None
        if df is not None:
            df["opt_type"] = df["opt_type"].astype(str)
            df = df.set_index("symbol").sort_index()
        if len(self.cache) >= self.keep:
            self.cache.pop(next(iter(self.cache)))
        self.cache[d] = df
        return df

    def day(self, sym: str, date) -> pd.DataFrame | None:
        df = self._load(date)
        if df is None or sym not in df.index:
            return None
        r = df.loc[[sym]]
        return r.reset_index()


def pick_contract(rows: pd.DataFrame, date: pd.Timestamp, spot: float, side: str, moneyness: str,
                  min_dte: int) -> pd.Series | None:
    """Expiry: first with DTE in [min_dte, 15] else first with DTE >= min_dte. Strike: ATM or 1 ITM. Needs a real open."""
    typ = "C" if side == "long" else "P"
    r = rows[rows["opt_type"] == typ]
    if r.empty:
        return None
    dte = (r["expiry"] - date).dt.days
    exps = sorted(r.loc[dte >= min_dte, "expiry"].unique())
    if not exps:
        return None
    window = [e for e in exps if (e - date).days <= 15]
    exp = window[0] if window else exps[0]
    r = r[r["expiry"] == exp].sort_values("strike")
    ks = r["strike"].to_numpy(dtype=float)
    if len(ks) < 3:
        return None
    i = int(np.argmin(np.abs(ks - spot)))
    if moneyness == "itm1":
        i = max(i - 1, 0) if side == "long" else min(i + 1, len(ks) - 1)
    c = r.iloc[i]
    if not (c["open"] > 0 and c["volume"] > 0):
        return None
    return c


def price_option_trade(w: World, store: OptionStore, tr: dict, moneyness: str, hold_cal_min: int) -> dict | None:
    """Turn an underlying trade (entry/exit/kind) into an option trade; None if no tradable contract."""
    sym, side = tr["sym"], tr["side"]
    d_in, d_out = w.dates[tr["entry_idx"]], w.dates[tr["exit_idx"]]
    rows = store.day(sym, d_in)
    if rows is None:
        return None
    spot_in = tr["entry"]
    c = pick_contract(rows, d_in, spot_in, side, moneyness, hold_cal_min)
    if c is None:
        return None
    K, exp, call = float(c["strike"]), c["expiry"], side == "long"
    prem_in = float(c["open"])
    T_in = (exp - d_in).days / 365.0
    iv_in = implied_vol(prem_in, spot_in, K, T_in, call)
    out_rows = store.day(sym, d_out)
    cx = None
    if out_rows is not None:
        m = out_rows[(out_rows["expiry"] == exp) & (out_rows["strike"] == K) & (out_rows["opt_type"] == c["opt_type"])]
        if len(m):
            cx = m.iloc[0]
    T_out = max((exp - d_out).days, 0) / 365.0
    iv_out = None
    if cx is not None and cx["volume"] > 0 and cx["close"] > 0:
        iv_out = implied_vol(float(cx["close"]), float(w.c[tr["exit_idx"], w.cols[sym]]), K, T_out, call)
    iv = iv_out or iv_in
    kind = tr["kind"]
    if kind == "time":
        if cx is None:
            return None
        prem_out = float(cx["close"]) if cx["volume"] > 0 and cx["close"] > 0 else float(cx["settle"])
        how = "eod_close"
    elif kind.startswith("gap") and cx is not None and cx["open"] > 0:
        prem_out, how = float(cx["open"]), "eod_open"
    else:
        if not iv:
            return None
        prem_out, how = bs_price(tr["exit"], K, T_out, iv, call), "bs_level"
    prem_out = max(prem_out, 0.05)
    # premium at the stop level on the entry day: sizes the position so a stop-out costs ~ the risk amount
    iv0 = iv_in or iv
    p_stop = bs_price(tr["stop"], K, T_in, iv0, call) if iv0 else prem_in * 0.5
    loss_unit = max(prem_in - p_stop, 0.2 * prem_in)
    return dict(prem_in=prem_in, prem_out=prem_out, loss_unit=loss_unit, strike=K, expiry=exp, how=how,
                dte=(exp - d_in).days)


# ------------------------------------------------------------------ capital model
def run_capital(trades: list[dict], start: pd.Timestamp, end: pd.Timestamp, mode: str, w: World) -> pd.DataFrame:
    """trades: dicts with entry_idx, exit_idx, rank + underlying fields (+ opt for mode 'opt'). Rs 1,00,000,
    1.5% risk, max 2 open. Entries are taken in date order; on a tie the higher rank first."""
    ts = sorted((t for t in trades if start <= w.dates[t["entry_idx"]] <= end),
                key=lambda t: (t["entry_idx"], -t.get("rank", 0)))
    done: list[dict] = []
    open_: list[dict] = []
    for t in ts:
        e = t["entry_idx"]
        open_ = [x for x in open_ if x["exit_idx"] >= e]
        if len(open_) >= MAX_OPEN:
            continue
        eq = CAPITAL + sum(x["pnl"] for x in done if x["exit_idx"] < e)
        if eq <= 0:
            continue
        risk_amt = eq * RISK_PCT / 100.0
        if mode == "stock":
            qty = math.floor(min(risk_amt / t["risk"], NOTIONAL_CAP * eq / t["entry"]))
            if qty < 1:
                continue
            sgn = 1.0 if t["side"] == "long" else -1.0
            gross = qty * sgn * (t["exit"] - t["entry"])
            slip = 0.05 * t["atr"] / t["entry"]
            cost = stock_costs(qty * t["entry"], qty * t["exit"], t["side"], slip)
        else:
            o = t["opt"]
            qty = math.floor(min(risk_amt / o["loss_unit"], OPTION_OUTLAY_CAP * eq / o["prem_in"]))
            if qty < 1:
                continue
            gross = qty * (o["prem_out"] - o["prem_in"])
            cost = option_costs(o["prem_in"], o["prem_out"], qty)
        rec = dict(t, qty=qty, risk_amt=risk_amt, gross=gross, cost=cost, pnl=gross - cost, R=(gross - cost) / risk_amt,
                   gR=gross / risk_amt,
                   date=w.dates[e], exit_date=w.dates[t["exit_idx"]])
        rec.pop("opt", None)
        done.append(rec)
        open_.append(rec)
    return pd.DataFrame(done)


def stats(df: pd.DataFrame) -> dict:
    if df is None or df.empty:
        return dict(trades=0, win_pct=None, avg_R=None, avg_R_gross=None, pf=None, pnl=0.0, max_dd=0.0, avg_R_ci=None)
    d = df.sort_values(["exit_idx", "entry_idx"])
    pnl = d["pnl"].to_numpy()
    gp, gl = pnl[pnl > 0].sum(), -pnl[pnl < 0].sum()
    cum = np.concatenate([[0.0], np.cumsum(pnl)])
    dd = float((np.maximum.accumulate(cum) - cum).max())
    R = d["R"].to_numpy()
    rng = np.random.default_rng(7)
    ci = None
    if len(R) >= 10:
        bs = rng.choice(R, (2000, len(R))).mean(axis=1)
        ci = [round(float(np.percentile(bs, 2.5)), 3), round(float(np.percentile(bs, 97.5)), 3)]
    return dict(trades=int(len(d)), win_pct=round(100 * float((pnl > 0).mean()), 1), avg_R=round(float(R.mean()), 3), avg_R_gross=round(float(d["gR"].mean()), 3),
                pf=round(float(gp / gl), 2) if gl > 0 else None, pnl=round(float(pnl.sum()), 0), max_dd=round(dd, 0),
                avg_R_ci=ci)


def verdict(tr: dict, te: dict) -> str:
    if tr["trades"] < MIN_TRADES or te["trades"] < MIN_TRADES:
        return "TOO FEW TRADES"
    return "PROFITABLE" if tr["pnl"] > 0 and te["pnl"] > 0 else "NOT PROFITABLE"


def evaluate(trades: list[dict], mode: str, w: World) -> dict:
    """Train + test stats for one signal in one mode."""
    first = w.dates[0]
    tr = run_capital(trades, first, TRAIN_END, mode, w)
    te = run_capital(trades, TEST_START, w.dates[-1], mode, w)
    s_tr, s_te = stats(tr), stats(te)
    return dict(train=s_tr, test=s_te, verdict=verdict(s_tr, s_te), candidates=len(trades))


@dataclass
class SignalSpec:
    key: str
    title: str
    source: str
    events: list = field(default_factory=list)   # dicts: date, symbol, side, rank, [hold, stop_dist, target_px]
    note: str = ""
