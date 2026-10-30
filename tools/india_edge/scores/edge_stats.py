"""Edge Stats: reads the base-rate JSON; says so plainly when nothing survived testing."""
from __future__ import annotations

import json
from pathlib import Path

NO_EDGE = "No edge found. Every setup we tested was indistinguishable from chance after testing."


def load(path: Path) -> dict:
    if not Path(path).exists():
        return {"status": "no_data", "message": "Base-rate file not available yet.", "setups": []}
    d = json.loads(Path(path).read_text())
    setups = d.get("setups", [])
    survivors = [s for s in setups if s.get("survived")]
    return {"status": "edge" if survivors else "no_edge", "asof": d.get("asof"), "source": d.get("source"),
            "horizon_days": d.get("horizon_days"), "n_tested": len(setups), "n_survived": len(survivors),
            "message": (f"{len(survivors)} of {len(setups)} tested setups survived testing."
                        if survivors else NO_EDGE),
            "setups": [{"name": s["name"], "samples": s["samples"], "hit_rate": s["hit_rate"],
                        "base_rate": s["base_rate"], "survived": bool(s["survived"]), "note": s.get("note", "")}
                       for s in setups],
            "disclaimer": "Historical statistics only. Past results do not predict future results. Not investment advice."}
