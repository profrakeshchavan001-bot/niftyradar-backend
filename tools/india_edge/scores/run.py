"""CLI:  python -m scores.run [--asof YYYY-MM-DD] [--fundamentals FILE] [--out DIR]

Fixtures when DATA_DIR is unset; real bhavcopy day files when DATA_DIR is set (CC8 runs this).
Run from tools/india_edge.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scores import build, data  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--asof")
    ap.add_argument("--fundamentals", help="CSV: symbol,roe,debt_equity,profit_margin,pe,pb,promoter_pct,promoter_pledge_pct")
    ap.add_argument("--validate", action="store_true", help="also write validation.json (rank-IC by year/regime, doubled costs)")
    ap.add_argument("--report", action="store_true", help="portfolio-level validation report (report.md + report.json, ~30 s)")
    ap.add_argument("--out", default=str(ROOT / "scores" / "out"))
    a = ap.parse_args(argv)
    P = data.load(a.fundamentals)
    out, R = build.build(P, day=a.asof)
    Rv = R
    if a.validate or a.report:
        from scores import engine
        # historical tests must not see the fundamentals snapshot (it is as-of today: look-ahead)
        Rv = engine.compute(P, use_fundamentals=False) if P.fundamentals is not None else R
    if a.validate:
        from scores import validate
        from scores import sensitivity
        out["validation"] = validate.run(P, Rv)
        out["sensitivity"] = {**sensitivity.run(P, R), "screeners": sensitivity.screener_sensitivity(P, R)}
        out["heatmap"] = sensitivity.heatmap(P, Rv)
    if a.report:
        from scores import report
        rep = report.run(P, Rv)
        out["report"] = rep
        Path(a.out).mkdir(parents=True, exist_ok=True)
        (Path(a.out) / "report.md").write_text(report.to_markdown(rep))
    names = build.write(out, Path(a.out))
    print(f"{out['overview']['date']}: {out['overview']['scored']} scored, health {out['health']['grade']} -> {a.out} ({', '.join(names)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
