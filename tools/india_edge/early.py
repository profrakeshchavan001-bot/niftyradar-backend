"""Block H: early detection. Quiet accumulation, OI build-up without price move, volatility squeeze,
relative-strength divergence and volume dry-up, combined into a stage model
accumulation -> trigger -> confirmation that feeds the Watch/Ready/Go alert function.

All detectors use only rows up to the last row of the history frame passed in.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import alerts as A
from timing import exec_config

DEFAULTS = dict(deliv_rise=1.15, flat_pct=2.0, oi_build_pct=8.0, oi_flat_pct=1.5, bb_window=20, bb_pctile=20,
                rs_window=10, rs_tape_pct=1.0, dryup_ratio=0.6, near_range_pct=3.0, breakout_lookback=20,
                trigger_volume=1.2, confirm_window=3, min_flags=2)
STAGE_TO_ALERT = {"accumulation": "Watch", "trigger": "Ready", "confirmation": "Go"}
FLAGS = ("quiet_accumulation", "oi_buildup_no_move", "squeeze", "rs_divergence", "volume_dry_up")


def early_config(cfg: dict | None = None) -> dict:
    return {**DEFAULTS, **(cfg or exec_config()).get("early", {})}


def history(market, symbol: str, asof, n: int = 170) -> pd.DataFrame:
    """date, OHLCV, deliv_pct, fut_oi, nifty for one symbol, last n sessions up to asof."""
    asof = pd.Timestamp(asof)
    c = market.cash[(market.cash["symbol"] == symbol) & (market.cash["date"] <= asof)].sort_values("date").tail(n)
    h = c[["date", "open", "high", "low", "close", "volume", "deliv_pct"]].reset_index(drop=True)
    if len(market.fo):
        f = market.fo[(market.fo["symbol"] == symbol) & (market.fo["instr"] == "STF") & (market.fo["date"] <= asof)]
        oi = f.groupby("date")["oi"].sum()
        h["fut_oi"] = h["date"].map(oi)
    else:
        h["fut_oi"] = np.nan
    if len(market.idx):
        nf = market.idx[(market.idx["index_name"] == "Nifty 50") & (market.idx["date"] <= asof)]
        h["nifty"] = h["date"].map(nf.set_index("date")["close"])
    else:
        h["nifty"] = np.nan
    return h


def _flag(active, strength=0.0, side=None, detail=""):
    return dict(active=bool(active), strength=round(float(strength), 3) if active else 0.0, side=side if active else None,
                detail=detail)


def _lean(h: pd.DataFrame) -> str:
    return "long" if h["close"].iloc[-1] >= h["close"].iloc[-20:].mean() else "short"


def detect_flags(h: pd.DataFrame, cfg: dict | None = None) -> dict:
    """Flag dicts for the LAST row of h."""
    c = early_config(cfg)
    out = {k: _flag(False) for k in FLAGS}
    n = len(h)
    if n < 30:
        return out
    close, high, low, vol = h["close"], h["high"], h["low"], h["volume"]
    # 1. quiet accumulation: delivery % rising while price is flat
    d = h["deliv_pct"]
    if d.iloc[-25:].notna().sum() >= 20:
        base, recent = d.iloc[-25:-5].mean(), d.iloc[-5:].mean()
        chg5 = abs(close.iloc[-1] / close.iloc[-6] - 1) * 100
        if base and base > 0 and recent / base >= c["deliv_rise"] and chg5 <= c["flat_pct"]:
            r = recent / base
            out["quiet_accumulation"] = _flag(True, 0.5 + 0.5 * min((r - c["deliv_rise"]) / 0.35, 1.0), _lean(h),
                                              f"delivery {r:.2f}x its prior average while price moved {chg5:.1f}% in 5 sessions")
    # 2. futures OI building while price barely moves
    oi = h["fut_oi"]
    if oi.iloc[-4:].notna().all() and oi.iloc[-4] > 0:
        oi_chg = (oi.iloc[-1] / oi.iloc[-4] - 1) * 100
        px3 = abs(close.iloc[-1] / close.iloc[-4] - 1) * 100
        if oi_chg >= c["oi_build_pct"] and px3 <= c["oi_flat_pct"]:
            out["oi_buildup_no_move"] = _flag(True, 0.5 + 0.5 * min((oi_chg - c["oi_build_pct"]) / 12.0, 1.0), _lean(h),
                                              f"futures OI {oi_chg:+.1f}% in 3 sessions with price {px3:.1f}% apart")
    # 3. volatility squeeze: NR7 and/or Bollinger width in its lowest percentile
    rng = (high - low)
    nr7 = rng.iloc[-1] < rng.iloc[-7:-1].min()
    w = c["bb_window"]
    mid = close.rolling(w).mean()
    width = (4 * close.rolling(w).std(ddof=0)) / mid
    prior = width.iloc[-121:-1].dropna()
    bb = bool(len(prior) >= 40 and width.iloc[-1] < np.percentile(prior, c["bb_pctile"]))
    if nr7 or bb:
        out["squeeze"] = _flag(True, 0.9 if (nr7 and bb) else 0.6, _lean(h),
                               " and ".join(x for x, ok in (("NR7 (narrowest range of 7 sessions)", nr7),
                                                            (f"Bollinger width in its lowest {c['bb_pctile']}%", bb)) if ok))
    # 4. relative-strength divergence against a moving index
    k = c["rs_window"]
    nf = h["nifty"]
    if nf.iloc[-k - 1:].notna().all():
        s_ret, n_ret = (close.iloc[-1] / close.iloc[-k - 1] - 1) * 100, (nf.iloc[-1] / nf.iloc[-k - 1] - 1) * 100
        side = "long" if (n_ret <= -c["rs_tape_pct"] and s_ret >= 0) else "short" if (
            n_ret >= c["rs_tape_pct"] and s_ret <= 0) else None
        if side:
            out["rs_divergence"] = _flag(True, 0.5 + 0.5 * min(abs(s_ret - n_ret) / 6.0, 1.0), side,
                                         f"stock {s_ret:+.1f}% vs Nifty {n_ret:+.1f}% over {k} sessions")
    # 5. volume dry-up next to a range extreme
    base_v = vol.iloc[-23:-3].mean()
    if base_v and base_v > 0:
        ratio = vol.iloc[-3:].mean() / base_v
        hi, lo = high.iloc[-20:].max(), low.iloc[-20:].min()
        near_hi = (hi / close.iloc[-1] - 1) * 100 <= c["near_range_pct"]
        near_lo = (close.iloc[-1] / lo - 1) * 100 <= c["near_range_pct"]
        if ratio <= c["dryup_ratio"] and (near_hi or near_lo):
            out["volume_dry_up"] = _flag(True, 0.5 + 0.5 * min((c["dryup_ratio"] - ratio) / 0.3, 1.0),
                                         "long" if near_hi else "short",
                                         f"3-day volume {ratio:.2f}x the 20-day average next to the 20-day "
                                         f"{'high' if near_hi else 'low'}")
    return out


def _atr(h: pd.DataFrame, n: int = 14) -> float:
    pc = h["close"].shift(1)
    tr = np.maximum(h["high"] - h["low"], np.maximum((h["high"] - pc).abs(), (h["low"] - pc).abs()))
    v = tr.iloc[-n:].mean()
    return float(v) if len(h) > n and not np.isnan(v) else float("nan")


def early_stage(h: pd.DataFrame, cfg: dict | None = None, flags_fn=None) -> dict:
    """Stage as of the last row: none | accumulation | trigger | confirmation.

    accumulation: >= min_flags detectors active now.
    trigger: close breaks the prior 20-session high/low on volume >= trigger_volume x average, after
             >= min_flags detectors were active in the 5 sessions before the breakout.
    confirmation: a later session (within confirm_window) closes further beyond the trigger close and
             the last close is still outside the old range.
    """
    c = early_config(cfg)
    flags_fn = flags_fn or detect_flags
    res = dict(stage="none", side=None, flags=[], strength=0.0, detail="", trigger_date=None, level=None, levels=None)
    n = len(h)
    if n < 30:
        res["detail"] = "not enough history"
        return res
    lb, cw = c["breakout_lookback"], c["confirm_window"]
    depth = cw + 6
    hist = [flags_fn(h.iloc[: n - j]) for j in range(depth)]     # hist[j] = flags j sessions ago
    active_now = {k: v for k, v in hist[0].items() if v["active"]}

    def n_active(j):
        return sum(1 for v in hist[j].values() if v["active"])

    def breakout(j):
        """(side, level) if the session j sessions ago broke the prior-range extreme on volume, else None."""
        i = n - 1 - j
        if i < lb + 1:
            return None
        prior_hi, prior_lo = h["high"].iloc[i - lb:i].max(), h["low"].iloc[i - lb:i].min()
        vavg = h["volume"].iloc[i - lb:i].mean()
        vol_ok = vavg > 0 and h["volume"].iloc[i] >= c["trigger_volume"] * vavg
        if not vol_ok:
            return None
        if h["close"].iloc[i] > prior_hi:
            return "long", float(prior_hi)
        if h["close"].iloc[i] < prior_lo:
            return "short", float(prior_lo)
        return None

    found = None
    for j in range(0, cw + 1):                    # most recent breakout first
        b = breakout(j)
        if not b:
            continue
        pre = [n_active(jj) for jj in range(j + 1, min(j + 6, depth))]
        if pre and max(pre) >= c["min_flags"]:
            found = (j, b)
            break
    close = h["close"]
    atr = _atr(h)
    if found:
        j, (side, level) = found
        tclose = close.iloc[n - 1 - j]
        beyond = (lambda x: x > tclose) if side == "long" else (lambda x: x < tclose)
        outside = (close.iloc[-1] > level) if side == "long" else (close.iloc[-1] < level)
        follow = any(beyond(close.iloc[n - 1 - jj]) for jj in range(0, j))
        stage = "confirmation" if (j > 0 and follow and outside) else "trigger" if outside else "none"
        if stage != "none":
            names = sorted({k for jj in range(j + 1, min(j + 6, depth)) for k, v in hist[jj].items() if v["active"]})
            res.update(stage=stage, side=side, flags=names, level=level,
                       trigger_date=f"{h['date'].iloc[n - 1 - j]:%Y-%m-%d}", strength=0.8 if stage == "confirmation" else 0.7,
                       detail=f"{side} breakout of the {lb}-session range at {level:.2f} on "
                              f"{h['date'].iloc[n - 1 - j]:%Y-%m-%d} after " + ", ".join(x.replace("_", " ") for x in names))
    if res["stage"] == "none" and len(active_now) >= c["min_flags"]:
        sides = [v["side"] for v in active_now.values() if v["side"]]
        side = max(set(sides), key=sides.count) if sides else None
        res.update(stage="accumulation", side=side, flags=sorted(active_now),
                   strength=round(max(v["strength"] for v in active_now.values()), 3),
                   detail="; ".join(v["detail"] for v in active_now.values()))
    if res["stage"] != "none" and res["side"] and not np.isnan(atr):
        px = float(close.iloc[-1])
        sgn = 1 if res["side"] == "long" else -1
        res["levels"] = dict(entry_ref=px, stop=px - sgn * 1.5 * atr, target=px + sgn * 3.0 * atr, atr14=atr)
    return res


def early_alert_items(prev: dict[str, str], results: dict[str, dict]) -> tuple[list[tuple[str, dict]], dict[str, str]]:
    """Feed early-detection stage changes into the existing Watch/Ready/Go alert function.

    prev: {symbol: alert stage already announced}; results: {symbol: early_stage() dict}.
    Returns ([(message, info)], new prev)."""
    curr, nxt = {}, dict(prev)
    for sym, r in results.items():
        st = STAGE_TO_ALERT.get(r["stage"])
        if not st or not r.get("side"):
            continue
        lv = r.get("levels") or {}
        note = {"Watch": f"Early accumulation: {r['detail']}.",
                "Ready": f"Breakout trigger: {r['detail']}.",
                "Go": f"Breakout confirmed: {r['detail']}."}[st]
        curr[sym] = dict(stage=st, symbol=sym, side=r["side"], note=note, entry=lv.get("entry_ref"),
                         stop=lv.get("stop"), target=lv.get("target"), kind="early", early_stage=r["stage"],
                         prev_stage=prev.get(sym))
    items = A.stage_changes(prev, curr)
    for s_, i in curr.items():
        if s_ not in prev or A.ORDER[i["stage"]] > A.ORDER[prev[s_]]:
            nxt[s_] = i["stage"]
    return items, nxt


def early_alerts(prev: dict[str, str], results: dict[str, dict]) -> tuple[list[str], dict[str, str]]:
    items, nxt = early_alert_items(prev, results)
    return [t for t, _ in items], nxt
