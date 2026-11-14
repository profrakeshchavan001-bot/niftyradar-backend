# Yahoo chart fixtures

Answers of `https://query1.finance.yahoo.com/v8/finance/chart/<SYMBOL>.NS?interval=5m&range=5d` used by `test/paperYahoo.test.js`.

IMPORTANT: the build machine could not reach Yahoo (host blocked by its network rules), so these files are NOT a live recording.
They are hand-built in the shape of Yahoo's v8 chart answer (`chart.result[0].meta`, `timestamp`, `indicators.quote[0]`),
including the two things the adapter must cope with: a row with `null` prices and the extra "live" row at the last trade time.
The prices are made up for the test and are never used by the bot.

To replace them with a real recording, run this on any PC during NSE hours and commit the file:

    curl -A "niftyradar-paperbot/1.0" "https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?interval=5m&range=5d" -o chart-RELIANCE.NS-5m-5d.json

(the value checks in the test are tied to the hand-built numbers and need updating then).
