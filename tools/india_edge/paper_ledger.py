"""Virtual paper-trading ledger (SQLite) with position sizing and kill-switches.

Paper only: nothing here talks to a broker. R = (exit - entry) / (entry - stop) for longs
(mirrored for shorts). Sizing: qty = floor(capital * risk_pct% / |entry - stop|).
"""
from __future__ import annotations

import math
import sqlite3
from pathlib import Path

import pandas as pd

from timing import exec_config

SCHEMA = """
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trade_date TEXT, symbol TEXT, side TEXT, grade TEXT,
  setup TEXT, score REAL, trigger TEXT, entry_ts TEXT, entry REAL, stop REAL, target REAL,
  qty INTEGER, risk_amt REAL, exit_ts TEXT, exit REAL, exit_reason TEXT, pnl REAL, r REAL,
  status TEXT DEFAULT 'open');
"""


class PaperLedger:
    def __init__(self, db_path: str | Path = ":memory:", cfg: dict | None = None):
        self.cfg = (cfg or exec_config())["paper"]
        self.db = sqlite3.connect(str(db_path))
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    # ------------------------------------------------------------ state
    def realized_pnl(self, day: str | None = None) -> float:
        q, a = "SELECT COALESCE(SUM(pnl),0) FROM trades WHERE status='closed'", ()
        if day:
            q, a = q + " AND trade_date=?", (day,)
        return float(self.db.execute(q, a).fetchone()[0])

    def capital(self) -> float:
        return self.cfg["capital"] + self.realized_pnl()

    def open_trades(self) -> list[sqlite3.Row]:
        return self.db.execute("SELECT * FROM trades WHERE status='open' ORDER BY id").fetchall()

    def stops_today(self, day: str) -> int:
        return int(self.db.execute(
            "SELECT COUNT(*) FROM trades WHERE trade_date=? AND exit_reason='stop'", (day,)).fetchone()[0])

    def kill_switch(self, day: str) -> tuple[bool, str]:
        """Active after max_sl_per_day stop-outs, or when the day's realised P&L <= -daily_loss_pct."""
        if self.stops_today(day) >= self.cfg["max_sl_per_day"]:
            return True, f"{self.cfg['max_sl_per_day']} stop-losses today"
        limit = -self.cfg["daily_loss_pct"] / 100.0 * self.cfg["capital"]
        if self.realized_pnl(day) <= limit:
            return True, f"daily loss limit {self.cfg['daily_loss_pct']}% reached"
        return False, ""

    def can_open(self, day: str, symbol: str) -> tuple[bool, str]:
        halted, why = self.kill_switch(day)
        if halted:
            return False, f"kill-switch: {why}"
        open_ = self.open_trades()
        if len(open_) >= self.cfg["max_positions"]:
            return False, f"max {self.cfg['max_positions']} positions open"
        if any(t["symbol"] == symbol for t in open_):
            return False, "already in this symbol"
        return True, ""

    # ------------------------------------------------------------ actions
    def size(self, entry: float, stop: float) -> tuple[int, float]:
        risk_pct = min(max(self.cfg["risk_pct"], 1.0), 2.0)  # clamp to the allowed 1-2%
        risk_amt = self.capital() * risk_pct / 100.0
        per_share = abs(entry - stop)
        qty = math.floor(risk_amt / per_share) if per_share > 0 else 0
        return qty, risk_amt

    def open_trade(self, day: str, sig: dict, ts, meta: dict | None = None) -> int | None:
        """sig needs symbol, side, entry, stop, target. Returns the trade id or None if refused."""
        ok, _ = self.can_open(day, sig["symbol"])
        if not ok:
            return None
        slip = self.cfg["slippage_pct"] / 100.0
        entry = sig["entry"] * (1 + slip if sig["side"] == "long" else 1 - slip)
        qty, risk_amt = self.size(entry, sig["stop"])
        if qty < 1:
            return None
        m = meta or {}
        cur = self.db.execute(
            "INSERT INTO trades (trade_date,symbol,side,grade,setup,score,trigger,entry_ts,entry,stop,"
            "target,qty,risk_amt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (day, sig["symbol"], sig["side"], m.get("grade"), m.get("setup"), m.get("score"),
             sig.get("trigger"), str(ts), entry, sig["stop"], sig["target"], qty, risk_amt))
        self.db.commit()
        return int(cur.lastrowid)

    def _close(self, t, ts, price: float, reason: str) -> None:
        sgn = 1 if t["side"] == "long" else -1
        slip = self.cfg["slippage_pct"] / 100.0
        price = price * (1 - slip if t["side"] == "long" else 1 + slip)
        pnl = sgn * (price - t["entry"]) * t["qty"]
        r = sgn * (price - t["entry"]) / abs(t["entry"] - t["stop"])
        self.db.execute("UPDATE trades SET status='closed', exit_ts=?, exit=?, exit_reason=?, pnl=?, r=? "
                        "WHERE id=?", (str(ts), price, reason, pnl, r, t["id"]))
        self.db.commit()

    def on_bar(self, symbol: str, ts, o: float, h: float, l: float, c: float) -> list[int]:
        """Apply one 15-min bar to the symbol's open trades. Stop is checked before target on the
        same bar; a bar that opens beyond a level fills at its open. Returns closed ids."""
        closed = []
        for t in [x for x in self.open_trades() if x["symbol"] == symbol]:
            if t["side"] == "long":
                if o <= t["stop"]:
                    self._close(t, ts, o, "stop")
                elif l <= t["stop"]:
                    self._close(t, ts, t["stop"], "stop")
                elif o >= t["target"]:
                    self._close(t, ts, o, "target")
                elif h >= t["target"]:
                    self._close(t, ts, t["target"], "target")
                else:
                    continue
            else:
                if o >= t["stop"]:
                    self._close(t, ts, o, "stop")
                elif h >= t["stop"]:
                    self._close(t, ts, t["stop"], "stop")
                elif o <= t["target"]:
                    self._close(t, ts, o, "target")
                elif l <= t["target"]:
                    self._close(t, ts, t["target"], "target")
                else:
                    continue
            closed.append(t["id"])
        return closed

    def square_off(self, ts, prices: dict[str, float]) -> list[int]:
        closed = []
        for t in self.open_trades():
            if t["symbol"] in prices:
                self._close(t, ts, prices[t["symbol"]], "square_off")
                closed.append(t["id"])
        return closed

    # ------------------------------------------------------------ reporting
    def trades_df(self) -> pd.DataFrame:
        return pd.read_sql_query("SELECT * FROM trades ORDER BY id", self.db)

    def export_csv(self, path: str | Path) -> Path:
        self.trades_df().to_csv(path, index=False)
        return Path(path)

    def summary(self, day: str | None = None) -> dict:
        df = self.trades_df()
        closed = df[df["status"] == "closed"]
        n = len(closed)
        wins = closed[closed["pnl"] > 0]
        gp, gl = wins["pnl"].sum(), -closed[closed["pnl"] < 0]["pnl"].sum()
        eq = self.cfg["capital"] + closed["pnl"].cumsum() if n else pd.Series(dtype=float)
        dd = float((eq.cummax() - eq).max()) if n else 0.0
        return {
            "capital_start": self.cfg["capital"], "equity": self.capital(),
            "total_pnl": float(closed["pnl"].sum()) if n else 0.0,
            "day_pnl": self.realized_pnl(day) if day else None,
            "closed_trades": n, "open_trades": int((df["status"] == "open").sum()),
            "win_pct": float(100 * len(wins) / n) if n else None,
            "avg_r": float(closed["r"].mean()) if n else None,
            "profit_factor": float(gp / gl) if gl > 0 else None,
            "max_drawdown": dd,
            "kill_switch": self.kill_switch(day)[0] if day else False,
        }
