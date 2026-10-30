"""How much does the overall ranking move when the (untuned) weights are nudged?
Each weight is scaled by 0.75 and 1.25 in turn (others renormalised); we report the rank correlation
with the baseline overall score and the top-10 overlap, averaged over the last `days` trading days.
Stable rankings mean no hidden dependence on one lucky weight. Research output only."""
from __future__ import annotations

import numpy as np
import pandas as pd

from scores import engine


def run(P, R, cfg: dict | None = None, days: int = 60) -> dict:
    cfg = cfg or engine.load_cfg()
    W = {k: v for k, v in cfg["weights"].items() if k in R.scores}
    last = P.dates[-days:]
    base = R.scores["overall"].loc[last]
    out = {}
    for k in W:
        for f in (0.75, 1.25):
            w2 = dict(W)
            w2[k] = W[k] * f
            num = sum(R.scores[n].fillna(0) * w2[n] for n in w2)
            den = sum(R.scores[n].notna().astype(float) * w2[n] for n in w2)
            alt = (num / den.where(den > 0)).where(R.status == "ok").loc[last]
            rho, ov = [], []
            for d in last:
                a, b = base.loc[d].dropna(), alt.loc[d].dropna()
                if len(a) < 12:
                    continue
                rho.append(a.rank().corr(b.rank()))
                ov.append(len(set(a.nlargest(10).index) & set(b.nlargest(10).index)) / 10)
            out[f"{k} x{f}"] = {"rank_corr": round(float(np.mean(rho)), 4), "top10_overlap": round(float(np.mean(ov)), 3)}
    worst = min(out.items(), key=lambda kv: kv[1]["rank_corr"])
    return {"days": len(last), "variants": out, "min_rank_corr": worst[1]["rank_corr"], "most_sensitive": worst[0]}
