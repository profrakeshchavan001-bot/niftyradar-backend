"""Shared paths and parquet helpers for the India Edge scanner."""
from __future__ import annotations

import os
from pathlib import Path

import pandas as pd
import yaml

ROOT = Path(__file__).resolve().parent


def data_root() -> Path:
    """Folder holding cash/fo/idx day files; override with the DATA_DIR env var."""
    env = os.environ.get("DATA_DIR")
    return Path(env) if env else ROOT / "data"


DATA_DIR = data_root()
OUT_DIR = ROOT / "out"
DATASETS = ("cash", "fo", "idx")


def load_config(path: Path | None = None) -> dict:
    with open(path or ROOT / "config.yaml", encoding="utf-8") as fh:
        return yaml.safe_load(fh)


def dataset_dir(name: str) -> Path:
    d = data_root() / name
    d.mkdir(parents=True, exist_ok=True)
    return d


def day_file(name: str, day: pd.Timestamp) -> Path:
    return dataset_dir(name) / f"{pd.Timestamp(day):%Y-%m-%d}.parquet"


FO_COLS = ["date", "instr", "symbol", "oi", "chg_oi", "volume"]


def _fo_day(path: Path) -> pd.DataFrame:
    """One F&O day summed across expiries/strikes per (instr, symbol); abs_chg_oi keeps
    the per-contract absolute OI change the options features need."""
    d = pd.read_parquet(path, columns=FO_COLS).assign(abs_chg_oi=lambda x: x["chg_oi"].abs())
    return d.groupby(["date", "instr", "symbol"], as_index=False)[
        ["oi", "chg_oi", "volume", "abs_chg_oi"]].sum()


def load_dataset(name: str) -> pd.DataFrame:
    """Concatenate every stored day of one dataset (empty frame if none).
    F&O is pre-aggregated per day: 11 years of contract rows do not fit in memory."""
    files = sorted(dataset_dir(name).glob("*.parquet"))
    if not files:
        return pd.DataFrame()
    read = _fo_day if name == "fo" else pd.read_parquet
    df = pd.concat((read(f) for f in files), ignore_index=True)
    df["date"] = pd.to_datetime(df["date"])
    return df
