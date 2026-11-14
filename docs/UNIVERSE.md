# Universe: which stocks the paper bot scans

Paper trading only. This page lists exactly what the bot looks at, how illiquid stocks are left out, and how the top 5 are picked.
The same lists are served at `GET /api/paper/universe?key=<PAPER_ADMIN_SECRET>` (a test checks that this page and that route agree).

## Which list is used when

| Situation | List | Where it lives |
|---|---|---|
| Dhan token works (live quotes) | List 1: 50 stocks | `NIFTY50_SYMBOLS` in `server.js`, the basket of the site's Movers page |
| Dhan token expired or Dhan down | List 2: 60 stocks | `data/nse-fno-top60.json`, read from Yahoo Finance as `SYMBOL.NS` (delayed) |

The bot switches by itself: it tries Dhan first and goes back to Dhan as soon as it answers again (tried every 15 minutes).
A symbol the data feed does not know is skipped and logged. Nothing is guessed.
OWNER: both lists are fixed lists written by hand. Please check them against the current Nifty 50 and F&O lists (index changes, company splits and renames are not picked up automatically).

## List 1: with Dhan live (50 stocks)

```
RELIANCE, TCS, HDFCBANK, ICICIBANK, INFY, ITC, SBIN, BHARTIARTL, LT, HINDUNILVR,
KOTAKBANK, AXISBANK, BAJFINANCE, ASIANPAINT, MARUTI, SUNPHARMA, TITAN, ULTRACEMCO, TATAMOTORS, WIPRO,
NESTLEIND, ONGC, NTPC, ADANIENT, ADANIPORTS, POWERGRID, M&M, HCLTECH, TATASTEEL, JSWSTEEL,
TECHM, GRASIM, DRREDDY, CIPLA, COALINDIA, BAJAJFINSV, BRITANNIA, EICHERMOT, HEROMOTOCO, DIVISLAB,
APOLLOHOSP, BPCL, HINDALCO, INDUSINDBK, SBILIFE, HDFCLIFE, TATACONSUM, BAJAJ-AUTO, UPL, SHRIRAMFIN
```

## List 2: on the free Yahoo feed (60 stocks)

List 1 plus 10 heavily traded F&O names (the last line).

```
RELIANCE, TCS, HDFCBANK, ICICIBANK, INFY, ITC, SBIN, BHARTIARTL, LT, HINDUNILVR,
KOTAKBANK, AXISBANK, BAJFINANCE, ASIANPAINT, MARUTI, SUNPHARMA, TITAN, ULTRACEMCO, TATAMOTORS, WIPRO,
NESTLEIND, ONGC, NTPC, ADANIENT, ADANIPORTS, POWERGRID, M&M, HCLTECH, TATASTEEL, JSWSTEEL,
TECHM, GRASIM, DRREDDY, CIPLA, COALINDIA, BAJAJFINSV, BRITANNIA, EICHERMOT, HEROMOTOCO, DIVISLAB,
APOLLOHOSP, BPCL, HINDALCO, INDUSINDBK, SBILIFE, HDFCLIFE, TATACONSUM, BAJAJ-AUTO, UPL, SHRIRAMFIN,
BANKBARODA, PNB, CANBK, BEL, HAL, TRENT, DLF, VEDL, TATAPOWER, IRCTC
```

## Crypto

BTCUSDT, ETHUSDT, SOLUSDT (Binance public candles). Setting: `paper_config`, key `crypto`, field `symbols`.

## Liquidity filter

A stock is ranked only if all of these hold:

- Traded value today (price x volume so far today) is at least Rs 1,00,00,000 (Rs 1 crore). Setting: `nse.min_turnover_inr`.
- It has at least 21 closed 5-minute candles and at least 15 closed 15-minute candles (needed for ATR).
- Its latest closed candle is at most 2 candles (10 minutes) old on a live feed. On the delayed Yahoo feed up to 15 more minutes are allowed (`nse.yahoo_max_delay_sec`, 900). Older data means the stock is left out.

Early in the day a stock can fail the Rs 1 crore test for the first few minutes; it joins the ranking once it has traded enough.

## How the top 5 are picked

1. Every 5 minutes, Mon-Fri 09:15 to 15:00 IST (no new entry after 15:00, no scan on a listed NSE holiday), every stock that passes the filter gets an R factor.
2. R factor = how far the price can run to the next level, divided by how far away the stop has to sit (full formula: `docs/R-FACTOR.md`). It is worked out for the long side and the short side; the better side counts.
3. Stocks are sorted by R factor, biggest first. Ties go to the stock with the bigger move today, then A to Z.
4. The first 5 (`nse.top_n`) are checked for candle patterns, trend, VWAP and news. Being in the top 5 is not a trade: a pattern must fire and the other rules must agree.

Crypto has no top-5 step: each of the three coins is checked, and it needs a momentum score of at least 1.
