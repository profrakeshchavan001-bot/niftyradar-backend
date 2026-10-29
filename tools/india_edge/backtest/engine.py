"""Backtest engine for the Layer 1 scanner.

No lookahead by construction:
  * features for day t use data up to t's close only (averages shift(1));
  * the F&O universe for a month is ranked on data up to the PREVIOUS month end;
  * entry is the NEXT day's open; ATR(14) is measured at the signal day's close.
Execution: stop 1.5 x ATR, target 2R, exit at the 5th day's close, cost 0.1R,
1% risk per trade (R is the unit; equity compounds 1% x R per trade).
"""
from __future__ import annotations

import itertools
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from features import build_features  # noqa: E402
from score import BIAS  # noqa: E402

FEATURE_COLS = ["price_chg_pct", "oi_chg_pct", "deliv_pct", "deliv_ratio", "rs",
                "sector_rs", "unusual_oi", "adv_cr", "quadrant"]
COMPONENTS = ["quadrant", "delivery", "rs", "sector_rs", "unusual_oi"]
EXEC = dict(atr_n=14, stop_atr=1.5, target_r=2.0, hold=5, cost_r=0.1, risk_pct=1.0)


# ------------------------------------------------------------- universe
def monthly_membership(fo: pd.DataFrame, dates: pd.DatetimeIndex, size: int = 60,
                       lookback: int = 20) -> pd.DataFrame:
    """Bool (dates x symbols): symbol is in the top-`size` by 20d avg option contracts,
    ranked on the last trading day BEFORE the month of `date` (no lookahead)."""
    vol = (fo[fo["instr"] == "STO"].groupby(["date", "symbol"])["volume"].sum()
           .unstack().reindex(dates).fillna(0))
    avg = vol.rolling(lookback, min_periods=lookback).mean()
    mask = pd.DataFrame(False, index=dates, columns=vol.columns)
    months = dates.to_period("M")
    for m in months.unique():
        prior = dates[months < m]
        if len(prior) == 0 or avg.loc[prior[-1]].isna().all():
            continue
        top = avg.loc[prior[-1]].nlargest(size).index
        mask.loc[months == m, top] = True
    return mask


# ------------------------------------------------------------- execution
def atr(high, low, prev_close, n=14):
    tr = np.maximum(high - low, np.maximum((high - prev_close).abs(), (low - prev_close).abs()))
    return tr.rolling(n, min_periods=n).mean()


def simulate_side(O, H, L, C, atr_df, side: str, stop_atr=1.5, target_r=2.0, hold=5):
    """Gross R and exit offset (days after the signal day) for entering at the next open.

    Same-day stop and target -> stop is assumed first. Gaps through the stop or
    target fill at the open. Unfilled after `hold` days -> exit at that day's close."""
    sgn = 1.0 if side == "long" else -1.0
    entry = O.shift(-1)
    risk = stop_atr * atr_df
    stop, target = entry - sgn * risk, entry + sgn * target_r * risk
    R = np.full(O.shape, np.nan)
    K = np.full(O.shape, np.nan)
    done = ~(entry.notna() & risk.notna() & (risk > 0)).to_numpy()
    for k in range(hold):
        o, h, l, c = (x.shift(-1 - k).to_numpy() for x in (O, H, L, C))
        st, tg, en = stop.to_numpy(), target.to_numpy(), entry.to_numpy()
        if side == "long":
            px = np.where(o <= st, o, np.where(l <= st, st, np.where(o >= tg, o,
                          np.where(h >= tg, tg, np.nan))))
        else:
            px = np.where(o >= st, o, np.where(h >= st, st, np.where(o <= tg, o,
                          np.where(l <= tg, tg, np.nan))))
        if k == hold - 1:
            px = np.where(np.isnan(px), c, px)
        newly = ~done & ~np.isnan(px)
        R[newly] = (sgn * (px - en) / risk.to_numpy())[newly]
        K[newly] = k + 1
        done |= newly
    return (pd.DataFrame(R, index=O.index, columns=O.columns),
            pd.DataFrame(K, index=O.index, columns=O.columns))


