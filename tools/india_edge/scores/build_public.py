"""Build the browser-safe JSON (out/public/*.json). Contains scores and words, never formulas/weights.

    python scores/build_public.py [--fixtures] [--date YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scores import edge_stats, engine, feargreed, rotation, screeners  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE.parents[0] / "out" / "public"
DISCLAIMER = "Historical statistics for education only. Not investment advice."


def build(cash, idx, baserates_path, day=None) -> dict:
    cfg = engine.load_cfg()
    p = engine.panel(cash, idx)
    f = engine.features(p)
    day = pd.Timestamp(day) if day else p["close"].index[-1]
    sc = engine.score_day(p, f, day, cfg)
    stocks = [{"symbol": s, "sector": r["sector"], **engine.describe(r, cfg)} for s, r in sc.iterrows()]
    stocks.sort(key=lambda x: -x["overall"]["score"])
    return {
        "desk": {"date": f"{day:%Y-%m-%d}", "fear_greed": feargreed.meter(p, f, day),
                 "rotation": rotation.board(p, f, day), "top": stocks[:5], "disclaimer": DISCLAIMER},
        "scores": {"date": f"{day:%Y-%m-%d}", "stocks": stocks, "disclaimer": DISCLAIMER},
        "screeners": {"date": f"{day:%Y-%m-%d}", "screeners": screeners.run(p, f, sc, day), "disclaimer": DISCLAIMER},
        "edge": edge_stats.load(baserates_path),
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures", action="store_true")
    ap.add_argument("--date")
    a = ap.parse_args(argv)
    if not a.fixtures:
        print("Real-data loader runs on CC8; use --fixtures here.")
        return 2
    fx = HERE / "fixtures"
    res = build(pd.read_csv(fx / "cash.csv"), pd.read_csv(fx / "idx.csv"), fx / "baserates.json", a.date)
    OUT.mkdir(parents=True, exist_ok=True)
    for k, v in res.items():
        (OUT / f"{k}.json").write_text(json.dumps(v, indent=1, allow_nan=False))
    print("wrote", ", ".join(f"{k}.json" for k in res))
    return 0


if __name__ == "__main__":
    sys.exit(main())
