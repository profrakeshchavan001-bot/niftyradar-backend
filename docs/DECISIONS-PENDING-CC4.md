# DECISIONS-PENDING (CC4 sector context)

Kept in its own file, not in `docs/DECISIONS-PENDING.md`, because CC6 is editing the bot and its files at the same time and CC4 was told to touch only new files.

| # | Topic | What was found | Default taken | Needs from owner |
|---|---|---|---|---|
| 1 | Folder | The bot lives in `paperbot/`, there was no `src/`. | Built at `src/paper/context/sector.js` as asked, with a new `src/paper/context/index.js`. No existing file was changed. | Say if it should move under `paperbot/`. |
| 2 | Sector map | The map exists only as `SECTOR_MAP` inside `server.js`, which cannot be loaded as a module. | Copied the same 16 sectors and 75 stocks into `data/nse-sectors.json`. It is not the full F&O list. | Send the F&O list if every F&O stock should be covered. Two copies of the map now exist. |
| 3 | Yahoo not reachable from the build machine | The request to Yahoo was refused by the build machine's network (`CONNECT tunnel failed, response 403`). | The Yahoo adapter is tested with a fake network only. It has never fetched a real quote. | Run `node -e "require('./src/paper/context').sector.stockSectorView('TCS').then(console.log)"` on the PC or Render and send the output. |
| 4 | Yahoo tickers | Only the 7 tickers in the task are confirmed. `^CNXPSUBANK`, `^CNXREALTY`, `^CNXINFRA`, `^CNXMEDIA`, `^NSEI` are the usual ones but were not checked live. `^NSEBANK` (Bank Nifty) is used for Pvt Banks. | A ticker that fails gives `null` for that sector, never a made-up score. Power, Telecom, Insurance, NBFC, Consumer have no index ticker and use the average of their stocks. | Confirm or correct tickers after the live run in point 3. |
| 5 | VWAP | Yahoo gives no VWAP. | Breadth = % of stocks above yesterday's close. A `vwap` field is used when an adapter provides one. | None, unless a VWAP source is wanted. |
| 6 | Weights and cut-offs | Not given. | 30 / 30 / 20 / 20; STRONG from 65, WEAK up to 35 (see `docs/SECTOR-CONTEXT.md`). | OK or change. |
| 7 | Not wired into the bot | CC6 is editing the bot. | Module only. No trade rule uses it yet. | Say when CC6 is done; wiring is one line. |
| 8 | "Use Sonnet" | A session cannot switch its own model. | Done on the session's configured model. | Pick the model in the app before starting. |
| 9 | Yahoo terms | The chart endpoint is public but unofficial; Yahoo can block or change it. | Used only for the internal paper bot, 5-minute cache. | Decide before showing these numbers to users. |
