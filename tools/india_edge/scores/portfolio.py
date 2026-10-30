"""Portfolio-level paper simulation (research only, never orders).

Timeline: signal on the close of day t; trades at the close of t+1 (one-day delay); rebalance every
`hold_days` sessions; positions still selected are kept (no trade, no cost). Equal-weight slots of
equity/n_positions, whole shares, a slot is capped at `capacity_adv_pct` of the stock's 20-day average
traded value, unfilled slots stay cash (no leverage). A stock that stops trading is marked and sold at
its last traded price (delistings are not dropped). Costs: costs.py, doubled.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from scores import costs as C
from scores import engine


def simulate(P, R, cand: pd.DataFrame, rank: pd.DataFrame, cfg: dict | None = None, *, cost_mult: float | None = None,
             n_pos: int | None = None, h: int | None = None, start: int = 0) -> dict:
    cfg = cfg or engine.load_cfg()
    pc, cc = cfg["portfolio"], cfg["costs"]
    n_pos, h = n_pos or pc["n_positions"], h or pc["hold_days"]
    cap_frac = pc["capacity_adv_pct"] / 100.0
    close = P.close
    closeF = close.ffill()
    cl, clF = close.to_numpy(float), closeF.to_numpy(float)
    traded = (close.notna() & (P.volume.fillna(0) > 0)).to_numpy()
    atr = R.extra["ind"]["atr_pct"].to_numpy(float)
    adv = (close * P.volume).rolling(20, min_periods=10).mean().to_numpy(float)
    ok = (R.status == "ok").to_numpy()
    cd, rk = cand.reindex(index=P.dates, columns=P.symbols).fillna(False).to_numpy(bool), rank.reindex(index=P.dates, columns=P.symbols).to_numpy(float)
    nifty = P.nifty.to_numpy(float)
    n = len(P.dates)
    syms = list(P.symbols)
    rb = list(range(max(start, 1), n - 1, h))                     # rebalance (trade) days r; signal day is r-1
    cash, hold = float(pc["capital"]), {}                         # hold: col -> [shares, entered_k]
    eq_pre, dates, bench, uni, turn, held_n, cap_list, costs_paid, hold_len, cost_k = [], [], [], [], [], [], [], 0.0, [], []
    for k, r in enumerate(rb):
        t = r - 1
        # mark to market at r (last traded price if it stopped trading)
        px = clF[r]
        pos_val = sum(sh * px[j] for j, (sh, _) in hold.items() if not np.isnan(px[j]))
        E = cash + pos_val
        eq_pre.append(E)
        dates.append(P.dates[r])
        # target set from the signal at t
        elig = np.where(cd[t] & ok[t] & traded[r] & ~np.isnan(rk[t]))[0]
        want = [j for j in elig[np.argsort(-rk[t][elig], kind="stable")]][:n_pos]
        # sells: anything held and not wanted (or no longer tradable)
        traded_value, cost_before = 0.0, costs_paid
        for j in list(hold):
            if j not in want:
                sh, ek = hold.pop(j)
                price = px[j]
                notional = sh * price
                slip_atr = atr[t, j] if t < n else np.nan
                f = C.side_fraction("sell", notional, slip_atr, cc, cost_mult)
                cash += notional * (1 - f)
                costs_paid += notional * f
                traded_value += notional
                hold_len.append((k - ek) * h)
        # buys
        E_now = cash + sum(sh * px[j] for j, (sh, _) in hold.items() if not np.isnan(px[j]))
        slot = E_now / n_pos
        caps = []
        for j in want:
            if j in hold:
                continue
            a = adv[t, j]
            notional = min(slot, cap_frac * a) if not np.isnan(a) else slot
            if not np.isnan(a):
                caps.append(cap_frac * a * n_pos)
            price = cl[r, j]
            slip_atr = atr[t, j]
            f = C.side_fraction("buy", notional, slip_atr, cc, cost_mult)
            shares = int(np.floor(min(notional, cash) / (price * (1 + f))))
            if shares <= 0:
                continue
            spend = shares * price
            cost = spend * f
            cash -= spend + cost
            costs_paid += cost
            traded_value += spend
            hold[j] = [shares, k]
        held_n.append(len(hold))
        cost_k.append(costs_paid - cost_before)
        turn.append(traded_value / E if E > 0 else np.nan)
        if caps:
            cap_list.append(min(caps))
        # benchmark and equal-weight universe for the NEXT period (r -> next rebalance), filled when known
        bench.append(None)
        uni.append(None)
    # final mark at the last rebalance + h (or last day)
    end = min(n - 1, rb[-1] + h) if rb else 0
    pxe = clF[end] if rb else None
    if rb:
        E_end = cash + sum(sh * pxe[j] for j, (sh, _) in hold.items() if not np.isnan(pxe[j]))
        eq = np.array(eq_pre + [E_end])
        for k, r in enumerate(rb):
            r2 = rb[k + 1] if k + 1 < len(rb) else end
            bench[k] = nifty[r2] / nifty[r] - 1 if not (np.isnan(nifty[r]) or np.isnan(nifty[r2])) else np.nan
            m = cd[r - 1] & ok[r - 1] & ~np.isnan(clF[r]) & ~np.isnan(clF[r2])
            uni[k] = float(np.mean(clF[r2][m] / clF[r][m] - 1)) if m.any() else np.nan
        ret = eq[1:] / eq[:-1] - 1
        for j, (sh, ek) in hold.items():
            hold_len.append((len(rb) - ek) * h)
    else:
        eq, ret = np.array([pc["capital"]]), np.array([])
    return {"dates": pd.DatetimeIndex(dates), "equity": eq, "ret": ret, "bench": np.array(bench, float), "universe": np.array(uni, float),
            "turnover": np.array(turn, float), "positions": np.array(held_n, float), "hold_days": np.array(hold_len, float),
            "costs_paid": costs_paid, "cost_period": np.array(cost_k, float), "capacity_inr": cap_list, "h": h, "n_pos": n_pos}
