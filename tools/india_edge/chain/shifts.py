"""Strike shift flags and the TOT table.

SFT = resistance strike moved down, SFB = support strike moved up,
STT = support and resistance both moved up, STB = both moved down.
TOT maps (support move, resistance move) to a bias.
"""
from __future__ import annotations

TOT = {
    ("up", "up"): "strong-bull", ("up", "same"): "bull", ("up", "down"): "neutral",
    ("same", "up"): "bull", ("same", "same"): "neutral", ("same", "down"): "bear",
    ("down", "up"): "neutral", ("down", "same"): "bear", ("down", "down"): "strong-bear",
}


def move(prev: float | None, now: float | None) -> str:
    if prev is None or now is None or prev == now:
        return "same"
    return "up" if now > prev else "down"


def shift_flags(prev_support, prev_resistance, support, resistance) -> dict:
    s, r = move(prev_support, support), move(prev_resistance, resistance)
    flags = []
    if r == "down":
        flags.append("SFT")
    if s == "up":
        flags.append("SFB")
    if s == "up" and r == "up":
        flags.append("STT")
    if s == "down" and r == "down":
        flags.append("STB")
    return {"support_move": s, "resistance_move": r, "flags": flags, "bias": TOT[(s, r)]}
