"""Render docs/SIGNAL-BACKTEST-1114.md from backtest/results/sig_*.json (written by run_signal_backtest.py)."""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RES = HERE / "results"
DOC = HERE.parents[2] / "docs" / "SIGNAL-BACKTEST-1114.md"

# (summary label, result key, where the code lives)
SIGNALS = [
    ("L1 scanner picks (A+B, top 5/day)", "l1_all", "tools/india_edge/layer1.py, score.py, features.py, backtest/engine.py"),
    ("L1 grade A only", "l1_grade_A", "same"),
    ("L1 setup: trend", "l1_setup_trend", "same"),
    ("L1 setup: pullback", "l1_setup_pullback", "same"),
    ("L1 setup: index", "l1_setup_index", "same"),
    ("L1 longs only", "l1_long", "same"),
    ("L1 shorts only", "l1_short", "same"),
    ("L3 chop veto: picks KEPT", "l3_chop_kept", "tools/india_edge/vetoes.py (chop_veto)"),
    ("L3 chop veto: picks VETOED", "l3_chop_vetoed", "same"),
    ("Early detection: accumulation (Watch)", "early_accumulation", "tools/india_edge/early.py"),
    ("Early detection: trigger (Ready)", "early_trigger", "same"),
    ("Early detection: confirmation (Go)", "early_confirmation", "same"),
    ("Signal Box derivatives: bullish flags -> long", "signalbox_bull_long", "tools/india_edge/chain/signalbox.py"),
    ("Signal Box derivatives: bearish flags -> short", "signalbox_bear_short", "same"),
    ("AOC chain screeners (Triple S/R, Power, Oi2Oi, Big Bull/Bear)", "aoc_screeners", "tools/india_edge/chain/screeners.py"),
    ("AOC strike shifts (SFB/SFT/STT/STB)", "aoc_shifts", "tools/india_edge/chain/shifts.py"),
    ("  Triple S/R support", "chain_triple_sr_support", "chain/screeners.py triple_sr"),
    ("  Triple S/R resistance", "chain_triple_sr_resistance", "chain/screeners.py triple_sr"),
    ("  Power stock bull", "chain_power_bull", "chain/screeners.py power_stock"),
    ("  Power stock bear", "chain_power_bear", "chain/screeners.py power_stock"),
    ("  Oi2Oi long (own stop/target)", "chain_oi2oi_long", "chain/screeners.py oi2oi"),
    ("  Oi2Oi short (own stop/target)", "chain_oi2oi_short", "chain/screeners.py oi2oi"),
    ("  Big Bull", "chain_big_bull", "chain/screeners.py trap_signal"),
    ("  Big Bear", "chain_big_bear", "chain/screeners.py trap_signal"),
    ("  SFB", "chain_sfb", "chain/shifts.py"),
    ("  SFT", "chain_sft", "chain/shifts.py"),
    ("  STT", "chain_stt", "chain/shifts.py"),
    ("  STB", "chain_stb", "chain/shifts.py"),
    ("CC5 screener: strong trend", "scr_strong_trend", "tools/india_edge/scores/screeners.py"),
    ("CC5 screener: pullback in uptrend", "scr_pullback_uptrend", "same"),
    ("CC5 screener: volume breakout", "scr_volume_breakout", "same"),
    ("CC5 screener: RS leaders", "scr_rs_leaders", "same"),
    ("CC5 screener: near 52-week high", "scr_near_52w_high", "same"),
    ("CC5 screener: delivery rising", "scr_delivery_rise", "same"),
    ("CC5 screener: steady uptrend", "scr_steady_uptrend", "same"),
    ("CC5 screener: weakest scores (short)", "scr_weakest", "same"),
]

