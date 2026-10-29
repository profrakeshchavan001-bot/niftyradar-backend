"""Nightly Layer 1 scanner.

    python run_scanner.py [--date YYYY-MM-DD] [--no-fetch] [--refresh-universe]

Writes out/top5_<date>.json, out/top5_<date>.md and out/latest.json.
"""
from __future__ import annotations

import argparse
import json
import sys

import pandas as pd

from common import OUT_DIR, load_config, load_dataset
from features import build_features, load_sectors
from score import score_frame, top_n
from universe import load_universe


def render_md(date: str, picks: list[dict]) -> str:
    lines = [f"# Layer 1 Smart Money Selection, {date}", "",
             "| # | Symbol | Direction | Score | Grade | Setup | Key features |",
             "|---|---|---|---|---|---|---|"]
    for p in picks:
        f = p["features"]
        key = (f"{f['quadrant']}; OI {f['oi_chg_pct']:+.1f}%, px {f['price_chg_pct']:+.1f}%; "
               f"deliv {f['deliv_ratio']:.2f}x{' (spike)' if f['deliv_spike'] else ''}; "
               f"RS {f['rs']:+.1f}; sector RS {f['sector_rs']:+.1f}; "
               f"opt OI {f['unusual_oi']:.1f}x; ADV {f['adv_cr']:.0f} cr")
        lines.append(f"| {p['rank']} | {p['symbol']} | {p['direction']} | {p['score']} | "
                     f"{p['grade']} | {p['setup']} | {key} |")
    if not picks:
        lines.append("| - | no qualifying stocks | | | | | |")
    return "\n".join(lines) + "\n"


def run(date: pd.Timestamp | None = None, fetch: bool = True,
        refresh_universe: bool = False) -> dict:
    cfg = load_config()
    if fetch:
        from data.fetch import fetch_range
        end = date or pd.Timestamp.today().normalize()
        fetch_range(end - pd.Timedelta(days=90), end)
    cash, fo, idx = load_dataset("cash"), load_dataset("fo"), load_dataset("idx")
    if cash.empty or fo.empty or idx.empty:
        raise SystemExit("missing data: run `python data/fetch.py --from ... --to ...` first")
    if date is None:
        date = min(cash["date"].max(), fo["date"].max(), idx["date"].max())
    date = pd.Timestamp(date)
    if date not in set(cash["date"]):
        raise SystemExit(f"no cash bhavcopy stored for {date:%Y-%m-%d} (holiday or not published yet)")

    uni = load_universe(date, force=refresh_universe, cfg=cfg)
    feats = build_features(cash, fo, idx, uni["symbols"], load_sectors(), cfg["lookback"])
    scored = score_frame(feats[feats["date"] == date], cfg)
    picks = []
    for rank, (_, r) in enumerate(top_n(scored, cfg, date).iterrows(), 1):
        picks.append({
            "rank": rank, "symbol": r["symbol"], "direction": r["direction"],
            "score": r["score"], "grade": r["grade"], "setup": r["setup"],
            "components": r["components"],
            "features": {
                "quadrant": r["quadrant"], "oi_chg_pct": round(float(r["oi_chg_pct"]), 2),
                "price_chg_pct": round(float(r["price_chg_pct"]), 2),
                "deliv_pct": round(float(r["deliv_pct"]), 1),
                "deliv_ratio": round(float(r["deliv_ratio"]), 2),
                "deliv_spike": bool(r["deliv_spike"]),
                "rs": round(float(r["rs"]), 2), "sector": r["sector"],
                "sector_rs": round(float(r["sector_rs"]), 2),
                "unusual_oi": round(float(r["unusual_oi"]), 2),
                "adv_cr": round(float(r["adv_cr"]), 1),
            },
        })
    result = {"date": f"{date:%Y-%m-%d}", "universe_asof": uni["asof"], "picks": picks}
    OUT_DIR.mkdir(exist_ok=True)
    text = json.dumps(result, indent=2, allow_nan=False)
    (OUT_DIR / f"top5_{date:%Y-%m-%d}.json").write_text(text)
    (OUT_DIR / f"top5_{date:%Y-%m-%d}.md").write_text(render_md(result["date"], picks))
    (OUT_DIR / "latest.json").write_text(text)
    return result


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--date", default=None, help="default: last trading day with data")
    ap.add_argument("--no-fetch", action="store_true", help="use stored data only")
    ap.add_argument("--refresh-universe", action="store_true")
    a = ap.parse_args(argv)
    res = run(pd.Timestamp(a.date) if a.date else None, not a.no_fetch, a.refresh_universe)
    print(f"{res['date']}: {len(res['picks'])} picks -> out/top5_{res['date']}.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
