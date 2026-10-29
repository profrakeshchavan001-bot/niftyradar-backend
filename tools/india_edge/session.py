"""One simulated (or replayed-from-CSV) trading day for the desk's picks.

Walks 15-minute bars in time order for all picks together: queued entries fill at the next
bar's open, open trades are marked against each bar, then every pick is re-evaluated using
only the bars seen so far (Layer 2), gated by Layer 3 vetoes and the ledger's limits.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

import alerts as A
from intraday import get_bars
from timing import analyse
from vetoes import apply_vetoes


def _hm(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def veto_context(market, symbol: str, asof, trade_date, entry=None, target=None) -> dict:
    """Everything Layer 3 needs, using data up to `asof` only."""
    asof = pd.Timestamp(asof)
    c = market.cash[(market.cash["symbol"] == symbol) & (market.cash["date"] <= asof)].sort_values("date")
    closes = c["close"].to_numpy()
    ret = np.diff(np.log(closes[-21:])) if len(closes) > 2 else np.array([])
    ctx = dict(closes=closes[-60:], trade_date=trade_date, entry=entry, target=target,
               trading_days=market.dates, daily_vol=float(ret.std(ddof=1)) if len(ret) > 2 else None)
    if len(market.iv):
        iv = market.iv[(market.iv["symbol"] == symbol) & (market.iv["date"] <= asof)].sort_values("date")
        ctx["iv_series"] = iv["iv"].to_numpy()
        ctx["spread_pct"] = float(iv["opt_spread_pct"].iloc[-1] * 100) if len(iv) else None
    ev = market.events
    ctx["event_dates"] = list(ev[ev["symbol"].isin([symbol, "ALL"])]["date"]) if len(ev) else []
    exp = market.fo.loc[market.fo["symbol"] == symbol, "expiry"].unique()
    ctx["expiries"] = [e for e in pd.to_datetime(pd.Series(exp), errors="coerce").dropna()]
    return ctx


def run_session(market, picks: list[dict], asof, trade_date, ledger, ecfg: dict, vcfg: dict,
                bars_root=None) -> dict:
    """picks: dicts with symbol, side, grade, score, setup. Returns events, bars, trades, stages."""
    day = f"{pd.Timestamp(trade_date):%Y-%m-%d}"
    bars = {}
    for p in picks:
        b = get_bars(market.cash, p["symbol"], trade_date, bars_root)
        if b is not None and len(b) > 3:
            bars[p["symbol"]] = b.reset_index(drop=True)
    pick_by = {p["symbol"]: p for p in picks}
    stages: dict[str, str] = {}
    events: list[dict] = []
    done: set[str] = set()
    pending: dict[str, dict] = {}
    go_checks: dict[str, list] = {}
    pre = {p["symbol"]: apply_vetoes(veto_context(market, p["symbol"], asof, trade_date), vcfg) for p in picks}

    def emit(ts, symbol, kind, text):
        events.append(dict(ts=f"{pd.Timestamp(ts):%Y-%m-%d %H:%M}" if ts is not None else None,
                           symbol=symbol, kind=kind, text=text))

    # pre-market announcements: Watch (or Vetoed)
    curr = {}
    for p in picks:
        v = pre[p["symbol"]]
        why = [c[2] for c in v["checks"] if c[1]]
        curr[p["symbol"]] = dict(stage=A.stage_of("none", v["vetoed"]), symbol=p["symbol"], side=p["side"],
                                 grade=p["grade"], score=p["score"], reasons=why)
    for m in A.stage_alerts({}, curr):
        emit(None, "", "alert", m)
    stages = {s: c["stage"] for s, c in curr.items()}
    for s, st in stages.items():
        if st == "Vetoed":
            done.add(s)

    n = max((len(b) for b in bars.values()), default=0)
    sq = _hm(ecfg["paper"]["square_off"])
    for i in range(n):
        ts = next(b["ts"].iloc[i] for b in bars.values() if len(b) > i)
        # 1. fill entries queued on the previous bar at this bar's open
        for sym, sg in list(pending.items()):
            b = bars[sym]
            sg = {**sg, "entry": float(b["open"].iloc[i])}
            tid = ledger.open_trade(day, sg, ts, dict(grade=pick_by[sym]["grade"], setup=pick_by[sym]["setup"],
                                                      score=pick_by[sym]["score"]))
            if tid:
                emit(ts, sym, "entry", f"paper {sg['side']} {sym} @ {sg['entry']:.2f} SL {sg['stop']:.2f} "
                                       f"TGT {sg['target']:.2f}")
            done.add(sym)
            del pending[sym]
        # 2. mark open trades with this bar
        for sym, b in bars.items():
            if len(b) > i:
                r = b.iloc[i]
                for tid in ledger.on_bar(sym, ts, r["open"], r["high"], r["low"], r["close"]):
                    row = ledger.db.execute("SELECT * FROM trades WHERE id=?", (tid,)).fetchone()
                    emit(ts, sym, "exit", f"{sym} closed by {row['exit_reason']} at {row['exit']:.2f}, R {row['r']:+.2f}")
        # 3. forced square-off
        t0 = pd.Timestamp(ts)
        if t0.hour * 60 + t0.minute >= sq:
            last = {s: float(b["close"].iloc[i]) for s, b in bars.items() if len(b) > i}
            for tid in ledger.square_off(ts, last):
                row = ledger.db.execute("SELECT * FROM trades WHERE id=?", (tid,)).fetchone()
                emit(ts, row["symbol"], "exit", f"{row['symbol']} squared off at {row['exit']:.2f}, R {row['r']:+.2f}")
            break
        # 4. re-evaluate picks on the bars seen so far
        curr = {}
        for sym, b in bars.items():
            if sym in done or sym in pending or len(b) <= i:
                continue
            p = pick_by[sym]
            nxt = float(b["open"].iloc[i + 1]) if len(b) > i + 1 else None
            res = analyse(b.iloc[: i + 1], p["side"], ecfg, next_open=nxt)
            stage = A.stage_of(res["state"])
            info = dict(stage=stage, symbol=sym, side=p["side"], grade=p["grade"], score=p["score"],
                        reasons=res["reasons"])
            if res["state"] == "go":
                vctx = veto_context(market, sym, asof, trade_date, res["entry"], res["target"])
                v = apply_vetoes(vctx, vcfg)
                go_checks[sym] = v["checks"]
                ok, why = ledger.can_open(day, sym)
                if v["vetoed"]:
                    info.update(stage="Vetoed", reasons=[c[2] for c in v["checks"] if c[1]])
                    done.add(sym)
                elif not ok:
                    info.update(stage="Ready", reasons=[why])
                else:
                    info.update(entry=res["entry"], stop=res["stop"], target=res["target"])
                    pending[sym] = dict(symbol=sym, side=p["side"], entry=res["entry"], stop=res["stop"],
                                        target=res["target"], trigger=res["trigger"])
            curr[sym] = info
        for m in A.stage_alerts(stages, curr):
            emit(ts, "", "alert", m)
        for s, c in curr.items():
            if c["stage"] == "Vetoed" or A.ORDER[c["stage"]] >= A.ORDER.get(stages.get(s, "Watch"), 0):
                stages[s] = c["stage"]  # stages only move up (or to Vetoed)
    return dict(day=day, events=events, bars=bars, stages=stages, pre_vetoes=pre, go_checks=go_checks)
