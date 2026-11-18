#!/usr/bin/env python3
"""Orchestrator: loads data/research_cache/*.parquet, splits train (2015-01-01..2022-12-31) /
test (2023-01-01..today) for daily-bar strategies (first-60%/last-40% for the short intraday
samples, since yfinance only serves ~60 calendar days of 5m/30m history), runs each S1-S10
backtest, applies the two add-on variants (A: market-mood ADX filter on S4/S5/S8/S10, B:
volatility-based position sizing on all ten), keeps a variant only when it improves the TEST
period, and writes the real PASS/FAIL/LOW-DATA table to docs/RESEARCH-STRATEGIES-REPORT.md.

Run: python3 research/strategies/run_backtests.py
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import s1_trend
import s2_btc_momentum
import s3_nifty200_momentum
import s4_noise_band_breakout
import s5_first_last_30min
import s6_52week_high
import s7_overnight
import s8_last_30min_momentum
import s9_pairs_trading
import s10_orb_stocks_in_play
from addons import mood_filter, realized_vol, target_risk_from_vol
from costs import equity_intraday_costs
from metrics import summarize, verdict
from universe import MACRO_TICKERS, load_fno_universe, load_nifty200_like, load_sector_map

REPO_ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = REPO_ROOT / "data" / "research_cache"
TRAIN_START, TRAIN_END = "2015-01-01", "2022-12-31"
TEST_START = dt.date(2023, 1, 1)
CAPITAL = 100_000.0


def _cache_path(symbol: str, interval: str) -> Path:
    safe = symbol.replace("^", "IDX_").replace("=", "_").replace("/", "_")
    return CACHE_DIR / f"{safe}_{interval}.parquet"


def load_daily(symbol: str) -> pd.DataFrame | None:
    p = _cache_path(symbol, "1d")
    if not p.exists():
        return None
    df = pd.read_parquet(p)
    df.index = pd.to_datetime(df.index)
    return df


def load_intraday(symbol: str, interval: str) -> pd.DataFrame | None:
    p = _cache_path(symbol, interval)
    if not p.exists():
        return None
    df = pd.read_parquet(p)
    df.index = pd.to_datetime(df.index)
    df.index.name = "datetime"
    return df


def split_daily(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    idx_dates = df.index.tz_localize(None) if df.index.tz is not None else df.index
    train = df[(idx_dates >= TRAIN_START) & (idx_dates <= TRAIN_END)]
    test = df[idx_dates.date >= TEST_START]
    return train, test


def split_intraday_60_40(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Short intraday samples (yfinance ~60-day limit): first 60% of bars = train, last 40% = test."""
    n = len(df)
    cut = int(n * 0.6)
    return df.iloc[:cut], df.iloc[cut:]


def apply_mood_filter(trades: list, daily_underlying: pd.DataFrame) -> list:
    """Keep only trades whose entry falls on a 'trend day' per ADX(14) >= 20 of the daily
    underlying instrument. Market-mood add-on A."""
    if daily_underlying is None or not trades:
        return trades
    regime = mood_filter(daily_underlying)
    regime_by_date = {d.date(): bool(v) for d, v in regime.items() if pd.notna(v)}
    out = []
    for t in trades:
        ed = t["entry_date"]
        ed_date = ed.date() if hasattr(ed, "date") else ed
        if regime_by_date.get(ed_date, False):
            out.append(t)
    return out


def apply_vol_sizing(trades: list, daily_underlying: pd.DataFrame, train_cutoff: str = TRAIN_END) -> list:
    """Scale each trade's pnl/cost by a vol-sizing factor (smaller size in high-vol regimes),
    using realized_vol(20d) of the daily underlying. Median vol is taken from the TRAIN period
    only (fit on train, applied to both train and test) to avoid leakage. Add-on B."""
    if daily_underlying is None or not trades:
        return trades
    vol = realized_vol(daily_underlying)
    train_vol = vol[vol.index <= train_cutoff].dropna()
    median_vol = float(train_vol.median()) if len(train_vol) else float(vol.dropna().median() or 0.0)
    vol_by_date = {d.date(): v for d, v in vol.items() if pd.notna(v)}
    out = []
    for t in dict_copy_list(trades):
        ed = t["entry_date"]
        ed_date = ed.date() if hasattr(ed, "date") else ed
        cur_vol = vol_by_date.get(ed_date)
        scale = target_risk_from_vol(1.0, cur_vol, median_vol) if cur_vol else 1.0
        t["pnl_inr"] = round(t["pnl_inr"] * scale, 2)
        t["costs_inr"] = round(t.get("costs_inr", 0.0) * scale, 2)
        out.append(t)
    return out


