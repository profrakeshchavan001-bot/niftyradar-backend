"""Stage alerts Watch -> Ready -> Go, as pure functions, with a stubbed Telegram sender.

`stage_alerts` returns message strings only; sending is a separate, opt-in step that does
nothing unless TELEGRAM_ENABLED=true (plus TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).
"""
from __future__ import annotations

import os

ORDER = {"Vetoed": -1, "Watch": 0, "Ready": 1, "Go": 2}
FOOTER = "Paper trade only. Statistics, not investment advice."


def stage_of(state: str, vetoed: bool = False) -> str:
    """Map a timing state to a stage. none/zone -> Watch, ready -> Ready, go -> Go."""
    if vetoed:
        return "Vetoed"
    return {"go": "Go", "ready": "Ready"}.get(state, "Watch")


def _fmt(info: dict) -> str:
    base = f"{info['symbol']} {info['side']}"
    if info.get("grade"):
        base += f" (grade {info['grade']}, score {info.get('score', 0):.0f})"
    return base


def stage_changes(prev: dict[str, str], curr: dict[str, dict]) -> list[tuple[str, dict]]:
    """(message, info) for every symbol whose stage moved up (or became Vetoed).

    prev: {symbol: stage}; curr: {symbol: {stage, symbol, side, grade, score, entry, stop, target,
    reasons, note}}. A symbol absent from prev is treated as not yet announced (Watch is announced)."""
    out = []
    for sym, info in curr.items():
        new, old = info["stage"], prev.get(sym)
        if old == new:
            continue
        if new == "Vetoed":
            why = "; ".join(info.get("reasons", [])) or "rule triggered"
            out.append((f"[VETOED] {_fmt(info)}: {why}. {FOOTER}", info))
        elif old is None or ORDER[new] > ORDER.get(old, -1):
            note = info.get("note")
            if new == "Watch":
                out.append((f"[WATCH] {_fmt(info)} " + (note or "is on today's desk. Waiting for an OB/FVG pullback.")
                            + f" {FOOTER}", info))
            elif new == "Ready":
                out.append((f"[READY] {_fmt(info)} " + (note or "pulled back into its zone. Waiting for BOS/engulfing "
                            "and a trade window.") + f" {FOOTER}", info))
            elif new == "Go":
                lv = (f"paper entry {info['entry']:.2f}, SL {info['stop']:.2f}, target {info['target']:.2f}."
                      if None not in (info.get("entry"), info.get("stop"), info.get("target")) else "levels pending.")
                out.append((f"[GO] {_fmt(info)} {lv}" + (f" {note}" if note else "") + f" {FOOTER}", info))
    return out


def stage_alerts(prev: dict[str, str], curr: dict[str, dict]) -> list[str]:
    """Messages only; see stage_changes for the matching info dicts."""
    return [t for t, _ in stage_changes(prev, curr)]


def telegram_enabled(env=None) -> bool:
    return (env if env is not None else os.environ).get("TELEGRAM_ENABLED", "false").strip().lower() == "true"


def send_telegram(text: str, env=None, post=None) -> bool:
    """Stub-safe sender. Returns False (and sends nothing) unless TELEGRAM_ENABLED=true and the
    token/chat id are set. `post` is injectable for tests; the default uses requests."""
    e = env if env is not None else os.environ
    if not telegram_enabled(e):
        return False
    token, chat = e.get("TELEGRAM_BOT_TOKEN"), e.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return False
    if post is None:
        import requests
        post = requests.post
    r = post(f"https://api.telegram.org/bot{token}/sendMessage", data={"chat_id": chat, "text": text}, timeout=15)
    return bool(getattr(r, "ok", False))


def dispatch(messages: list[str], env=None, post=None) -> int:
    """Send every message through the (stubbed) sender; returns how many were actually sent."""
    return sum(1 for m in messages if send_telegram(m, env, post))
