"""Look-ahead audit: everything computed for day t must be identical when data after t is removed or
wrecked. Covers scores, status, screeners, sector rotation and the fear/greed meter."""
import unittest

import pandas as pd

from scores import data, engine, feargreed, rotation, screeners
from loader import load_market

CFG = engine.load_cfg()
M = load_market()
SECT = data.load_sectors()


def panels(cash, idx, fo):
    return data.Panels(cash, idx, SECT, fo)


class Leak(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.P = panels(M.cash, M.idx, M.fo)
        cls.R = engine.compute(cls.P, CFG)
        cls.days = [cls.P.dates[-300], cls.P.dates[-120], cls.P.dates[-40]]

    def _cut(self, day):
        k = lambda df: df[pd.to_datetime(df["date"]) <= day]  # noqa: E731
        return panels(k(M.cash), k(M.idx), k(M.fo))

    def test_truncation_does_not_change_scores_status_or_meter(self):
        for day in self.days:
            P2 = self._cut(day)
            R2 = engine.compute(P2, CFG)
            for k in R2.scores:
                a, b = self.R.scores[k].loc[day].sort_index(), R2.scores[k].loc[day].sort_index()
                pd.testing.assert_series_equal(a, b, check_names=False, obj=f"{k}@{day:%F}")
            self.assertTrue((self.R.status.loc[day] == R2.status.loc[day]).all())
            m1 = feargreed.compute(self.P, self.R, CFG)["meter"].loc[day]
            m2 = feargreed.compute(P2, R2, CFG)["meter"].loc[day]
            self.assertEqual(m1, m2)
            b1 = rotation.board(self.P, self.R, day, CFG)
            b2 = rotation.board(P2, R2, day, CFG)
            self.assertEqual(b1, b2)
            s1 = screeners.run(self.P, self.R, day)
            s2 = screeners.run(P2, R2, day)
            self.assertEqual(s1, s2)

    def test_wrecking_the_future_does_not_change_day_t(self):
        day = self.days[1]
        cash, idx, fo = M.cash.copy(), M.idx.copy(), M.fo.copy()
        later = pd.to_datetime(cash["date"]) > day
        for c in ("close", "open", "high", "low", "volume", "deliv_pct"):
            cash.loc[later, c] = cash.loc[later, c] * 9
        idx.loc[pd.to_datetime(idx["date"]) > day, "close"] *= 0.1
        P2 = panels(cash, idx, fo)
        R2 = engine.compute(P2, CFG)
        for k in R2.scores:
            pd.testing.assert_series_equal(self.R.scores[k].loc[day].sort_index(), R2.scores[k].loc[day].sort_index(),
                                           check_names=False, obj=k)
        self.assertEqual(feargreed.compute(self.P, self.R, CFG)["meter"].loc[day],
                         feargreed.compute(P2, R2, CFG)["meter"].loc[day])
        self.assertEqual(rotation.board(self.P, self.R, day, CFG), rotation.board(P2, R2, day, CFG))

    def test_deterministic(self):
        R2 = engine.compute(self.P, CFG)
        pd.testing.assert_frame_equal(self.R.scores["overall"], R2.scores["overall"])


if __name__ == "__main__":
    unittest.main()


class BuilderCutTheFuture(unittest.TestCase):
    """End to end through the real loader path (point-in-time universe, hysteresis screeners, rotation, fear/greed):
    the JSON for day t built from data cut at t equals the JSON for day t built from the full history."""

    def test_build_outputs_identical_when_future_is_removed(self):
        from loader import Market
        from scores import build
        full = data.from_market(M)
        for k in (200, 60):
            day = full.dates[-k]
            cut = lambda df: df[pd.to_datetime(df["date"]) <= day]  # noqa: E731
            part = data.from_market(Market(cut(M.cash), cut(M.fo), cut(M.idx), pd.DataFrame(), pd.DataFrame(), "test"))
            a, _ = build.build(full, day=day)
            b, _ = build.build(part, day=day)
            for part_name in ("scores", "screeners", "rotation", "feargreed", "overview"):
                self.assertEqual(a[part_name], b[part_name], f"{part_name} at {day:%F}")

    def test_screener_lists_do_not_depend_on_where_history_starts(self):
        import copy
        from scores import screeners
        P = data.from_market(M)
        R = engine.compute(P, CFG)
        m, _, _ = screeners.masks(P, R)
        day = P.dates[-1]
        keep = list(range(len(P.dates) - 900, len(P.dates)))            # start 900 sessions later: >3 years of warm-up remain
        Q = copy.copy(P)
        for a in ("close", "open", "high", "low", "volume", "deliv"):
            setattr(Q, a, getattr(P, a).iloc[keep])
        Q.nifty, Q.dates, Q.member = P.nifty.iloc[keep], P.dates[keep], P.member.iloc[keep]
        mq, _, _ = screeners.masks(Q, engine.compute(Q, CFG))
        for k in m:
            self.assertTrue((m[k].loc[day] == mq[k].loc[day]).all(), k)    # hysteresis memory fades: same list on the last day
