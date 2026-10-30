"""Layer 2: 15-minute timing. OB/FVG pullback + BOS/engulfing trigger + ORB/VWAP side.

Every function takes the bars seen SO FAR (bars[:i+1]); nothing here reads past the last
bar passed in, except `entry` which is the next bar's open when the caller supplies it.
Bars: DataFrame with columns ts, open, high, low, close, volume (IST bar start times).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from common import ROOT, load_config

EXEC_CFG = ROOT / "config_exec.yaml"


def exec_config() -> dict:
    return load_config(EXEC_CFG)


# ----------------------------------------------------------------- windows
def _hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def in_trade_window(ts, windows=(("09:30", "11:00"), ("13:30", "15:00"))) -> bool:
    """True if the (bar start) time is in [start, end) of any IST trade window."""
    t = pd.Timestamp(ts)
    mins = t.hour * 60 + t.minute
    return any(_hm(a) <= mins < _hm(b) for a, b in windows)


# ----------------------------------------------------------------- primitives
def range_proxy(bars: pd.DataFrame, n: int = 14) -> float:
    """Mean high-low of the last n bars (intraday ATR stand-in)."""
    r = (bars["high"] - bars["low"]).tail(n)
    return float(r.mean()) if len(r) else 0.0


def vwap(bars: pd.DataFrame) -> float:
    tp = (bars["high"] + bars["low"] + bars["close"]) / 3
    v = bars["volume"].to_numpy(dtype=float)
    return float((tp.to_numpy() * v).sum() / v.sum()) if v.sum() > 0 else float(bars["close"].iloc[-1])


def vwap_side(bars: pd.DataFrame) -> str:
    c = bars["close"].iloc[-1]
    w = vwap(bars)
    return "long" if c > w else "short" if c < w else "none"


def orb_side(bars: pd.DataFrame) -> str:
    """Opening range = the first 15-minute bar. Close above its high -> long, below its low -> short."""
    if len(bars) < 2:
        return "none"
    hi, lo = bars["high"].iloc[0], bars["low"].iloc[0]
    c = bars["close"].iloc[-1]
    return "long" if c > hi else "short" if c < lo else "none"


def find_fvgs(bars: pd.DataFrame, side: str, min_gap: float = 0.0) -> list[dict]:
    """Three-candle imbalance. Bullish: low[i] > high[i-2]; bearish: high[i] < low[i-2]."""
    out = []
    h, l = bars["high"].to_numpy(), bars["low"].to_numpy()
    for i in range(2, len(bars)):
        if side == "long" and l[i] - h[i - 2] > min_gap and l[i] > h[i - 2]:
            out.append(dict(kind="fvg", side=side, low=float(h[i - 2]), high=float(l[i]), formed=i))
        if side == "short" and l[i - 2] - h[i] > min_gap and h[i] < l[i - 2]:
            out.append(dict(kind="fvg", side=side, low=float(h[i]), high=float(l[i - 2]), formed=i))
    return out


def find_order_blocks(bars: pd.DataFrame, side: str, disp_mult: float = 1.0,
                      lookback: int = 5, atr_n: int = 14) -> list[dict]:
    """Order block = last opposite-colour candle before a displacement bar that breaks the
    prior 3-bar extreme. Uses only bars before each displacement bar for its size reference."""
    out = []
    o, h, l, c = (bars[k].to_numpy() for k in ("open", "high", "low", "close"))
    for d in range(2, len(bars)):
        ref = range_proxy(bars.iloc[:d], atr_n)
        if ref <= 0:
            continue
        body = c[d] - o[d]
        if side == "long" and body >= disp_mult * ref and c[d] > h[max(0, d - 3):d].max():
            for k in range(d - 1, max(-1, d - 1 - lookback), -1):
                if c[k] < o[k]:
                    out.append(dict(kind="ob", side=side, low=float(l[k]), high=float(h[k]), formed=d))
                    break
        if side == "short" and -body >= disp_mult * ref and c[d] < l[max(0, d - 3):d].min():
            for k in range(d - 1, max(-1, d - 1 - lookback), -1):
                if c[k] > o[k]:
                    out.append(dict(kind="ob", side=side, low=float(l[k]), high=float(h[k]), formed=d))
                    break
    return out


def is_engulfing(bars: pd.DataFrame, i: int, side: str) -> bool:
    if i < 1:
        return False
    po, pc = bars["open"].iloc[i - 1], bars["close"].iloc[i - 1]
    co, cc = bars["open"].iloc[i], bars["close"].iloc[i]
    if side == "long":
        return pc < po and cc > co and cc >= po and co <= pc
    return pc > po and cc < co and cc <= po and co >= pc


def is_bos(bars: pd.DataFrame, i: int, touch: int, side: str) -> bool:
    """Break of structure: close beyond the pullback's extreme (bars touch-1 .. i-1)."""
    lo_i = max(0, touch - 1)
    if i <= touch:
        return False
    if side == "long":
        return bars["close"].iloc[i] > bars["high"].iloc[lo_i:i].max()
    return bars["close"].iloc[i] < bars["low"].iloc[lo_i:i].min()


