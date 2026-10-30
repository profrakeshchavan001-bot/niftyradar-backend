"""One day of chain analysis -> Signal Box records (derivatives group) + market block."""
from __future__ import annotations

from . import market, reversal, screeners, shifts, sr
from .adapters import FoDay
from .model import INDEX_SYMBOLS, Chain

TOUCH = screeners.TOUCH_TOL
BULL_FLAGS = {"SFB", "STT", "TRIPLE_SR_SUPPORT", "POWER_BULL", "OI2OI_LONG", "BIG_BULL", "SR_SUPPORT_TOUCH", "RESISTANCE_BREAK"}
BEAR_FLAGS = {"SFT", "STB", "TRIPLE_SR_RESISTANCE", "POWER_BEAR", "OI2OI_SHORT", "BIG_BEAR", "SR_RESISTANCE_TOUCH", "SUPPORT_BREAK"}


def market_block(day: FoDay, prev: FoDay | None, part: dict, part_prev: dict, ctx: dict) -> dict:
    nifty, bn = day.chains.get("NIFTY"), day.chains.get("BANKNIFTY")
    stocks = [c for s, c in day.chains.items() if s not in INDEX_SYMBOLS]
    prev_spot = {s: c.spot for s, c in (prev.chains.items() if prev else [])}
    moved = [(c.spot > prev_spot[c.symbol]) for c in stocks if c.symbol in prev_spot]
    adv = 100.0 * sum(moved) / len(moved) if moved else 50.0
    sectors = ctx.get("sectors", {})
    sig = market.overview_signals(nifty, bn, day.index_fut, prev.index_fut if prev else {}, sectors, adv)
    ov = market.overview_score(sig)
    pulse = market.fii_pulse(part, part_prev) if part and part_prev else {"points": {}, "total": 0, "bias": "neutral"}
    nf = sr.pcr_bar(nifty)
    m = market.mmi(nf["pcr"], sr.fresh_writing_share(nifty)["pe_share"], adv,
                   sum(v > 0 for v in sectors.values()), len(sectors), ov["score"], pulse["total"])
    return {"overview": ov, "fii_pulse": pulse, "mmi": m, "pcr_nifty": nf, "advancers_pct": round(adv, 2), "vix": ctx.get("vix", 15.0)}


def stock_record(chain: Chain, prev_chain: Chain | None, mkt: dict) -> dict:
    vix = mkt.get("vix", 15.0)
    s = sr.support_resistance(chain)
    sup, res = s["primary_support"], s["primary_resistance"]
    flags: list[str] = []
    rs = reversal.support_level(chain, sup, vix) if sup is not None else None
    rr = reversal.resistance_level(chain, res, vix) if res is not None else None
    rev_s = (rs and (rs["level"] or rs["projection"])) or None
    rev_r = (rr and (rr["level"] or rr["projection"])) or None
    for lvl, tag in ((rev_s, "SR_SUPPORT_TOUCH"), (rev_r, "SR_RESISTANCE_TOUCH")):
        if lvl and abs(chain.spot - lvl) / lvl <= TOUCH:
            flags.append(tag)
    bias = "neutral"
    if prev_chain:
        ps = sr.support_resistance(prev_chain)
        sh = shifts.shift_flags(ps["primary_support"], ps["primary_resistance"], sup, res)
        flags += sh["flags"]
        bias = sh["bias"]
        if sup is not None and prev_chain.row(sup) and prev_chain.row(sup - prev_chain.step):
            p = reversal.support_level(prev_chain, sup, vix)
            if p and rs and reversal.gap_cross(p["gap"], rs["gap"]) == "down":
                flags.append("SUPPORT_BREAK")
        if res is not None and prev_chain.row(res) and prev_chain.row(res + prev_chain.step):
            p = reversal.resistance_level(prev_chain, res, vix)
            if p and rr and reversal.gap_cross(p["gap"], rr["gap"]) == "up":
                flags.append("RESISTANCE_BREAK")
    t = screeners.triple_sr(chain)
    if t["support"] is not None:
        flags.append("TRIPLE_SR_SUPPORT")
    if t["resistance"] is not None:
        flags.append("TRIPLE_SR_RESISTANCE")
    ps_ = screeners.power_stock(chain)
    if ps_:
        flags.append("POWER_BULL" if ps_ == "bull" else "POWER_BEAR")
    o = screeners.oi2oi(chain)
    if o:
        flags.append("OI2OI_LONG" if o["side"] == "long" else "OI2OI_SHORT")
    flags += screeners.trap_signal(chain)
    return {
        "symbol": chain.symbol, "date": chain.date, "group": "derivatives", "spot": chain.spot, "expiry": chain.expiry,
        "support": sup, "resistance": res, "reversal_s": round(rev_s, 2) if rev_s else None,
        "reversal_r": round(rev_r, 2) if rev_r else None, "flags": flags,
        "market_score": mkt["overview"]["score"], "fii_pulse": mkt["fii_pulse"]["total"],
        "detail": {"bias": bias, "pcr": sr.pcr_bar(chain), "support_by": s["support"], "resistance_by": s["resistance"],
                   "colour_ce": {str(k): v for k, v in sr.colour_tags(chain, "ce").items()},
                   "colour_pe": {str(k): v for k, v in sr.colour_tags(chain, "pe").items()},
                   "oi2oi": o},
    }


def analyse(day: FoDay, prev: FoDay | None, part: dict, part_prev: dict, ctx: dict, symbols=None) -> dict:
    mkt = market_block(day, prev, part, part_prev, ctx)
    recs = []
    for sym, ch in sorted(day.chains.items()):
        if symbols and sym not in symbols:
            continue
        recs.append(stock_record(ch, prev.chains.get(sym) if prev else None, mkt))
    return {"date": day.date, "market": mkt, "records": recs}
