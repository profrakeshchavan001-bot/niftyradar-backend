#!/usr/bin/env python3
"""Hedged option-selling backtest engine: weekly iron condor, hedged short strangle, iron fly.

Always hedged. `build_structure()` refuses (raises ValueError) to build a structure with no wing
legs -- there is no code path to a naked short in this module, by design (the brief bans it).

Data contract (so this runs unchanged once real data lands):
    chain: a pandas DataFrame, one row per (date, expiry, strike, option_type), columns
        ['date','expiry','strike','option_type' ('CE'/'PE'),'close'] (settlement/closing premium).
    spot: DataFrame ['date','close'] -- index close.
    vix: DataFrame ['date','close'] -- India VIX close.
    event_days: set of dt.date to skip entries on (Budget, election results, RBI policy).

Everything below is pure computation on whatever chain/spot/vix frames are passed in; this module
never fetches data itself (see nse_fno_fetcher.py for that).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

from .lot_sizes import lot_size_on
from .options_costs import structure_round_trip_cost

EXIT_AT_EXPIRY = "expiry"
EXIT_50PCT_CAPTURE = "50pct_capture"
EXIT_2X_STOP = "2x_stop"


@dataclass
class Trade:
    structure: str
    index: str
    entry_date: dt.date
    expiry: dt.date
    exit_date: dt.date
    exit_reason: str
    legs: list
    lot_size: int
    num_lots: int
    gross_pnl: float
    cost: float
    net_pnl: float
    margin_required: float
    entry_vix: float


def _nearest_strike(chain_day, expiry, option_type, target_strike):
    rows = chain_day[(chain_day["expiry"] == expiry) & (chain_day["option_type"] == option_type)]
    if rows.empty:
        return None
    idx = (rows["strike"] - target_strike).abs().idxmin()
    return rows.loc[idx]


def build_structure(structure: str, spot_price: float, strike_step: int, wing_width_steps: int,
                     otm_steps: int) -> dict:
    """Return the target strikes for a structure. Raises if it would be naked."""
    atm = round(spot_price / strike_step) * strike_step
    if structure == "iron_condor":
        legs = {
            "sell_call": atm + otm_steps * strike_step,
            "sell_put": atm - otm_steps * strike_step,
            "buy_call_wing": atm + (otm_steps + wing_width_steps) * strike_step,
            "buy_put_wing": atm - (otm_steps + wing_width_steps) * strike_step,
        }
    elif structure == "hedged_strangle":
        legs = {
            "sell_call": atm + otm_steps * strike_step,
            "sell_put": atm - otm_steps * strike_step,
            "buy_call_wing": atm + (otm_steps + wing_width_steps + 2) * strike_step,  # wider
            "buy_put_wing": atm - (otm_steps + wing_width_steps + 2) * strike_step,
        }
    elif structure == "iron_fly":
        legs = {
            "sell_call": atm,
            "sell_put": atm,
            "buy_call_wing": atm + wing_width_steps * strike_step,
            "buy_put_wing": atm - wing_width_steps * strike_step,
        }
    else:
        raise ValueError(f"unknown structure {structure}")
    if "buy_call_wing" not in legs or "buy_put_wing" not in legs:
        raise ValueError("refusing to build a structure with no hedge wings (naked is banned)")
    return legs


def run_variant(chain, spot, vix, event_days, *, structure: str, index: str,
                 entry_days_before_expiry: int, exit_rule: str, vix_max: float | None,
                 strike_step: int, wing_width_steps: int, otm_steps: int,
                 slippage_bps_of_premium: float = 150.0) -> list[Trade]:
    """Backtest one variant across every expiry cycle present in `chain`/`spot`/`vix`.

    Returns one Trade per expiry cycle where an entry was taken (skipped cycles -- event day,
    VIX filter, missing strikes -- are simply absent, never filled with a placeholder).
    """
    trades: list[Trade] = []
    expiries = sorted(chain["expiry"].unique())
    for expiry in expiries:
        candidate_dates = sorted(d for d in spot["date"].unique() if d <= expiry)
        target_dates = [d for d in candidate_dates if (expiry - d).days <= entry_days_before_expiry]
        if not target_dates:
            continue
        entry_date = target_dates[-1] if (expiry - target_dates[-1]).days >= entry_days_before_expiry - 1 else target_dates[0]
        if entry_date in event_days:
            continue
        vix_row = vix[vix["date"] == entry_date]
        entry_vix = float(vix_row["close"].iloc[0]) if not vix_row.empty else float("nan")
        if vix_max is not None and (vix_row.empty or entry_vix > vix_max):
            continue
        spot_row = spot[spot["date"] == entry_date]
        if spot_row.empty:
            continue
        spot_price = float(spot_row["close"].iloc[0])
        try:
            targets = build_structure(structure, spot_price, strike_step, wing_width_steps, otm_steps)
        except ValueError:
            continue

        chain_entry_day = chain[chain["date"] == entry_date]
        legs = {}
        ok = True
        for leg_name, target_strike in targets.items():
            opt_type = "CE" if "call" in leg_name else "PE"
            row = _nearest_strike(chain_entry_day, expiry, opt_type, target_strike)
            if row is None:
                ok = False
                break
            side = "buy" if "wing" in leg_name else "sell"
            legs[leg_name] = {"side": side, "strike": float(row["strike"]), "option_type": opt_type,
                               "entry_premium": float(row["close"])}
        if not ok:
            continue

        gross_premium_in = sum(l["entry_premium"] for l in legs.values() if l["side"] == "sell")
        gross_premium_out_cost = sum(l["entry_premium"] for l in legs.values() if l["side"] == "buy")
        net_credit = gross_premium_in - gross_premium_out_cost

        # Walk forward day by day to apply the exit rule (expiry / 50% capture / 2x stop),
        # using each leg's own mark-to-market from the chain.
        future_days = sorted(d for d in chain["date"].unique() if entry_date < d <= expiry)
        exit_date, exit_reason = expiry, EXIT_AT_EXPIRY
        exit_premiums = None
        for d in future_days:
            chain_day = chain[chain["date"] == d]
            marks = {}
            missing = False
            for leg_name, leg in legs.items():
                row = chain_day[(chain_day["expiry"] == expiry) & (chain_day["strike"] == leg["strike"]) &
                                 (chain_day["option_type"] == leg["option_type"])]
                if row.empty:
                    missing = True
                    break
                marks[leg_name] = float(row["close"].iloc[0])
            if missing:
                continue
            mtm_credit_in = sum(marks[n] for n, l in legs.items() if l["side"] == "sell")
            mtm_cost_out = sum(marks[n] for n, l in legs.items() if l["side"] == "buy")
            mtm_net_credit = mtm_credit_in - mtm_cost_out
            captured = net_credit - mtm_net_credit  # positive = profit so far (credit shrinking)
            if exit_rule == EXIT_50PCT_CAPTURE and net_credit > 0 and captured >= 0.5 * net_credit:
                exit_date, exit_reason, exit_premiums = d, EXIT_50PCT_CAPTURE, marks
                break
            if exit_rule == EXIT_2X_STOP and net_credit > 0 and mtm_net_credit >= 2 * net_credit:
                exit_date, exit_reason, exit_premiums = d, EXIT_2X_STOP, marks
                break
        if exit_premiums is None:
            chain_exit_day = chain[chain["date"] == expiry]
            exit_premiums = {}
            missing = False
            for leg_name, leg in legs.items():
                row = chain_exit_day[(chain_exit_day["expiry"] == expiry) & (chain_exit_day["strike"] == leg["strike"]) &
                                      (chain_exit_day["option_type"] == leg["option_type"])]
                if row.empty:
                    missing = True
                    break
                exit_premiums[leg_name] = float(row["close"].iloc[0])
            if missing:
                continue

        lot_size = lot_size_on(entry_date, index)
        num_lots = 1
        gross_pnl = 0.0
        cost_legs = []
        for leg_name, leg in legs.items():
            exit_p = exit_premiums[leg_name]
            if leg["side"] == "sell":
                gross_pnl += (leg["entry_premium"] - exit_p) * lot_size * num_lots
            else:
                gross_pnl += (exit_p - leg["entry_premium"]) * lot_size * num_lots
            cost_legs.append({"side": leg["side"], "entry_premium": leg["entry_premium"],
                               "exit_premium": exit_p})
        cost = structure_round_trip_cost(cost_legs, lot_size, num_lots, slippage_bps_of_premium)
        net_pnl = round(gross_pnl - cost, 2)

        wing_width_points = wing_width_steps * strike_step
        margin_required = round(0.12 * spot_price * lot_size, 2) if net_credit > 0 else \
            round(wing_width_points * lot_size, 2)  # simplistic: defined-risk margin ~= max loss

        trades.append(Trade(structure, index, entry_date, expiry, exit_date, exit_reason,
                             cost_legs, lot_size, num_lots, round(gross_pnl, 2), cost, net_pnl,
                             margin_required, entry_vix))
    return trades


def build_demo_bot_spec(structure: str, index: str) -> dict:
    """Config a future PASS variant would need to become a demo (paper) bot. Not wired to
    anything -- Group 6 is skipped tonight because nothing passed to qualify for it.
    """
    return {
        "bot_name": f"demo_{index.lower()}_{structure}",
        "capital_model": "own capital, own P&L ledger (new table, not the live paper_trades table)",
        "fees": "options_costs.structure_round_trip_cost, same rates as backtest",
        "telegram_format": "existing TELEGRAM_TRADE_ALERTS format + trade number, per bot",
        "hello_message": f"Hello, I am {structure} demo bot for {index}, I am live now (sent once)",
        "data_source": "Dhan option prices (DHAN_ACCESS_TOKEN) -- disabled with "
                        "'waiting for Dhan token' logged if the token is absent",
    }
