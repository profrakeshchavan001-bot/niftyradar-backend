"""Data-health checks for the scores run. Counts only; never raises."""
from __future__ import annotations


def check(P, R, day) -> dict:
    notes, c = [], P.close
    st = R.status.loc[day]
    counts = {k: int(v) for k, v in st.value_counts().items()}
    pos = P.dates.get_loc(day)
    nifty_days = P.nifty.dropna().index
    missing_days = [f"{d:%Y-%m-%d}" for d in nifty_days[-60:] if P.close.loc[d].notna().sum() < 0.5 * len(P.symbols)]
    jumps = ((c.pct_change(1, fill_method=None).abs() > 0.4).iloc[max(0, pos - 250): pos + 1]).sum().sum()
    bad_px = int(((c <= 0) | (P.high < P.low)).iloc[pos].sum())
    dlv = P.deliv.iloc[pos]
    bad_dlv = int(((dlv < 0) | (dlv > 100)).sum())
    other = int((P.sector == "Other").sum())
    checks = {
        "stocks_total": int(len(P.symbols)), "status": counts,
        "last_bar": f"{day:%Y-%m-%d}", "days_with_thin_coverage_60d": missing_days,
        "price_jumps_over_40pct_1y": int(jumps), "bad_price_rows_today": bad_px,
        "delivery_out_of_range_today": bad_dlv, "unmapped_sector": other,
        "has_vix": P.vix is not None, "has_pcr": P.pcr is not None, "has_fundamentals": P.fundamentals is not None,
        "has_nifty": bool(P.nifty.notna().any()),
        "point_in_time_universe": getattr(P, "member", None) is not None,
        "fo_members_today": None if getattr(P, "member", None) is None else int(P.member.loc[day].sum()),
    }
    ok = counts.get("ok", 0)
    if ok < 20:
        notes.append("Fewer than 20 stocks scored; sector and breadth views are thin.")
    if missing_days:
        notes.append(f"{len(missing_days)} recent days have thin price coverage.")
    if jumps:
        notes.append("Large one-day price jumps found; check split/bonus adjustment.")
    if bad_px or bad_dlv:
        notes.append("Some rows failed basic sanity checks.")
    if other:
        notes.append(f"{other} stocks have no sector mapping (sector views use 'Other').")
    if not checks["point_in_time_universe"]:
        notes.append("No F&O data: universe is not point-in-time, so results are exposed to survivorship bias.")
    if not checks["has_vix"]:
        notes.append("India VIX not loaded: fear/greed uses Nifty realised volatility.")
    if not checks["has_pcr"]:
        notes.append("No put/call data: fear/greed runs without it.")
    if not checks["has_fundamentals"]:
        notes.append("No fundamentals file: quality and valuation scores are not produced.")
    grade = "bad" if (ok < 5 or not checks["has_nifty"]) else "warn" if notes else "good"
    return {"grade": grade, "notes": notes, "checks": checks}
