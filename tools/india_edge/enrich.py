"""Glue: cause (G), early stage (H) and option plan (D) for one pick. Every block is optional and
isolated, so a failure in one never breaks the desk; it reports {"error": ...} instead."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pandas as pd

import cause as CA
import early as EA
import options_plan as OP
from common import ROOT, data_root


def load_lot_sizes() -> dict:
    """Optional {symbol: lot size} from DATA_DIR/lots.json or tools/india_edge/lots.json. Missing -> {}."""
    for p in (data_root() / "lots.json", ROOT / "lots.json"):
        try:
            d = json.loads(Path(p).read_text(encoding="utf-8"))
            return {k: int(v) for k, v in d.items() if not str(k).startswith("_")}
        except (OSError, ValueError, TypeError):
            continue
    return {}


def _safe(fn, *a, **k):
    try:
        return fn(*a, **k)
    except Exception as exc:  # optional block: report, never raise
        return {"error": f"{type(exc).__name__}: {exc}"}


def cause_for(market, row, asof) -> dict:
    sym = row["symbol"]
    bar = CA.bar_context(market.cash, sym, asof)
    ctx = {"event_near": CA.event_near(market.events, sym, asof)}
    return CA.classify_cause(row, bar, ctx)


def early_for(market, symbol, asof) -> dict:
    return EA.early_stage(EA.history(market, symbol, asof))


def plan_for(market, row, asof, trade_date, levels: dict | None, capital: float, lots: dict | None = None) -> dict:
    sym, side = row["symbol"], row["direction"]
    if not levels or levels.get("stop") is None or levels.get("target") is None:
        return dict(status="no_levels", notes=["underlying levels unavailable (ATR needs 15 sessions)"])
    fo_hist = market.fo[(market.fo["symbol"] == sym) & (market.fo["date"] <= pd.Timestamp(asof))] if len(market.fo) \
        else market.fo
    exp = pd.to_datetime(pd.Series(fo_hist["expiry"].unique()), errors="coerce").dropna() \
        if len(fo_hist) else pd.Series(dtype="datetime64[ns]")
    closes = market.cash[(market.cash["symbol"] == sym) & (market.cash["date"] <= pd.Timestamp(asof))].sort_values("date")["close"].to_numpy()
    from_data = [e for e in exp if e >= pd.Timestamp(trade_date).normalize()]
    expiries = from_data + [e for e in OP.upcoming_monthly(trade_date) if e not in set(from_data)]
    plan = OP.option_plan(side, float(levels["entry_ref"]), float(levels["stop"]), float(levels["target"]), sym, asof, trade_date,
                          expiries, capital, fo=market.fo, iv_df=market.iv, closes=closes,
                          lot_size=(lots or load_lot_sizes()).get(sym))
    if not from_data:
        plan["notes"] = list(plan.get("notes", [])) + ["expiry from the monthly rule (no future expiry in the data)"]
    plan["basis"] = "underlying reference levels (1.5x daily ATR stop, 2R target); intraday levels refine at the 15m trigger"
    return plan


def enrich_pick(market, row, asof, trade_date, levels, capital, ecfg=None, with_profile=True, lots=None) -> dict:
    sym = row["symbol"]
    out = dict(cause=_safe(cause_for, market, row, asof), early=_safe(early_for, market, sym, asof),
               option_plan=_safe(plan_for, market, row, asof, trade_date, levels, capital, lots))
    if with_profile:
        out["profile"] = _safe(CA.stock_profile, market.cash, sym, asof, market.fo,
                               CA.cause_config(ecfg)["profile_lookback"])
    return out
