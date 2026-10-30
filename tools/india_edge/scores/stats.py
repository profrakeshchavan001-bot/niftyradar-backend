"""Statistics for the validation report: block bootstrap, Monte Carlo drawdown, multiple testing.
Everything is seeded and uses only numpy (no new dependencies)."""
from __future__ import annotations

import math

import numpy as np


def ann_factor(h: int) -> float:
    return 252.0 / h


def cagr(r: np.ndarray, h: int) -> float | None:
    r = np.asarray(r, float)
    if len(r) == 0:
        return None
    g = float(np.prod(1 + r))
    return None if g <= 0 else g ** (ann_factor(h) / len(r)) - 1


def sharpe(r: np.ndarray, h: int) -> float | None:
    r = np.asarray(r, float)
    if len(r) < 3 or r.std(ddof=1) == 0:
        return None
    return float(r.mean() / r.std(ddof=1) * math.sqrt(ann_factor(h)))


def max_drawdown(r: np.ndarray) -> float | None:
    r = np.asarray(r, float)
    if len(r) == 0:
        return None
    eq = np.cumprod(1 + r)
    return float((eq / np.maximum.accumulate(eq) - 1).min())


def _blocks(rng, n: int, block: int, size: int) -> np.ndarray:
    """Indices for a circular block bootstrap of length `size` from n observations."""
    nb = -(-size // block)
    starts = rng.integers(0, n, nb)
    idx = (starts[:, None] + np.arange(block)[None, :]) % n
    return idx.ravel()[:size]


def bootstrap(r: np.ndarray, reps: int, block: int, seed: int, h: int) -> dict:
    """95% CI of the mean per-period return and of the annualised Sharpe; one-sided p-value for mean > 0
    from the same-block bootstrap of the mean-CENTRED series (null: true mean is zero)."""
    r = np.asarray(r, float)
    n = len(r)
    if n < 8:
        return {"n": n, "mean": None, "ci": None, "sharpe_ci": None, "p_mean_gt0": None}
    rng = np.random.default_rng(seed)
    means, sh, null = np.empty(reps), np.empty(reps), np.empty(reps)
    c = r - r.mean()
    for i in range(reps):
        ix = _blocks(rng, n, block, n)
        s = r[ix]
        means[i], null[i] = s.mean(), c[ix].mean()
        sd = s.std(ddof=1)
        sh[i] = s.mean() / sd * math.sqrt(ann_factor(h)) if sd > 0 else np.nan
    p = (1 + np.sum(null >= r.mean())) / (reps + 1)
    return {"n": n, "mean": float(r.mean()), "ci": [float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))],
            "sharpe_ci": [float(np.nanpercentile(sh, 2.5)), float(np.nanpercentile(sh, 97.5))], "p_mean_gt0": float(p)}


def mc_drawdown(r: np.ndarray, paths: int, block: int, seed: int, length: int | None = None) -> dict:
    """Max-drawdown distribution of block-resampled paths of the same length as the sample."""
    r = np.asarray(r, float)
    n = len(r)
    if n < 8:
        return {"paths": 0}
    length = length or n
    rng = np.random.default_rng(seed)
    dd = np.empty(paths)
    for i in range(paths):
        dd[i] = max_drawdown(r[_blocks(rng, n, block, length)])
    return {"paths": paths, "median_pct": round(float(np.median(dd)) * 100, 2), "p95_worst_pct": round(float(np.percentile(dd, 5)) * 100, 2),
            "prob_dd_over_20pct": round(float((dd < -0.20).mean()), 3), "prob_dd_over_30pct": round(float((dd < -0.30).mean()), 3)}


def holm(p: list[float | None], alpha: float) -> list[bool]:
    """Holm step-down: which hypotheses are rejected (None p-values never reject)."""
    idx = [i for i, x in enumerate(p) if x is not None]
    order = sorted(idx, key=lambda i: p[i])
    m, rej, stop = len(order), [False] * len(p), False
    for k, i in enumerate(order):
        if stop or p[i] > alpha / (m - k):
            stop = True
            continue
        rej[i] = True
    return rej


def benjamini_hochberg(p: list[float | None], alpha: float) -> list[bool]:
    idx = [i for i, x in enumerate(p) if x is not None]
    order = sorted(idx, key=lambda i: p[i])
    m, cut = len(order), -1
    for k, i in enumerate(order, start=1):
        if p[i] <= alpha * k / m:
            cut = k
    rej = [False] * len(p)
    for k, i in enumerate(order, start=1):
        if k <= cut:
            rej[i] = True
    return rej


def multiple_testing(pvals: dict[str, float | None], alpha: float) -> dict:
    names = list(pvals)
    p = [pvals[n] for n in names]
    m = sum(x is not None for x in p)
    raw = [x is not None and x < alpha for x in p]
    h, b = holm(p, alpha), benjamini_hochberg(p, alpha)
    return {"tests": m, "alpha": alpha, "expected_false_positives": round(m * alpha, 2),
            "pass_raw": [n for n, x in zip(names, raw) if x], "pass_holm": [n for n, x in zip(names, h) if x],
            "pass_bh": [n for n, x in zip(names, b) if x],
            "note": ("With this many tests, about %.1f would pass at %.0f%% by luck alone; trust only the Holm/BH rows."
                     % (m * alpha, alpha * 100))}
