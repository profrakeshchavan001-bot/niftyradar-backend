"""Compact Telegram text for stage alerts: at most 6 short lines. Sending stays behind
alerts.send_telegram (TELEGRAM_ENABLED=true); this module only builds strings."""
from __future__ import annotations

MAX_LINES = 6
MAX_LEN = 100
FOOT = "Paper only. Not investment advice."


def _cut(s: str, n: int = MAX_LEN) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _num(x, spec=".2f"):
    try:
        return format(float(x), spec)
    except (TypeError, ValueError):
        return None


def _head(tag: str, info: dict) -> str:
    bits = [tag, f"{info.get('symbol', '?')} {str(info.get('side', '')).upper()}".strip()]
    if info.get("grade"):
        sc = _num(info.get("score"), ".0f")
        bits.append(f"{info['grade']} {sc}" if sc else str(info["grade"]))
    return " | ".join(bits)


def _levels(info: dict) -> str | None:
    e, s, t = (_num(info.get(k)) for k in ("entry", "stop", "target"))
    if None in (e, s, t):
        return None
    risk = abs(float(info["entry"]) - float(info["stop"]))
    r = f" | {abs(float(info['target']) - float(info['entry'])) / risk:.1f}R" if risk > 0 else ""
    return f"Entry {e} | SL {s} | TGT {t}{r}"


def _option(plan: dict | None) -> str | None:
    if not plan or plan.get("status") not in ("ok", "skipped") or plan.get("premium") is None:
        return None
    exp = str(plan.get("expiry", ""))[5:] or "?"
    size = f" | {plan['lots']} lots" if plan.get("lots") else (f" | {plan['qty']} units" if plan.get("qty") else "")
    return (f"Opt {plan.get('type')} {_num(plan.get('strike'), '.0f')} exp {exp} | prem {_num(plan['premium'])} "
            f"SL {_num(plan.get('premium_stop'))} TGT {_num(plan.get('premium_target'))}{size}")


def format_message(info: dict) -> str:
    """info: stage (Watch/Ready/Go/Vetoed), symbol, side, grade, score, entry/stop/target, cause (dict with
    label/reason), note, reasons, option_plan, early_stage, prev_stage."""
    stage = str(info.get("stage", "")).upper()
    lines = [_head(stage or "ALERT", info)]
    if stage == "VETOED":
        why = "; ".join(info.get("reasons") or []) or "rule triggered"
        lines.append("Why not: " + why)
    else:
        lv = _levels(info)
        if lv:
            lines.append(lv)
        elif stage == "GO":
            lines.append("Levels pending")
        why = (info.get("cause") or {}).get("reason") or info.get("note")
        if why:
            lines.append("Why: " + why)
        opt = _option(info.get("option_plan"))
        if opt:
            lines.append(opt)
        trail = []
        if info.get("prev_stage") and info.get("prev_stage") != info.get("stage"):
            trail.append(f"Stage {info['prev_stage']} -> {info['stage']}")
        if info.get("early_stage"):
            trail.append(f"early: {info['early_stage']}")
        if trail:
            lines.append(" | ".join(trail))
    lines.append(FOOT)
    body = [_cut(x) for x in lines[:-1]][: MAX_LINES - 1]
    return "\n".join(body + [FOOT])


def format_exit(info: dict) -> str:
    """info: symbol, side, reason, r, pnl."""
    r, pnl = _num(info.get("r"), "+.2f"), _num(info.get("pnl"), "+,.0f")
    head = f"EXIT | {info.get('symbol', '?')} {str(info.get('side', '')).upper()} | {info.get('reason', '?')}"
    line2 = " | ".join(x for x in (f"R {r}" if r else None, f"P&L {pnl}" if pnl else None) if x)
    return "\n".join([_cut(head)] + ([line2] if line2 else []) + [FOOT])


def format_kill_switch(why: str, day: str) -> str:
    return "\n".join([f"HALT | {day}", _cut(f"Kill-switch: {why}"), "No new paper entries for the rest of the day.", FOOT])