# ------------------------------------------------------------- panel
def build_panel(cash, fo, idx, cfg, sectors, feature_shift: int = 0) -> pd.DataFrame:
    """One row per (date, symbol) for universe members, with features and both
    directions' gross R. feature_shift=n lags every feature by n days (audit only)."""
    dates = pd.DatetimeIndex(sorted(cash["date"].unique()))
    member = monthly_membership(fo, dates, cfg["universe"]["size"], cfg["universe"]["lookback_days"])
    syms = [s for s in member.columns if member[s].any() and s in set(cash["symbol"])]
    feats = build_features(cash, fo, idx, syms, sectors, cfg["lookback"])
    if feature_shift:
        feats = feats.sort_values(["symbol", "date"]).reset_index(drop=True)
        feats[FEATURE_COLS] = feats.groupby("symbol")[FEATURE_COLS].shift(feature_shift)
        feats["quadrant"] = feats["quadrant"].fillna("neutral")

    wide = lambda col: cash.pivot(index="date", columns="symbol", values=col).reindex(  # noqa: E731
        index=dates, columns=syms)
    O, H, L, C, PC = (wide(c) for c in ("open", "high", "low", "close", "prev_close"))
    a = atr(H, L, PC, EXEC["atr_n"])
    out = feats.set_index(["date", "symbol"])
    for side in ("long", "short"):
        R, K = simulate_side(O, H, L, C, a, side, EXEC["stop_atr"], EXEC["target_r"], EXEC["hold"])
        out[f"{side}_R"] = R.stack().reindex(out.index)
        out[f"{side}_k"] = K.stack().reindex(out.index)
    out["member"] = [bool(member.at[d, s]) for d, s in out.index]
    out = out.reset_index()
    out["_pos"] = dates.get_indexer(out["date"])
    panel = out
    panel.attrs["dates"] = dates
    return panel


