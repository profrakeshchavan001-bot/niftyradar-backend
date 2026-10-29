import io
import sys
import unittest
import zipfile
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from data.fetch import parse_cash, parse_fo_legacy, source_for, FO_LEGACY_URL, URLS  # noqa: E402


class FetchParseTests(unittest.TestCase):
    def test_legacy_fo_maps_to_udiff_schema(self):
        csv = ("INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,"
               "CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP,\n"
               "FUTSTK,TCS,31-Jan-2019,0,XX,1,1,1,1900,1900,500,10,1000,-50,02-JAN-2019,\n"
               "OPTSTK,TCS,31-Jan-2019,1900,CE,1,1,1,20,20,700,10,300,40,02-JAN-2019,\n"
               "FUTIDX,NIFTY,31-Jan-2019,0,XX,1,1,1,1,1,9,1,1,1,02-JAN-2019,\n")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("fo.csv", csv)
        df = parse_fo_legacy(buf.getvalue(), pd.Timestamp("2019-01-02"))
        self.assertEqual(list(df["instr"]), ["STF", "STO"])
        self.assertEqual(list(df["volume"]), [500, 700])
        self.assertEqual(list(df["chg_oi"]), [-50, 40])

    def test_cash_keeps_eq_only(self):
        csv = ("SYMBOL, SERIES, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, CLOSE_PRICE, "
               "TTL_TRD_QNTY, DELIV_QTY, DELIV_PER\n"
               "TCS, EQ, 100, 101, 103, 99, 102, 1000, 600, 60.0\n"
               "TCS, BE, 100, 101, 103, 99, 102, 1000, 600, 60.0\n"
               "XYZ, EQ, 10, 10, 10, 10, 10, 5, -, -\n")
        df = parse_cash(csv.encode(), pd.Timestamp("2026-10-28"))
        self.assertEqual(list(df["symbol"]), ["TCS", "XYZ"])
        self.assertEqual(df["deliv_pct"].iloc[0], 60.0)
        self.assertTrue(pd.isna(df["deliv_pct"].iloc[1]))

    def test_source_switches_at_udiff_start(self):
        self.assertEqual(source_for("fo", pd.Timestamp("2024-07-05"))[0], FO_LEGACY_URL)
        self.assertEqual(source_for("fo", pd.Timestamp("2024-07-08"))[0], URLS["fo"])
        self.assertEqual(source_for("cash", pd.Timestamp("2016-01-04"))[0], URLS["cash"])


if __name__ == "__main__":
    unittest.main()
