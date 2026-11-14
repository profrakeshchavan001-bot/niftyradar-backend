import unittest

import numpy as np
import pandas as pd

from helpers import mk
from scores import data, engine, universe, validate

CFG = engine.load_cfg()


def fo_rows(spans, dates, oi=1000.0, lot=None, skip_days=()):
    """spans: {symbol: (first_idx, last_idx or None)} -> STF rows on each day in range."""
    rows = []
    for s, (a, b) in spans.items():
        for i, d in enumerate(dates):
            if i >= a and (b is None or i <= b) and d not in skip_days:
                r = {"date": d, "instr": "STF", "symbol": s, "oi": oi, "volume": 10.0, "opt_type": "XX"}
                if lot:
                    r["lot"] = lot(s, i)
                rows.append(r)
    return pd.DataFrame(rows)


D = pd.bdate_range("2024-01-01", periods=30)


class Membership(unittest.TestCase):
    def test_enter_exit_dates(self):
        fo = fo_rows({"A": (0, None), "B": (10, None), "C": (0, 14)}, D)
        m = universe.membership(fo, D)
        self.assertTrue(m["A"].all())
        self.assertEqual(m["B"].tolist(), [False] * 10 + [True] * 20)       # joins on day 10, not before
        self.assertEqual(m["C"].tolist(), [True] * 15 + [False] * 15)       # leaves after day 14
        ch = universe.changes(m)
        self.assertEqual(ch[["symbol", "event"]].values.tolist(), [["B", "enter"], ["C", "exit"]])
        self.assertEqual(universe.members_on(m, D[12]), ["A", "B", "C"])
        self.assertEqual(universe.members_on(m, D[20]), ["A", "B"])
        self.assertEqual(universe.ever_members(m), ["A", "B", "C"])

    def test_zero_oi_and_volume_rows_do_not_count(self):
        fo = fo_rows({"A": (0, None)}, D)
        stub = fo_rows({"Z": (0, None)}, D, oi=0.0).assign(volume=0.0)
        m = universe.membership(pd.concat([fo, stub]), D)
        self.assertNotIn("Z", m.columns)

    def test_options_only_symbol_is_not_a_member(self):
        fo = pd.concat([fo_rows({"A": (0, None)}, D), fo_rows({"O": (0, None)}, D).assign(instr="STO")])
        self.assertNotIn("O", universe.membership(fo, D).columns)

    def test_missing_file_day_carries_membership_but_only_for_carry_days(self):
        gap = tuple(D[10:12])                                                # two days with no F&O file at all
        fo = fo_rows({"A": (0, None)}, D, skip_days=gap)
        m = universe.membership(fo, D, carry=3)
        self.assertTrue(m["A"].all())                                        # not "everyone left"
        gap5 = tuple(D[10:15])
        m2 = universe.membership(fo_rows({"A": (0, None)}, D, skip_days=gap5), D, carry=3)
        self.assertEqual(int(m2["A"].sum()), 30 - 2)                         # carry covers 3 of the 5 missing days

    def test_stock_that_leaves_while_others_remain_is_really_out(self):
        fo = fo_rows({"A": (0, None), "C": (0, 9)}, D)
        self.assertFalse(universe.membership(fo, D)["C"].iloc[12])

    def test_renames_merge_history(self):
        fo = pd.concat([fo_rows({"OLD": (0, 9)}, D), fo_rows({"NEW": (10, None)}, D)])
        m = universe.membership(fo, D, renames={"OLD": "NEW"})
        self.assertEqual(list(m.columns), ["NEW"])
        self.assertTrue(m["NEW"].all())                                      # no false exit/entry across the rename
        self.assertEqual(len(universe.changes(m)), 0)

    def test_suspect_renames_flagged_not_applied(self):
        fo = pd.concat([fo_rows({"OLD": (0, 9), "STAY": (0, None)}, D, oi=1000.0), fo_rows({"NEW": (11, None)}, D, oi=1100.0)])
        out = universe.suspect_renames(fo)
        self.assertEqual([(r["old"], r["new"]) for r in out], [("OLD", "NEW")])
        far = pd.concat([fo_rows({"OLD": (0, 9)}, D), fo_rows({"NEW": (11, None)}, D, oi=9000.0)])
        self.assertEqual(universe.suspect_renames(far), [])                  # OI does not match: not a rename

    def test_lot_changes(self):
        fo = fo_rows({"A": (0, None)}, D, lot=lambda s, i: 500 if i < 20 else 250)     # lot halves on day 20 (e.g. split)
        ch = universe.lot_changes(fo)
        self.assertEqual(ch[["symbol", "old", "new"]].values.tolist(), [["A", 500, 250]])
        self.assertEqual(ch["date"].iloc[0], D[20])
        self.assertTrue(universe.lot_changes(fo.drop(columns="lot")).empty)  # column missing: empty, no crash

    def test_cut_the_future(self):
        fo = fo_rows({"A": (0, None), "B": (10, None), "C": (0, 14)}, D)
        full = universe.membership(fo, D)
        for k in (8, 12, 20):
            cut_fo = fo[fo["date"] <= D[k]]
            part = universe.membership(cut_fo, D[: k + 1])
            pd.testing.assert_frame_equal(full.loc[D[: k + 1], part.columns], part, check_freq=False)

    def test_gap_carry_does_not_look_ahead(self):
        fo = fo_rows({"A": (0, None), "C": (0, 14)}, D, skip_days=(D[16],))
        full = universe.membership(fo, D)
        part = universe.membership(fo[fo["date"] <= D[16]], D[:17])
        self.assertEqual(full.loc[D[16], "A"], part.loc[D[16], "A"])


