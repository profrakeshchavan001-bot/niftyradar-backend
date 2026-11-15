# niftyradar-backend

## Keep-alive (Render free plan)

The Render free tier puts a web service to sleep after a period with no inbound HTTP traffic, which also stops
every `setInterval`/`cron` timer in the process - this is half of what caused the 14 Nov outage (the other half,
a stuck database connection with no `statement_timeout`, is fixed in `paperbot/index.js`'s `pgOptions()`).

Point a **free** [UptimeRobot](https://uptimerobot.com) HTTP(s) monitor at:

```
GET https://<your-render-url>/health
```

every 5 minutes. No key, no database read, no secrets - it is safe to ping from anywhere and always answers, even
while the paper bot is still starting. It returns the last tick time of every bot's scan/monitor job, so a
`PROBLEM` status there means a real job has gone quiet for 3+ minutes, not just that the service is reachable.

Do not use a paid monitoring service for this - UptimeRobot's free plan (50 monitors, 5-minute interval) is
already enough to keep this one service awake.