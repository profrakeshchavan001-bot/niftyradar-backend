"""Shared paths and parquet helpers for the India Edge scanner."""
from __future__ import annotations

from pathlib import Path

import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
OUT_DIR = ROOT / "out"
DATASETS = ("cash", "fo", "idx")


def load_config(path: Path | None = None) -> dict:
    with open(path or ROOT / "config.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def dataset_dir(name: str) -> Path:
    d = DATA_DIR / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def day_file(name: str, day: pd.Timestamp) -> Path:
    return dataset_dir(name) / f"{pd.Timestamp(day):%Y-%m-%d}.parquet"


def load_dataset(name: str) -> pd.DataFrame:
    """Concatenate every stored day of one dataset (empty frame if none)."""
    files = sorted(dataset_dir(name).glob("*.parquet"))
    if not files:
        return pd.DataFrame()
    df = pd.concat((pd.read_parquet(f) for f in files), ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    return df