class EnginePlug(unittest.TestCase):
    def build_panels(self, n=300):
        d = pd.bdate_range(end="2026-10-28", periods=n)
        syms = ["OLD", "NEWJ", "STAY1", "STAY2", "STAY3"]
        closes = {s: np.linspace(100, 130, n) * (1 + 0.01 * i) for i, s in enumerate(syms)}
        P = mk(closes)
        spans = {"STAY1": (0, None), "STAY2": (0, None), "STAY3": (0, None), "OLD": (0, 199), "NEWJ": (150, None)}
        fo = fo_rows(spans, list(P.dates))
        P.member = universe.membership(fo, P.dates)[syms]
        return P

    def test_scored_only_while_member(self):
        P = self.build_panels()
        R = engine.compute(P, CFG)
        st = R.status
        self.assertEqual(st["OLD"].iloc[100], "ok")
        self.assertEqual(st["OLD"].iloc[250], "not_in_universe")
        self.assertEqual(st["NEWJ"].iloc[100], "not_in_universe")             # had 100 bars of cash history but was not in F&O yet
        self.assertEqual(st["NEWJ"].iloc[250], "ok")
        self.assertTrue(np.isnan(R.scores["overall"]["OLD"].iloc[250]))
        self.assertFalse(np.isnan(R.scores["overall"]["OLD"].iloc[100]))

    def test_cross_section_percentiles_use_only_members(self):
        P = self.build_panels()
        R = engine.compute(P, CFG)
        d = P.dates[250]
        # at day 250 only 4 stocks are members; percentile ranks of momentum are over members, so max is 100
        self.assertEqual(R.scores["momentum"].loc[d].max() <= 100, True)
        self.assertEqual(int(R.scores["overall"].loc[d].notna().sum()), 4)

    def test_from_market_restricts_to_ever_members_and_drops_never_members(self):
        from loader import Market
        d = pd.bdate_range(end="2026-10-28", periods=200)
        P0 = mk({"IN1": np.linspace(100, 120, 200), "IN2": np.linspace(100, 110, 200), "NEVER": np.linspace(100, 90, 200)})
        cash = pd.DataFrame({"date": np.repeat(P0.dates, 3), "symbol": ["IN1", "IN2", "NEVER"] * 200})
        cash = pd.concat([cash[["date", "symbol"]], pd.DataFrame({c: getattr(P0, c).to_numpy().ravel() for c in ("open", "high", "low", "close", "volume")}), pd.DataFrame({"deliv_pct": P0.deliv.to_numpy().ravel()})], axis=1)
        idx = pd.DataFrame({"date": P0.dates, "index_name": "Nifty 50", "close": 20000.0})
        fo = fo_rows({"IN1": (0, None), "IN2": (50, None)}, list(P0.dates))
        P = data.from_market(Market(cash, fo, idx), sectors={})
        self.assertEqual(sorted(P.symbols), ["IN1", "IN2"])
        self.assertFalse(P.member["IN2"].iloc[10])
        self.assertTrue(P.member["IN2"].iloc[60])


