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
    ap.add_argument("--out", default=str(ROOT / "scores" / "out"))
    a = ap.parse_args(argv)
    P = data.load(a.fundamentals)
    out, _ = build.build(P, day=a.asof)
    names = build.write(out, Path(a.out))
    print(f"{out['overview']['date']}: {out['overview']['scored']} scored, health {out['health']['grade']} -> {a.out} ({', '.join(names)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
