"""Sunday review of the paper ledger: win rate, expectancy, by setup type and grade.

    python weekly_review.py                    # the week containing the latest trade
    python weekly_review.py --week-ending 2026-10-11 [--db out/paper.sqlite]

R is net of the ledger's slippage (none by default). Writes out/weekly_<date>.md.
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import pandas as pd

from common import OUT_DIR


def week_ending_for(d) -> pd.Timestamp:
    """The Sunday that closes the Mon-Sun week containing `d` (d itself if it is a Sunday)."""
    d = pd.Timestamp(d).normalize()
    return d + pd.Timedelta(days=(6 - d.weekday()) % 7)


def stats(g: pd.DataFrame) -> dict:
    n = len(g)
    if n == 0:
        return dict(trades=0, win_pct=None, expectancy_r=None, profit_factor=None, pnl=0.0)
    gp, gl = g.loc[g["pnl"] > 0, "pnl"].sum(), -g.loc[g["pnl"] < 0, "pnl"].sum()
    return dict(trades=n, win_pct=100.0 * float((g["pnl"] > 0).mean()), expectancy_r=float(g["r"].mean()),
                profit_factor=float(gp / gl) if gl > 0 else None, pnl=float(g["pnl"].sum()))


def review(trades: pd.DataFrame, week_ending) -> dict:
    """Mon..Sun week ending on `week_ending` (a Sunday) plus all-time, closed trades only."""
    end = pd.Timestamp(week_ending).normalize()
    start = end - pd.Timedelta(days=6)
    t = trades[trades["status"] == "closed"].copy()
    for col in ("cause", "early_stage"):          # ledgers from before these columns existed
        t[col] = t[col].fillna("unknown") if col in t.columns else "unknown"
    t["d"] = pd.to_datetime(t["trade_date"])
    wk = t[(t["d"] >= start) & (t["d"] <= end)]
    by = lambda col, df: {str(k): stats(g) for k, g in df.groupby(col)}  # noqa: E731
    return dict(week_start=f"{start:%Y-%m-%d}", week_end=f"{end:%Y-%m-%d}", week=stats(wk), all_time=stats(t),
                by_grade=by("grade", wk), by_setup=by("setup", wk), by_direction=by("side", wk),
                by_exit=by("exit_reason", wk), all_by_setup=by("setup", t), all_by_grade=by("grade", t),
                by_cause=by("cause", wk), by_early_stage=by("early_stage", wk),
                all_by_cause=by("cause", t), all_by_early_stage=by("early_stage", t))


def _f(v, spec):
    return "n/a" if v is None or pd.isna(v) else format(v, spec)


def _table(rows: dict) -> list[str]:
    out = ["| Slice | Trades | Win % | Expectancy (R) | PF | P&L |", "|---|---|---|---|---|---|"]
    for k, s in rows.items():
        out.append(f"| {k} | {s['trades']} | {_f(s['win_pct'], '.1f')} | {_f(s['expectancy_r'], '+.2f')} | "
                   f"{_f(s['profit_factor'], '.2f')} | {_f(s['pnl'], '+,.0f')} |")
    return out


def render_md(r: dict) -> str:
    lines = [f"# Weekly review {r['week_start']} to {r['week_end']}", "",
             "Paper trading only; historical statistics, not advice.", "", "## Totals", ""]
    lines += _table({"This week": r["week"], "All time": r["all_time"]}) + [""]
    for title, key in (("By grade (this week)", "by_grade"), ("By setup type (this week)", "by_setup"),
                       ("By direction (this week)", "by_direction"), ("By exit (this week)", "by_exit"),
                       ("By cause label (this week)", "by_cause"), ("By early-detection stage (this week)", "by_early_stage"),
                       ("By grade (all time)", "all_by_grade"), ("By setup type (all time)", "all_by_setup"),
                       ("By cause label (all time)", "all_by_cause"),
                       ("By early-detection stage (all time)", "all_by_early_stage")):
        if r[key]:
            lines += [f"## {title}", ""] + _table(r[key]) + [""]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--db", default=str(OUT_DIR / "paper.sqlite"))
    ap.add_argument("--week-ending", default=None, help="a Sunday, YYYY-MM-DD")
    a = ap.parse_args(argv)
    if not Path(a.db).exists():
        raise SystemExit(f"no ledger at {a.db}; run run_daily.py first")
    trades = pd.read_sql_query("SELECT * FROM trades", sqlite3.connect(a.db))
    if trades.empty:
        raise SystemExit("ledger has no trades yet")
    we = pd.Timestamp(a.week_ending) if a.week_ending else week_ending_for(pd.to_datetime(trades["trade_date"]).max())
    r = review(trades, we)
    out = OUT_DIR / f"weekly_{r['week_end']}.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text(render_md(r), encoding="utf-8")
    print(f"{r['week_end']}: {r['week']['trades']} trades this week -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