class CutTheFutureOnScores(unittest.TestCase):
    def test_scores_with_membership_do_not_change_when_future_is_cut(self):
        P = EnginePlug().build_panels(320)
        day = P.dates[-60]
        full = engine.compute(P, CFG).scores["overall"].loc[day]
        spans = {"STAY1": (0, None), "STAY2": (0, None), "STAY3": (0, None), "OLD": (0, 199), "NEWJ": (150, None)}
        cutP = mk({s: getattr(P, "close")[s].to_numpy()[: len(P.dates) - 59] for s in P.symbols})
        # same dates as the original up to `day`
        cutP = _truncate(P, day)
        part = engine.compute(cutP, CFG).scores["overall"].loc[day]
        pd.testing.assert_series_equal(full.sort_index(), part.sort_index(), check_names=False)


def _truncate(P, day):
    import copy
    Q = copy.copy(P)
    keep = P.dates <= day
    for a in ("close", "open", "high", "low", "volume", "deliv"):
        setattr(Q, a, getattr(P, a)[keep])
    Q.nifty, Q.member = P.nifty[keep], P.member[keep]
    Q.dates = P.dates[keep]
    return Q


class SurvivorshipInValidation(unittest.TestCase):
    def test_delisted_stock_exits_at_last_price_not_dropped(self):
        c = pd.DataFrame({"A": [100.0, 100, 100, 100, 50, np.nan, np.nan, np.nan, np.nan, np.nan, np.nan, np.nan],
                          "B": np.full(12, 100.0)})
        f = validate.forward(c, 3)
        # signal day 0: enter close day 1 (100), exit day 4 (50) -> -50 %
        self.assertAlmostEqual(f.at[0, "A"], -0.5)
        # signal day 4 (last trading day is 4): entry day 5 does not exist -> no position, NaN (cannot enter a halted stock)
        self.assertTrue(np.isnan(f.at[4, "A"]))
        # signal day 2: enter day 3 (100), exit day 6 -> delisted since day 5, last traded price 50 -> -50 %, NOT NaN
        self.assertAlmostEqual(f.at[2, "A"], -0.5)
        self.assertAlmostEqual(f.at[0, "B"], 0.0)


if __name__ == "__main__":
    unittest.main()


class Report(unittest.TestCase):
    def test_summary_counts_by_year(self):
        d = pd.bdate_range("2023-12-18", periods=30)
        fo = fo_rows({"A": (0, None), "B": (5, None), "C": (0, 14)}, d)
        r = universe.report(fo, d)
        self.assertEqual((r["members_first_day"], r["members_last_day"], r["ever_members"]), (2, 2, 3))
        self.assertEqual(r["by_year"]["2023"]["entries"], 1)          # B joins on day 5 (still 2023)
        self.assertEqual(r["by_year"]["2024"]["exits"], 1)            # C leaves after day 14 -> falls in 2024
        self.assertFalse(r["lot_size_column"])