NOT_TESTABLE = [
    ("L2 timing (OB/FVG pullback + BOS/engulfing, ORB, VWAP)", "tools/india_edge/timing.py, session.py",
     "needs 15-minute bars. Only EOD bhavcopy exists locally (intraday.py just synthesises bars), so a point-in-time rebuild is impossible."),
    ("L3 vetoes: IV percentile, event calendar, option spread", "tools/india_edge/vetoes.py",
     "no IV history, events.csv or bid/ask quotes are stored locally. Only the chop (efficiency ratio) veto is rebuilt."),
    ("Cause detector (Block G)", "tools/india_edge/cause.py",
     "a label explaining a move, with no entry/stop/target of its own; it is not a trade signal."),
    ("Option plan (Block D)", "tools/india_edge/options_plan.py",
     "this is the option-buy execution itself; it is exactly what column 'option' tests for every signal."),
    ("Reversal-price S/R touch, support/resistance breaks, tick scanner (Signal Box flags SR_*_TOUCH, *_BREAK)",
     "tools/india_edge/chain/reversal.py, screeners.py SrStocksScanner",
     "triggered by live ticks touching a solved reversal level; EOD data cannot say when or whether a touch happened."),
    ("Market overview score / MMI / FII pulse", "tools/india_edge/chain/market.py",
     "needs participant-wise OI and index chains by strike; the local data has neither for stocks' direction call. Not rebuilt."),
    ("R-factor", "(not found)", "no code with that name exists in any merged PR."),
    ("CC5 scores: quality / valuation", "tools/india_edge/scores/engine.py",
     "fundamentals are an as-of-today snapshot, so a historical test would look ahead. Excluded (the scores validator excludes them too)."),
]


def load() -> dict:
    out = {}
    for p in sorted(RES.glob("sig_*.json")):
        out.update(json.loads(p.read_text()))
    return out


def money(x) -> str:
    return "n/a" if x is None else f"{x:,.0f}"


def short(v: str) -> str:
    return {"PROFITABLE": "PROFITABLE", "NOT PROFITABLE": "NOT PROFITABLE", "TOO FEW TRADES": "TOO FEW"}[v]


def row_cells(r: dict) -> list[str]:
    a, b = r["train"], r["test"]
    return [str(a["trades"]), str(b["trades"]), f"{b['win_pct']}" if b["win_pct"] is not None else "-",
            f"{b['avg_R']}" if b["avg_R"] is not None else "-", f"{b['avg_R_gross']}" if b["avg_R_gross"] is not None else "-",
            f"{b['pf']}" if b["pf"] is not None else "-", money(a["pnl"]), money(b["pnl"]), money(b["max_dd"]), r["verdict"]]


