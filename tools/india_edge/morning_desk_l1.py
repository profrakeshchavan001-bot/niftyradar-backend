"""Turn out/latest.json (scanner top-5) into out/morning_desk.json with trade levels.

    python morning_desk.py

Levels follow the backtest execution: enter at the next open (the signal close is
the reference), stop 1.5 x ATR(14), target 2R, exit at the 5th session's close.
Statistics on historical data, not advice.
"""
from __future__ import annotations

import json
import sys

import pandas as pd

from backtest.engine import EXEC, atr
from common import OUT_DIR, load_dataset

DESK_FILE = OUT_DIR / "morning_desk.json"


def build_desk(latest: dict, cash: pd.DataFrame) -> dict:
    date = pd.Timestamp(latest["date"])
    syms = [p["symbol"] for p in latest["picks"]]
    c = cash[cash["symbol"].isin(syms) & (cash["date"] <= date)]
    wide = lambda col: c.pivot(index="date", columns="symbol", values=col).sort_index()  # noqa: E731
    a = atr(wide("high"), wide("low"), wide("prev_close"), EXEC["atr_n"]).iloc[-1]
    close = wide("close").iloc[-1]
    picks = []
    for p in latest["picks"]:
        s, sgn = p["symbol"], (1 if p["direction"] == "long" else -1)
        ref, risk = float(close[s]), EXEC["stop_atr"] * float(a[s])
        picks.append({
            "rank": p["rank"], "symbol": s, "direction": p["direction"], "grade": p["grade"],
            "score": p["score"], "setup": p["setup"],
            "ref_close": round(ref, 2), "atr14": round(float(a[s]), 2),
            "entry": "next session open",
            "stop": round(ref - sgn * risk, 2), "target": round(ref + sgn * EXEC["target_r"] * risk, 2),
            "risk_pct": round(100 * risk / ref, 2), "time_exit_sessions": EXEC["hold"],
            "why": p["features"],
        })
    return {"signal_date": latest["date"], "universe_asof": latest.get("universe_asof"),
            "rules": f"stop {EXEC['stop_atr']}xATR({EXEC['atr_n']}) from the entry, target "
                     f"{EXEC['target_r']}R, exit at day-{EXEC['hold']} close; levels shown from "
                     "the signal close, shift them by the gap at the open",
            "disclaimer": "Statistics on historical data, not advice.", "picks": picks}


def main() -> int:
    latest = json.loads((OUT_DIR / "latest.json").read_text())
    desk = build_desk(latest, load_dataset("cash"))
    DESK_FILE.write_text(json.dumps(desk, indent=2))
    for p in desk["picks"]:
        print(f"{p['rank']} {p['symbol']:<11} {p['direction']:<5} {p['grade']} {p['score']:>5}  "
              f"ref {p['ref_close']}  SL {p['stop']}  T {p['target']}")
    print("->", DESK_FILE)
    return 0


if __name__ == "__main__":
    sys.exit(main())
