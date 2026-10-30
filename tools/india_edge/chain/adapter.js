// Turns F&O bhavcopy rows (UDiFF or legacy column names) into an engine snapshot.
// Column names are from memory of the public formats and are unverified against a real file.
const pick = (row, names) => {
  for (const n of names) if (row[n] !== undefined && row[n] !== '') return row[n];
  return undefined;
};
const num = (v) => Number(String(v ?? 0).replace(/,/g, '')) || 0;

export function fromBhavcopy(rows, { symbol, expiry, spot, date, ...extra }) {
  const byStrike = new Map();
  for (const row of rows) {
    if (String(pick(row, ['TckrSymb', 'SYMBOL'])).trim() !== symbol) continue;
    if (String(pick(row, ['XpryDt', 'EXPIRY_DT'])).trim() !== expiry) continue;
    const type = String(pick(row, ['OptnTp', 'OPTION_TYP']) ?? '').trim();
    if (type !== 'CE' && type !== 'PE') continue;
    const k = num(pick(row, ['StrkPric', 'STRIKE_PR']));
    const leg = {
      oi: num(pick(row, ['OpnIntrst', 'OPEN_INT'])),
      chg: num(pick(row, ['ChngInOpnIntrst', 'CHG_IN_OI'])),
      vol: num(pick(row, ['TtlTradgVol', 'CONTRACTS'])),
      ltp: num(pick(row, ['ClsPric', 'CLOSE'])),
    };
    const s = byStrike.get(k) ?? { k, ce: null, pe: null };
    s[type.toLowerCase()] = leg;
    byStrike.set(k, s);
  }
  const zero = { oi: 0, chg: 0, vol: 0, ltp: 0 };
  const strikes = [...byStrike.values()].map((s) => ({ k: s.k, ce: s.ce ?? zero, pe: s.pe ?? zero }));
  return { symbol, date, expiry, spot, strikes, ...extra };
}