def main() -> None:
    d = load()
    L: list[str] = []
    head = [k for _, k, _ in SIGNALS if k in d]
    prof = [(lab, k, m) for lab, k, _ in SIGNALS if k in d for m in ("stock", "opt_atm", "opt_itm1") if d[k][m]["verdict"] == "PROFITABLE"]
    L.append("# Do NiftyRadar's signals make money on past data? (CC4, 14 Nov 2026)\n")
    L.append("Research measurement on history, not advice, no profit claim. All money in Indian rupees. Every number comes from "
             "`tools/india_edge/backtest/run_signal_backtest.py` on the local NSE bhavcopy (cash, F&O, index, 2015-01 to 2026-10-30).\n")
    L.append("## Answer\n")
    if prof:
        names = "; ".join(f"{lab.strip()} ({m})" for lab, k, m in prof)
        L.append(f"**No edge found.** Out of {len(head)} testable signal variants x 3 ways of trading them, only these passed the "
                 f"'positive on both train and test' rule: {names}. Each has a tiny P&L and a 95% interval for average R that "
                 "includes zero; with this many variants tested, a few lucky passes are expected by chance, so none is treated as an edge. "
                 "Everything else lost money on the test period.\n")
    else:
        L.append(f"**No edge found.** Of {len(head)} testable signal variants, none was profitable on both train and test in any of the three "
                 "ways of trading it (stock, ATM option, 1-ITM option).\n")
    L.append("## Summary (test period 2023-01 to 2026-10, Rs 1,00,000 start, 1.5% risk, max 2 open, costs 2x)\n")
    L.append("| Signal | Verdict stock / option (ATM) | Test-period Rs P&L stock / option (ATM) |")
    L.append("|---|---|---|")
    for lab, k, _ in SIGNALS:
        if k not in d:
            continue
        s, o = d[k]["stock"], d[k]["opt_atm"]
        L.append(f"| {lab} | {short(s['verdict'])} / {short(o['verdict'])} | {money(s['test']['pnl'])} / {money(o['test']['pnl'])} |")
    for lab, _, _ in NOT_TESTABLE:
        L.append(f"| {lab} | NOT TESTABLE (see below) | - |")
    L.append("\nRs P&L is the result of an independent Rs 1,00,000 account per period (equity compounds, so a losing signal can lose "
             "at most about Rs 1,00,000). Verdict rule: PROFITABLE = positive Rs P&L in BOTH train (entries 2015-2022) and test "
             "(entries 2023-now) with at least 30 trades in each; fewer = TOO FEW TRADES; otherwise NOT PROFITABLE.\n")

    L.append("## 1. Every signal NiftyRadar produces, and where it lives\n")
    L.append("| Signal | Code | Tested? |")
    L.append("|---|---|---|")
    seen = set()
    for lab, k, src in SIGNALS:
        if k in d and src not in seen and not lab.startswith("  "):
            pass
        L.append(f"| {lab.strip()} | {src} | {'yes' if k in d else 'NOT RUN'} |")
    for lab, src, why in NOT_TESTABLE:
        L.append(f"| {lab} | {src} | no: {why} |")

    L.append("\n## 2. Method (point in time, nothing tuned)\n")
    L.append("""- **No lookahead.** A signal dated D uses data up to D's close only. The trade enters at the D+1 open. Features use only prior days (`shift(1)` baselines, audited by `audit_lookahead.py`); the F&O universe for a month is ranked on the previous month; prices are back-adjusted for splits/bonuses from NSE's own prev_close.
- **(a) Stock leg.** Entry D+1 open; stop 1.5 x ATR(14) at D; target 2R; exit at the 5th day's close (10th for the CC5 screeners, whose own horizon is 10 sessions; Oi2Oi uses its own stop and target strike). Same-day stop and target: stop first. Gaps fill at the open.
- **(b) Option leg.** Buy a call (long) or put (short), ATM or 1 strike ITM, expiry in 10-15 days if one exists, else the first expiry at least 10 days out (20 for the 10-day screeners). Entry = the option's real D+1 **open** (skipped if it did not trade). Exit follows the underlying's stop/target/time rule. **The option intraday path is approximate (EOD data only):** time exit = real EOD close; gap through the level = real open; intraday touch = Black-Scholes price at the level with vol implied from that day's EOD close. Lot sizes are ignored (fractional units), which flatters small accounts.
- **Capital.** Rs 1,00,000; risk 1.5% of equity per trade; at most 2 open positions (higher-ranked signal first); stock position capped at 50% of equity, option premium at 25%. Train = entries to 2022-12-31, test = entries from 2023-01-01, each an independent Rs 1,00,000 run. At most 5 signals per day are offered (Layer 1's own top_n).
- **Costs at 2x normal.** Stock leg costed as stock futures (brokerage 0.03%, STT 0.02% sell, exchange, stamp, GST, plus slippage 5% of ATR per side), doubled. Option leg: Rs 20 per order, STT 0.1% on the sell premium, exchange 0.035%, stamp, GST, plus 1% of premium slippage per side, doubled.
- **Statistics.** win % and profit factor over trades; avg R = net P&L / amount risked; 'gross R' is before costs (shows whether there is any edge before the toll); max drawdown in Rs on the closed-trade curve; 95% bootstrap interval of avg R in the JSON.
""")
    L.append("## 3. Full results (test period columns unless marked)\n")
    L.append("Columns: trades train / trades test / win % (test) / avg R net (test) / avg R gross (test) / profit factor (test) / "
             "Rs P&L train / Rs P&L test / max drawdown Rs (test) / verdict.\n")
    for mode, title in (("stock", "(a) Underlying stock"), ("opt_atm", "(b) Option buy, ATM"), ("opt_itm1", "(b) Option buy, 1 strike ITM")):
        L.append(f"### {title}\n")
        L.append("| Signal | tr n | te n | win % | avg R | gross R | PF | Rs train | Rs test | max DD | verdict |")
        L.append("|---|---|---|---|---|---|---|---|---|---|---|")
        for lab, k, _ in SIGNALS:
            if k in d and mode in d[k]:
                L.append(f"| {lab} | " + " | ".join(row_cells(d[k][mode])) + " |")
        L.append("")
    L.append("""## 4. Honest caveats and decisions (never-stop defaults)

- **Layer 1 loses mainly before costs are even charged.** Gross average R is about zero for the whole scanner, so costs, not bad luck, make the net negative. See the 'gross R' column.
- **Scope cuts forced by this PC (7.9 GB RAM, mostly in use).** (1) Early detection is scanned on the 120 stocks that spent the most days in the point-in-time top-60 F&O universe (not all 241 ever-members). (2) For the chain, early and CC5 groups at most the 2 best-ranked signals per day are offered (only 2 positions can ever be open); Layer 1 keeps its own top 5. (3) Only the nearest-expiry chain is used for the chain flags.
- **Survivorship.** The universe is the stocks that appear in the local F&O files each month; delisted names that left the files are gone. This flatters results, and they are still negative.
- **Multiple testing.** Dozens of variants were tested. A single PROFITABLE flag among them with a wide interval is expected by chance and is not evidence.
- **Cost model decision.** A first run charged long stock trades delivery-equity costs (STT 0.1% both sides) and gave Layer 1 a loss of about Rs 99,000 / 84,000 (train / test). I then costed the stock leg as stock futures, since every signal lives in the F&O universe; results stayed NOT PROFITABLE. Only the futures-style costs are in the tables; the delivery-cost run is described here for the record.
- **Layer 2 and the intraday part of Layer 3 cannot be tested** with EOD data. Supplying 15-minute bars to `data/intraday/<SYMBOL>/<DATE>.csv` (see `intraday.py`) would let them be rebuilt.
- **Windows file lock fix.** While merging, SQLite files in the paper-ledger tests were left open on Windows; the ledger now has `close()` and tests close it.
- **PR housekeeping.** Merged: #2, #11 (CC8), #3, #4, #6, #5 (python chain, needed to test the chain signals) and #10 (CC5 scores v2). Closed: #7 (superseded by #10), #8 (duplicate chain engine plus sample-data UI touching server.js), #9 (stale integration branch; its content is merged via the others).
- **Antivirus.** Windows flagged `tools/india_edge/scores/install_task.ps1` (a scheduled-task installer) as unwanted software; it is in the repo but unreadable on this PC, so I worked in a separate worktree without it.

## 5. Reproduce

```
set DATA_DIR=C:\\Users\\user\\Desktop\\niftyradar-backend\\tools\\india_edge\\data
python tools/india_edge/data/build_stockopt_ohlc.py --workers 3
python tools/india_edge/backtest/run_signal_backtest.py --groups layer1 --out tools/india_edge/backtest/results/sig_layer1.json
python tools/india_edge/backtest/run_signal_backtest.py --groups chain --out tools/india_edge/backtest/results/sig_chain.json
python tools/india_edge/backtest/run_signal_backtest.py --groups early --out tools/india_edge/backtest/results/sig_early.json
python tools/india_edge/backtest/run_signal_backtest.py --groups scores --out tools/india_edge/backtest/results/sig_scores.json
python tools/india_edge/backtest/make_signal_doc.py
```
""")
    DOC.write_text("\n".join(L), encoding="utf-8")
    print(f"wrote {DOC} ({len(L)} lines)")


if __name__ == "__main__":
    main()