# ------------------------------------------------------------- scoring
def fractions(df: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Vectorised twin of score.components(): each component as a 0..1 fraction."""
    t = cfg["thresholds"]
    q = df["quadrant"].astype(str)
    bias = q.map(BIAS).fillna(0).to_numpy(dtype=float)
    clip = lambda x: np.clip(np.nan_to_num(np.asarray(x, dtype=float)), 0.0, 1.0)  # noqa: E731
    buildup = q.isin(["long_buildup", "short_buildup"]).to_numpy()
    quad = np.where(bias == 0, 0.0, np.where(buildup, 1.0, t["quadrant_reversal_weight"]))
    return pd.DataFrame({
        "quadrant": quad,
        "delivery": clip((df["deliv_ratio"].to_numpy() - 1) / (t["delivery_full_mult"] - 1)),
        "rs": clip(bias * df["rs"].to_numpy() / t["rs_full_pct"]),
        "sector_rs": clip(bias * df["sector_rs"].to_numpy() / t["sector_rs_full_pct"]),
        "unusual_oi": clip((df["unusual_oi"].to_numpy() - 1) / (t["unusual_oi_full"] - 1)),
    }, index=df.index)


def prepare_candidates(panel: pd.DataFrame, cfg: dict) -> pd.DataFrame:
    """Rows that can ever be traded (member, direction long/short, liquid, enterable),
    with component fractions, setup type and the R of the chosen direction."""
    t = cfg["thresholds"]
    df = panel[panel["member"]].copy()
    bias = df["quadrant"].map(BIAS).fillna(0).to_numpy()
    rs = df["rs"].to_numpy(dtype=float)
    direction = np.where((bias > 0) & (rs > 0), "long", np.where((bias < 0) & (rs < 0), "short", "none"))
    df["direction"] = direction
    df = df[(df["direction"] != "none") & (df["adv_cr"] >= cfg["min_adv_cr"])].copy()
    fr = fractions(df, cfg)
    for c in COMPONENTS:
        df["f_" + c] = fr[c].to_numpy()
    index_like = (fr["sector_rs"] >= t["index_sector_min"]) & (fr["rs"] <= t["index_stock_max"])
    buildup = df["quadrant"].isin(["long_buildup", "short_buildup"])
    df["setup"] = np.where(index_like, "index", np.where(buildup, "trend", "pullback"))
    df["gross_R"] = np.where(df["direction"] == "long", df["long_R"], df["short_R"])
    df["hold_k"] = np.where(df["direction"] == "long", df["long_k"], df["short_k"])
    df = df[df["gross_R"].notna()].reset_index(drop=True)
    dates = panel.attrs["dates"]
    exit_pos = (df["_pos"] + df["hold_k"]).astype(int).clip(upper=len(dates) - 1)
    df["exit_date"] = dates[exit_pos]
    df.attrs["dates"] = dates
    return df


def normalise(weights: dict) -> dict:
    tot = float(sum(weights.values()))
    return {k: 100.0 * v / tot for k, v in weights.items()}


def select_trades(cand: pd.DataFrame, cfg: dict, weights: dict, start, end) -> pd.DataFrame:
    """Top-N per signal day among grade A/B (score >= grades.B) in [start, end]."""
    w = normalise(weights)
    d = cand[(cand["date"] >= pd.Timestamp(start)) & (cand["date"] <= pd.Timestamp(end))]
    if d.empty:
        return d.assign(score=[], grade=[], R=[])
    score = sum(d["f_" + k].to_numpy() * w[k] for k in COMPONENTS)
    d = d.assign(score=np.round(score, 1))
    d = d[d["score"] >= cfg["grades"]["B"]]
    d = d.sort_values(["date", "score", "adv_cr"], ascending=[True, False, False])
    d = d[d.groupby("date").cumcount() < cfg["top_n"]].copy()
    d["grade"] = np.where(d["score"] >= cfg["grades"]["A"], "A", "B")
    d["R"] = d["gross_R"] - EXEC["cost_r"]
    return d


# ------------------------------------------------------------- statistics
def stats(trades: pd.DataFrame) -> dict:
    n = len(trades)
    if n == 0:
        return dict(trades=0, win_pct=np.nan, avg_R=np.nan, profit_factor=np.nan,
                    max_dd_R=np.nan, expectancy=np.nan)
    net = trades.sort_values(["exit_date", "date"])["R"].to_numpy()
    cum = np.cumsum(net)
    dd = float(np.max(np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:] - cum))
    loss = -net[net < 0].sum()
    return dict(
        trades=n,
        win_pct=100.0 * float((net > 0).mean()),
        avg_R=float(trades["gross_R"].mean()),          # before costs
        profit_factor=float(net[net > 0].sum() / loss) if loss > 0 else np.inf,
        max_dd_R=dd,
        expectancy=float(net.mean()),                   # after 0.1R cost
    )


def breakdown(trades: pd.DataFrame, col: str) -> pd.DataFrame:
    rows = {k: stats(g) for k, g in trades.groupby(col)}
    return pd.DataFrame(rows).T if rows else pd.DataFrame()


def equity_curve(trades: pd.DataFrame, split: str) -> pd.DataFrame:
    t = trades.sort_values(["exit_date", "date"])
    eq = 100.0 * np.cumprod(1 + EXEC["risk_pct"] / 100.0 * t["R"].to_numpy())
    return pd.DataFrame({"split": split, "entry_signal_date": t["date"].to_numpy(),
                         "exit_date": t["exit_date"].to_numpy(), "symbol": t["symbol"].to_numpy(),
                         "direction": t["direction"].to_numpy(), "grade": t["grade"].to_numpy(),
                         "setup": t["setup"].to_numpy(), "R": t["R"].to_numpy(),
                         "cum_R": np.cumsum(t["R"].to_numpy()), "equity": eq})


# ------------------------------------------------------------- tuning
def weight_grid(values=(10, 20, 30), keys=tuple(COMPONENTS)) -> list[dict]:
    seen, out = set(), []
    for combo in itertools.product(values, repeat=len(keys)):
        w = normalise(dict(zip(keys, combo)))
        sig = tuple(round(v, 6) for v in w.values())
        if sig not in seen:
            seen.add(sig)
            out.append(w)
    return out


def pick_best(results: list[tuple[dict, dict]], min_trades: int = 200):
    """results: [(weights, stats)]. Best expectancy among those with >= min_trades."""
    ok = [(w, s) for w, s in results if s["trades"] >= min_trades and not np.isnan(s["expectancy"])]
    return max(ok, key=lambda r: r[1]["expectancy"]) if ok else None


def tune(cand: pd.DataFrame, cfg: dict, start, end, grid=None, min_trades: int = 200):
    results = [(w, stats(select_trades(cand, cfg, w, start, end))) for w in (grid or weight_grid())]
    return pick_best(results, min_trades), results