def dict_copy_list(trades: list) -> list:
    return [dict(t) for t in trades]


def better_on_test(base_test_summary: dict, variant_test_summary: dict) -> bool:
    """A variant is kept only if it improves TEST net profit, or (same/better profit with a
    smaller drawdown). Never decided on train alone."""
    if variant_test_summary["net_profit_inr"] > base_test_summary["net_profit_inr"]:
        return True
    if variant_test_summary["net_profit_inr"] == base_test_summary["net_profit_inr"]:
        return variant_test_summary["max_drawdown_inr"] < base_test_summary["max_drawdown_inr"]
    return False


def build_result_row(name: str, label: str, base: dict, variant_tag: str, train_s: dict, test_s: dict,
                      source: str, date_range: str) -> dict:
    v, reason = verdict(train_s, test_s)
    return {
        "strategy": name, "label": label, "verdict": v, "reason": reason,
        "variant": variant_tag, "source": source, "date_range": date_range,
        "train": train_s, "test": test_s,
    }


def main() -> None:
    results = []

    # ---------------- S1: trend following (Nifty, BankNifty, Gold, Crude, USDINR) ----------------
    s1_instruments = [("Nifty", "^NSEI"), ("BankNifty", "^NSEBANK"), ("Gold", "GC=F"),
                       ("Crude", "CL=F"), ("USDINR", "USDINR=X")]
    for label, ticker in s1_instruments:
        daily = load_daily(ticker)
        if daily is None or daily.empty:
            results.append({"strategy": "S1", "label": label, "verdict": "LOW-DATA",
                             "reason": "no cached daily data", "variant": "base",
                             "source": "yfinance", "date_range": "n/a",
                             "train": summarize([], CAPITAL), "test": summarize([], CAPITAL)})
            continue
        train, test = split_daily(daily)
        res = s1_trend.run(train, test, CAPITAL)
        variant_trades_test = apply_vol_sizing(dict_copy_list(res["test_trades"]), daily)
        variant_trades_train = apply_vol_sizing(dict_copy_list(res["train_trades"]), daily)
        vtest_s, vtrain_s = summarize(variant_trades_test, CAPITAL), summarize(variant_trades_train, CAPITAL)
        use_variant = better_on_test(res["test"], vtest_s)
        final_train = vtrain_s if use_variant else res["train"]
        final_test = vtest_s if use_variant else res["test"]
        results.append(build_result_row("S1", label, res, "vol-sizing" if use_variant else "base",
                                         final_train, final_test, "yfinance",
                                         f"{daily.index.min().date()}..{daily.index.max().date()}"))

    # ---------------- S2: BTC weekly momentum ----------------
    btc_daily = load_daily("BTC-USD")
    if btc_daily is not None and not btc_daily.empty:
        train, test = split_daily(btc_daily)
        res = s2_btc_momentum.run(train, test, CAPITAL)
        variant_test = apply_vol_sizing(dict_copy_list(res["test_trades"]), btc_daily)
        variant_train = apply_vol_sizing(dict_copy_list(res["train_trades"]), btc_daily)
        vtest_s, vtrain_s = summarize(variant_test, CAPITAL), summarize(variant_train, CAPITAL)
        use_variant = better_on_test(res["test"], vtest_s)
        final_train = vtrain_s if use_variant else res["train"]
        final_test = vtest_s if use_variant else res["test"]
        results.append(build_result_row("S2", "BTC", res, "vol-sizing" if use_variant else "base",
                                         final_train, final_test, "yfinance",
                                         f"{btc_daily.index.min().date()}..{btc_daily.index.max().date()}"))
    else:
        results.append({"strategy": "S2", "label": "BTC", "verdict": "LOW-DATA",
                         "reason": "no cached BTC daily data", "variant": "base",
                         "source": "yfinance", "date_range": "n/a",
                         "train": summarize([], CAPITAL), "test": summarize([], CAPITAL)})

    # ---------------- Shared: Nifty200-like stock closes (for S3, S6, S9) ----------------
    universe_syms = load_nifty200_like()
    stock_daily = {}
    for sym in universe_syms:
        d = load_daily(f"{sym}.NS")
        if d is not None and not d.empty:
            stock_daily[sym] = d
    closes_train = {s: split_daily(d)[0]["close"] for s, d in stock_daily.items()}
    closes_test = {s: split_daily(d)[1]["close"] for s, d in stock_daily.items()}
    n_stocks = len(stock_daily)
    date_range_stocks = "2015-01-01..today (per-symbol, see FETCH_LOG.txt)"

    nifty_daily = load_daily("^NSEI")
    nifty_train, nifty_test = split_daily(nifty_daily) if nifty_daily is not None else (None, None)

    # ---------------- S3: Nifty200 momentum (regime-filtered by Nifty) ----------------
    if nifty_daily is not None and n_stocks > 0:
        res = s3_nifty200_momentum.run(nifty_train, nifty_test, closes_train, closes_test, CAPITAL)
        results.append(build_result_row("S3", f"Nifty200-like ({n_stocks} names)", res, "base",
                                         res["train"], res["test"], "yfinance", date_range_stocks))
    else:
        results.append({"strategy": "S3", "label": "Nifty200-like", "verdict": "LOW-DATA",
                         "reason": "insufficient stock/index data", "variant": "base",
                         "source": "yfinance", "date_range": "n/a",
                         "train": summarize([], CAPITAL), "test": summarize([], CAPITAL)})

    # ---------------- S6: 52-week high ----------------
    if n_stocks > 0:
        res = s6_52week_high.run(closes_train, closes_test, CAPITAL)
        results.append(build_result_row("S6", f"Nifty200-like ({n_stocks} names)", res, "base",
                                         res["train"], res["test"], "yfinance", date_range_stocks))
    else:
        results.append({"strategy": "S6", "label": "Nifty200-like", "verdict": "LOW-DATA",
                         "reason": "insufficient stock data", "variant": "base",
                         "source": "yfinance", "date_range": "n/a",
                         "train": summarize([], CAPITAL), "test": summarize([], CAPITAL)})

    # ---------------- S7: overnight (Nifty) ----------------
    if nifty_daily is not None:
        res = s7_overnight.run(nifty_train, nifty_test, CAPITAL)
        variant_test = apply_vol_sizing(dict_copy_list(res["test_trades"]), nifty_daily)
        variant_train = apply_vol_sizing(dict_copy_list(res["train_trades"]), nifty_daily)
        vtest_s, vtrain_s = summarize(variant_test, CAPITAL), summarize(variant_train, CAPITAL)
        use_variant = better_on_test(res["test"], vtest_s)
        final_train = vtrain_s if use_variant else res["train"]
        final_test = vtest_s if use_variant else res["test"]
        results.append(build_result_row("S7", "Nifty", res, "vol-sizing" if use_variant else "base",
                                         final_train, final_test, "yfinance",
                                         f"{nifty_daily.index.min().date()}..{nifty_daily.index.max().date()}"))

    # ---------------- S9: pairs trading (F&O universe, train-only cointegration) ----------------
    fno_syms = load_fno_universe()
    fno_closes_train = {s: closes_train[s] for s in fno_syms if s in closes_train}
    fno_closes_test = {s: closes_test[s] for s in fno_syms if s in closes_test}
    sector_map = load_sector_map()
    if fno_closes_train:
        res = s9_pairs_trading.run(fno_closes_train, fno_closes_test, sector_map, CAPITAL)
        n_pairs = len(res.get("pairs", []))
        results.append(build_result_row("S9", f"F&O pairs ({n_pairs} pairs)", res, "base",
                                         res["train"], res["test"], "yfinance", date_range_stocks))
    else:
        results.append({"strategy": "S9", "label": "F&O pairs", "verdict": "LOW-DATA",
                         "reason": "insufficient F&O stock data", "variant": "base",
                         "source": "yfinance", "date_range": "n/a",
                         "train": summarize([], CAPITAL), "test": summarize([], CAPITAL)})

    # ---------------- Intraday strategies: S4, S5, S8 (Nifty), S4 also BTC, S10 (F&O sample) ----------------
    nifty_30m = load_intraday("^NSEI", "30m")
    nifty_5m = load_intraday("^NSEI", "5m")
    btc_30m = load_intraday("BTC-USD", "30m")
    intraday_note = None
    if nifty_30m is not None:
        n_days = len(set(nifty_30m.index.date))
        intraday_note = f"yfinance 30m: only {n_days} calendar days available ({nifty_30m.index.min().date()}..{nifty_30m.index.max().date()}); first 60% bars = train, last 40% = test"

    def run_intraday_s(name, label, run_fn, df, source, mood_daily=None, extra_args=()):
        if df is None or df.empty:
            results.append({"strategy": name, "label": label, "verdict": "LOW-DATA",
                             "reason": "no cached intraday data (yfinance history too short)",
                             "variant": "base", "source": source, "date_range": "n/a",
                             "train": summarize([], CAPITAL), "test": summarize([], CAPITAL)})
            return
        n_days = len(set(df.index.date))
        train, test = split_intraday_60_40(df)
        res = run_fn(train, test, *extra_args)
        base_train, base_test = res["train"], res["test"]
        best_train, best_test, variant_tag = base_train, base_test, "base"

        if mood_daily is not None and name in ("S4", "S5", "S8", "S10"):
            mtest = summarize(apply_mood_filter(dict_copy_list(res["test_trades"]), mood_daily), CAPITAL)
            mtrain = summarize(apply_mood_filter(dict_copy_list(res["train_trades"]), mood_daily), CAPITAL)
            if better_on_test(best_test, mtest):
                best_train, best_test, variant_tag = mtrain, mtest, "mood-filter"

        vtest = summarize(apply_vol_sizing(dict_copy_list(res["test_trades"]), mood_daily) if mood_daily is not None
                           else res["test_trades"], CAPITAL)
        vtrain = summarize(apply_vol_sizing(dict_copy_list(res["train_trades"]), mood_daily) if mood_daily is not None
                            else res["train_trades"], CAPITAL)
        if mood_daily is not None and better_on_test(best_test, vtest):
            best_train, best_test, variant_tag = vtrain, vtest, (variant_tag + "+vol-sizing" if variant_tag != "base" else "vol-sizing")

        date_range = f"{df.index.min().date()}..{df.index.max().date()} ({n_days} calendar days, 30m/5m yfinance limit)"
        v, reason = verdict(best_train, best_test)
        results.append({"strategy": name, "label": label, "verdict": v, "reason": reason,
                         "variant": variant_tag, "source": "yfinance", "date_range": date_range,
                         "train": best_train, "test": best_test})

    run_intraday_s("S4", "Nifty", s4_noise_band_breakout.run, nifty_30m, "yfinance", mood_daily=nifty_daily,
                    extra_args=(CAPITAL, "index"))
    if btc_30m is not None:
        run_intraday_s("S4", "BTC", s4_noise_band_breakout.run, btc_30m, "yfinance", mood_daily=btc_daily,
                        extra_args=(CAPITAL, "crypto"))
    run_intraday_s("S5", "Nifty", s5_first_last_30min.run, nifty_5m, "yfinance", mood_daily=nifty_daily)
    run_intraday_s("S8", "Nifty", s8_last_30min_momentum.run, nifty_30m, "yfinance", mood_daily=nifty_daily)

    # ---------------- S10: 5-min ORB on stocks-in-play ----------------
    s10_sample = ["RELIANCE.NS", "HDFCBANK.NS", "ICICIBANK.NS", "TCS.NS"]
    all_trades = []
    for sym in s10_sample:
        df5 = load_intraday(sym, "5m")
        daily_sym = load_daily(sym)
        if df5 is None or daily_sym is None:
            continue
        atr = s10_orb_stocks_in_play._daily_atr(daily_sym)
        df5 = df5.copy()
        df5["date"] = df5.index.date
        for d in sorted(df5["date"].unique()):
            day_df = df5[df5["date"] == d].drop(columns=["date"])
            atr_rows = atr[atr.index.date < d]
            if len(atr_rows) == 0:
                continue
            atr_val = float(atr_rows.iloc[-1])
            trade = s10_orb_stocks_in_play.backtest_s10_symbol(day_df, atr_val, capital_leg=CAPITAL / len(s10_sample))
            if trade:
                trade["symbol"] = sym
                all_trades.append(trade)
    all_trades.sort(key=lambda t: t["entry_date"])
    if all_trades:
        cut = int(len(all_trades) * 0.6)
        train_trades, test_trades = all_trades[:cut], all_trades[cut:]
        res = s10_orb_stocks_in_play.run(train_trades, test_trades, CAPITAL)
        best_train, best_test, variant_tag = res["train"], res["test"], "base"
        if nifty_daily is not None:
            mtest = summarize(apply_mood_filter(dict_copy_list(test_trades), nifty_daily), CAPITAL)
            mtrain = summarize(apply_mood_filter(dict_copy_list(train_trades), nifty_daily), CAPITAL)
            if better_on_test(best_test, mtest):
                best_train, best_test, variant_tag = mtrain, mtest, "mood-filter"
        n_days_5m = len(set(load_intraday(s10_sample[0], "5m").index.date))
        results.append({"strategy": "S10", "label": f"F&O sample ({len(s10_sample)} of 60 stocks)",
                         "verdict": verdict(best_train, best_test)[0], "reason": verdict(best_train, best_test)[1],
                         "variant": variant_tag, "source": "yfinance",
                         "date_range": f"{n_days_5m} calendar days (yfinance 5m limit); only {len(s10_sample)}/60 "
                                        "F&O stocks had 5-min history fetched, not a true top-20-by-volume rank",
                         "train": best_train, "test": best_test})
    else:
        results.append({"strategy": "S10", "label": "F&O sample", "verdict": "LOW-DATA",
                         "reason": "no cached 5-min data for the sampled F&O stocks",
                         "variant": "base", "source": "yfinance", "date_range": "n/a",
                         "train": summarize([], CAPITAL), "test": summarize([], CAPITAL)})

    write_report(results, intraday_note, n_stocks)
    with open(CACHE_DIR / "backtest_results.json", "w") as f:
        json.dump(results, f, indent=2, default=str)

    print(f"Wrote {len(results)} result rows. PASS: {sum(1 for r in results if r['verdict'] == 'PASS')}")
    for r in results:
        print(f"{r['strategy']} ({r['label']}): {r['verdict']} variant={r['variant']} "
              f"train_net={r['train']['net_profit_inr']} test_net={r['test']['net_profit_inr']} "
              f"test_trades={r['test']['n_trades']}")


