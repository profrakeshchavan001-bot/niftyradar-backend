# Open questions from CC12 (Derivatives Desk)

Kept current behaviour for each; tell CC12 if you want it changed.

1. **Port.** Ported from pictotrade-backend branch `claude/stoic-dirac-qbjcia` (PR 559 there). The engine is converted to CommonJS to match this repo; the page is served at `/derivs-desk` (hash `#/derivs-desk/SYMBOL` picks the symbol) because this repo has no single-page app. The old Python `tools/india_edge` files are untouched.
2. **Reversal price.** Taken as the strike-interpolated point where CE premium at K equals PE premium at K-1 step. Confirm this matches your definition.
3. **Triple S/R.** A strike that is the single top strike on its side by OI, volume and OI change at once (shows "-" when none).
4. **Power, OI-to-OI, Big Bull/Bear.** No written definition was given, so: Power = weighted blend of OI, volume and OI change; OI-to-OI = top put OI against top call OI plus where spot sits between them; Big Bull/Bear = OI-change skew of 0.3 or more with put/call OI of 1.2 or more (or the mirror). Thresholds are in `tools/india_edge/chain/index.js` only.
5. **8 signals.** Chosen by CC12: put/call OI, put/call volume, fresh OI build, spot inside OI range, reversal vs spot, max pain vs spot, support moved, resistance moved.
6. **Wording.** "Big Bull / Big Bear" names are kept on the screeners but described as OI positioning only (CLAUDE.md rule 7: no buy/sell language). Rename if you prefer.
7. **Data.** The desk uses deterministic sample data labelled "sample". The real-data run and live loader are for CC8; it must return the same `{snap, prev, participants, prevParticipants}` shape (`src/routes/derivsDesk.js`)
9. **Site gate and rate limits.** pictotrade had a site password and rate limits in front of the route; niftyradar's route has neither, so `/api/derivs/desk` is open and unthrottled. Say if you want a limit..
8. **Navigation.** Page is reachable at `/derivs-desk`; no navigation entry added (this repo has no navigation).
