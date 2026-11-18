#!/usr/bin/env python3
"""Promoter / promoter-group open-market buying backtest.

Rule: a qualifying disclosure (promoter or promoter-group buy from the open market, value above
`threshold_value`) -> buy next trading day at open -> hold for `holding_days` trading sessions ->
sell at close. Compared against Nifty 500 over the identical dates. Equity delivery costs applied
both legs (buy_value, sell_value via options_promoter's own cost call -- reuses the published-rate
equity-delivery model, inlined here so this folder has no import from research/strategies/).

Data contract:
    disclosures: DataFrame ['symbol','disclosure_date','buyer_category' ('promoter'/'promoter_group'),
                             'transaction_type' ('buy'/'sell'), 'value_rupees','acquisition_mode'
                             ('open_market'/'other')]
    prices: DataFrame ['symbol','date','open','close']
    nifty500: DataFrame ['date','close']
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass


def _equity_delivery_cost(buy_value: float, sell_value: float, slippage_bps: float = 10.0) -> float:
    turnover = buy_value + sell_value
    stt = buy_value * 0.001 + sell_value * 0.001
    exchange_txn = turnover * 0.0000297
    stamp_duty = buy_value * 0.00015
    sebi_fee = turnover * 0.0000001
    gst = (exchange_txn + sebi_fee) * 0.18
    slippage = turnover * (slippage_bps / 10000.0)
    return round(stt + exchange_txn + stamp_duty + sebi_fee + gst + slippage, 2)


@dataclass
class PromoterTrade:
    symbol: str
    disclosure_date: dt.date
    entry_date: dt.date
    exit_date: dt.date
    holding_days: int
    entry_price: float
    exit_price: float
    shares: int
    gross_pnl: float
    cost: float
    net_pnl: float
    net_return_pct: float
    benchmark_return_pct: float
    excess_return_pct: float


def qualifying_disclosures(disclosures, threshold_value: float):
    return disclosures[
        (disclosures["buyer_category"].isin(["promoter", "promoter_group"]))
        & (disclosures["transaction_type"] == "buy")
        & (disclosures["acquisition_mode"] == "open_market")
        & (disclosures["value_rupees"] >= threshold_value)
    ]


def run_variant(disclosures, prices, nifty500, *, threshold_value: float, holding_days: int,
                capital_per_trade: float = 100000.0) -> list[PromoterTrade]:
    trades: list[PromoterTrade] = []
    qualified = qualifying_disclosures(disclosures, threshold_value)
    for _, row in qualified.iterrows():
        symbol = row["symbol"]
        stock_px = prices[prices["symbol"] == symbol].sort_values("date")
        later = stock_px[stock_px["date"] > row["disclosure_date"]]
        if later.empty:
            continue
        entry_row = later.iloc[0]
        entry_date, entry_price = entry_row["date"], float(entry_row["open"])
        if entry_price <= 0:
            continue
        after_entry = stock_px[stock_px["date"] > entry_date]
        if len(after_entry) < holding_days:
            continue
        exit_row = after_entry.iloc[holding_days - 1]
        exit_date, exit_price = exit_row["date"], float(exit_row["close"])

        shares = int(capital_per_trade // entry_price)
        if shares <= 0:
            continue
        buy_value = shares * entry_price
        sell_value = shares * exit_price
        gross_pnl = sell_value - buy_value
        cost = _equity_delivery_cost(buy_value, sell_value)
        net_pnl = round(gross_pnl - cost, 2)
        net_return_pct = round(100 * net_pnl / buy_value, 4)

        bench = nifty500[(nifty500["date"] >= entry_date) & (nifty500["date"] <= exit_date)].sort_values("date")
        if len(bench) < 2:
            continue
        bench_entry, bench_exit = float(bench.iloc[0]["close"]), float(bench.iloc[-1]["close"])
        benchmark_return_pct = round(100 * (bench_exit - bench_entry) / bench_entry, 4)

        trades.append(PromoterTrade(symbol, row["disclosure_date"], entry_date, exit_date,
                                     holding_days, entry_price, exit_price, shares,
                                     round(gross_pnl, 2), cost, net_pnl, net_return_pct,
                                     benchmark_return_pct, round(net_return_pct - benchmark_return_pct, 4)))
    return trades