def write_report(results: list, intraday_note: str | None, n_stocks: int) -> None:
    lines = [
        "# Research-strategy backtest report",
        "",
        f"Generated {dt.date.today().isoformat()}. Capital per strategy: Rs 1,00,000. "
        "Train = 2015-01-01..2022-12-31, test = 2023-01-01..today for daily-bar strategies "
        "(first 60%/last 40% of bars for the short intraday samples). Costs: realistic Indian "
        "brokerage/STT/exchange charges/GST/stamp duty/slippage (see research/strategies/costs.py), "
        "futures costs for S1/S9-style trades, crypto exchange fees for BTC. PASS requires net "
        "profit after costs on BOTH train and test AND >= 30 test trades; otherwise FAIL or LOW-DATA.",
        "",
        f"Data source: yfinance (daily history back to 2015 where listed; Nifty200-like universe "
        f"is an approximation of {n_stocks} liquid large/mid caps -- the repo has no official "
        "Nifty 200 constituent list and nseindia.com was not reachable, see research/strategies/README.md). "
        + (intraday_note or "Intraday data: not available."),
        "",
        "| Strategy | Market | Verdict | Variant | Data Source | Date Range | Train Net P&L (Rs) | "
        "Test Net P&L (Rs) | Test Trades | Win % (test) | Max DD (Rs, test) | Profit Factor (test) | Why it failed |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        tr, te = r["train"], r["test"]
        reason = r.get("reason", "") if r["verdict"] != "PASS" else ""
        lines.append(
            f"| {r['strategy']} | {r['label']} | {r['verdict']} | {r['variant']} | {r['source']} | "
            f"{r['date_range']} | {tr['net_profit_inr']:.0f} | {te['net_profit_inr']:.0f} | "
            f"{te['n_trades']} | {te['win_pct']:.1f} | {te['max_drawdown_inr']:.0f} | "
            f"{te['profit_factor']} | {reason} |"
        )

    passes = [r for r in results if r["verdict"] == "PASS"]
    lines += ["", "## Demo bots created", ""]
    if passes:
        for r in passes:
            lines.append(f"- **{r['strategy']} ({r['label']})**: new paper-trading bot added (see "
                          "src/paper / paperbot).")
    else:
        lines.append("None. No strategy reached PASS on this data/cost combination, so per the task's "
                      "own rule (\"create zero bots if nothing passes\") no demo bot was added.")

    lines += ["", "## Honest limitations", "",
              "- Nifty 200 constituents: no official list was reachable; a hand-built "
              f"{n_stocks}-name liquid large/mid-cap proxy is used for S3/S6/S9 instead.",
              "- Intraday data (S4, S5, S8, S10): yfinance serves at most ~60 calendar days of "
              "5-minute/30-minute history, so these are LOW-DATA by construction relative to the "
              "task's 30-test-trade PASS bar; this is a free-data-source limit, not a bug.",
              "- S10: only 4 of the ~60 F&O stocks had 5-min history fetched (a sample, not a true "
              "daily top-20-by-first-5-min-volume ranking across the whole universe), due to the "
              "same 60-day intraday limit making a full-universe 5-min pull impractical on a free source.",
              ""]

    (REPO_ROOT / "docs" / "RESEARCH-STRATEGIES-REPORT.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