# ----------------------------------------------------------------- analysis
def analyse(bars: pd.DataFrame, side: str, cfg: dict | None = None, next_open: float | None = None) -> dict:
    """State of a pullback setup using bars up to the last row.

    state: none | zone (zone exists, no pullback yet) | ready (price pulled back into the zone,
    waiting for a trigger) | go (trigger on the last bar, filters and window pass).
    """
    t = (cfg or exec_config())["timing"]
    res = dict(state="none", side=side, zone=None, trigger=None, entry=None, stop=None,
               target=None, reasons=[])
    if side not in ("long", "short") or len(bars) < 4:
        res["reasons"].append("not enough bars or no side")
        return res
    i = len(bars) - 1
    ref = range_proxy(bars, t["atr_bars"])
    zones = find_order_blocks(bars, side, t["displacement_atr"], t["ob_lookback"], t["atr_bars"]) \
        + find_fvgs(bars, side, t["fvg_min_gap_atr"] * ref)
    live = []
    for z in zones:  # a zone dies when price closes through its far edge
        after = bars["close"].iloc[z["formed"] + 1:] if z["formed"] + 1 <= i else bars["close"].iloc[0:0]
        dead = (after < z["low"]).any() if side == "long" else (after > z["high"]).any()
        if not dead:
            live.append(z)
    if not live:
        res["reasons"].append("no live OB/FVG zone")
        return res
    live.sort(key=lambda q: q["formed"], reverse=True)  # most recent first
    lows, highs = bars["low"].to_numpy(), bars["high"].to_numpy()

    def first_touch(z):
        return next((j for j in range(z["formed"] + 1, i + 1)
                     if (lows[j] <= z["high"] if side == "long" else highs[j] >= z["low"])), None)

    # a zone created by the current bar cannot have been pulled back into yet, so prefer the
    # most recent zone that has been touched; otherwise report the newest zone as waiting
    z, touch = live[0], None
    for cand in live:
        t0 = first_touch(cand)
        if t0 is not None:
            z, touch = cand, t0
            break
    res.update(state="zone", zone=z)
    if touch is None:
        res["reasons"].append("no pullback into zone yet")
        return res
    res.update(state="ready", touch=touch)
    trig = None
    if "bos" in t["triggers"] and is_bos(bars, i, touch, side):
        trig = "bos"
    elif "engulfing" in t["triggers"] and i >= touch and is_engulfing(bars, i, side):
        trig = "engulfing"
    if trig is None:
        res["reasons"].append("waiting for BOS/engulfing trigger")
        return res
    if t["require_vwap"] and vwap_side(bars) != side:
        res["reasons"].append("VWAP side disagrees")
        return res
    orb = orb_side(bars)
    if t["require_orb"] and orb not in (side, "none"):
        res["reasons"].append("ORB side opposes")
        return res
    entry = float(next_open) if next_open is not None else float(bars["close"].iloc[-1])
    entry_ts = (pd.Timestamp(bars["ts"].iloc[-1]) + pd.Timedelta(minutes=15))
    if not in_trade_window(entry_ts, t["windows"]):
        res["reasons"].append(f"entry time {entry_ts:%H:%M} outside trade windows")
        return res
    buf = t["stop_buffer_atr"] * ref
    stop = z["low"] - buf if side == "long" else z["high"] + buf
    risk = entry - stop if side == "long" else stop - entry
    if risk <= 0:
        res["reasons"].append("stop on wrong side of entry")
        return res
    if 100.0 * risk / entry > t["max_risk_pct"]:
        res["reasons"].append("stop wider than max_risk_pct")
        return res
    sgn = 1 if side == "long" else -1
    res.update(state="go", trigger=trig, entry=entry, stop=float(stop),
               target=float(entry + sgn * t["target_r"] * risk), risk=float(risk),
               entry_ts=entry_ts, orb=orb)
    return res
