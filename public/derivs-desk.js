/* Derivatives Desk (#/derivs-desk): picture-first view of India option-chain positioning. Shows results from /api/derivs/desk only; no calculation happens here. */
(function () {
  'use strict';
  const CSS = '.dd{display:grid;gap:14px;min-width:0}.dd *{min-width:0;box-sizing:border-box}.dd h1{margin:0;font-size:22px;overflow-wrap:anywhere}.dd h2{margin:0 0 8px;font-size:15px;color:var(--muted);font-weight:600}'
    + '.dd-pills{display:flex;flex-wrap:wrap;gap:6px}.dd-pills button{padding:6px 10px;border-radius:999px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer;font-size:14px}.dd-pills button[aria-pressed=true]{background:var(--sel-fill);border-color:var(--sel-line);color:var(--sel-ink)}'
    + '.dd-card{border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:12px 14px}.dd-hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:center}'
    + '.dd-chips{display:grid;gap:6px}.dd-chip{display:flex;justify-content:space-between;gap:8px;font-size:14px}.dd-chip b{font-variant-numeric:tabular-nums}'
    + '.dd-svg{display:block;width:100%;height:auto}.dd-sig{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}.dd-s{display:flex;align-items:center;gap:8px;font-size:14px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--panel-2)}'
    + '.dd-dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--neutral)}.dd-dot.up{background:var(--up)}.dd-dot.down{background:var(--down)}'
    + '.dd-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}.dd-t{border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--panel-2);font-size:14px}.dd-t b{display:block;font-size:18px;font-variant-numeric:tabular-nums}.dd-t span{color:var(--muted)}'
    + '.dd-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.dd-list{margin:0;padding:0;list-style:none;display:grid;gap:4px;font-size:14px}.dd-list li{display:flex;justify-content:space-between;gap:8px}'
    + '.dd-note{font-size:14px;color:var(--muted);margin:0}@media(max-width:520px){.dd-hero{grid-template-columns:1fr}}';

  function gauge(score, esc, label) {
    const a = Math.PI * (1 - score / 100), cx = 100, cy = 100, r = 80;
    const x = cx + r * Math.cos(a), y = cy - r * Math.sin(a);
    const col = score >= 62 ? 'var(--up)' : score <= 38 ? 'var(--down)' : 'var(--neutral)';
    return `<svg viewBox="0 0 200 124" class="dd-svg" role="img" aria-label="${esc(label)}, score ${score} of 100">`
      + `<path d="M20 100 A80 80 0 0 1 180 100" fill="none" stroke="var(--panel-2)" stroke-width="16" stroke-linecap="round"/>`
      + `<path d="M20 100 A80 80 0 0 1 ${x.toFixed(1)} ${y.toFixed(1)}" fill="none" stroke="${col}" stroke-width="16" stroke-linecap="round"/>`
      + `<text x="100" y="92" text-anchor="middle" font-size="34" font-weight="700" fill="var(--text)">${Math.round(score)}</text>`
      + `<text x="100" y="116" text-anchor="middle" font-size="12" fill="var(--muted)">out of 100</text></svg>`;
  }

  function ladder(d, esc) {
    const rows = d.strikes, W = 360, rowH = 16, top = 18, H = top + rows.length * rowH + 4, mid = 180, half = 130, gut = 26;
    const max = Math.max(1, ...rows.map((r) => Math.max(r.ceOi, r.peOi)));
    const lvl = new Map();
    const tag = (k, t) => { if (k != null) lvl.set(k, (lvl.get(k) || '') + t); };
    tag(d.levels.oi.support[0] && d.levels.oi.support[0].strike, 'S'); tag(d.levels.oi.resistance[0] && d.levels.oi.resistance[0].strike, 'R');
    const bars = rows.map((r, i) => {
      const y = top + i * rowH, pw = (r.peOi / max) * half, cw = (r.ceOi / max) * half, t = lvl.get(r.strike) || '';
      return `<rect x="${(mid - gut - pw).toFixed(1)}" y="${y}" width="${pw.toFixed(1)}" height="${rowH - 3}" fill="var(--up)" opacity=".75"><title>${r.strike} put OI ${r.peOi}</title></rect>`
        + `<rect x="${mid + gut}" y="${y}" width="${cw.toFixed(1)}" height="${rowH - 3}" fill="var(--down)" opacity=".75"><title>${r.strike} call OI ${r.ceOi}</title></rect>`
        + `<text x="${mid}" y="${y + 9}" text-anchor="middle" font-size="12" fill="var(--text)">${r.strike}${t ? ' ' + t : ''}</text>`;
    }).join('');
    const near = rows.reduce((b, r, i) => (Math.abs(r.strike - d.spot) < Math.abs(rows[b].strike - d.spot) ? i : b), 0);
    const sy = top + near * rowH + (rowH - 3) / 2;
    return `<svg viewBox="0 0 ${W} ${H}" class="dd-svg" role="img" aria-label="Open interest by strike for ${esc(d.symbol)}. Puts left, calls right.">`
      + `<text x="${mid - gut - half}" y="11" font-size="12" fill="var(--up)">Put OI</text><text x="${mid + gut + half}" y="11" font-size="12" text-anchor="end" fill="var(--down)">Call OI</text>${bars}`
      + `<line x1="4" x2="${W - 4}" y1="${sy}" y2="${sy}" stroke="var(--text)" stroke-dasharray="3 3"/><text x="${W - 4}" y="${sy - 3}" font-size="12" text-anchor="end" fill="var(--text)">spot ${d.spot}</text></svg>`;
  }

  function pulseBar(who, p, esc) {
    if (!p) return `<li><span>${who}</span><span>no data</span></li>`;
    return `<div><div class="dd-chip"><span>${who} <span class="muted">${esc(p.stance)}</span></span><b>${p.longSharePct}% long</b></div>`
      + `<svg viewBox="0 0 100 8" class="dd-svg" role="img" aria-label="${who} long share ${p.longSharePct} percent"><rect width="100" height="8" rx="4" fill="var(--down)" opacity=".7"/><rect width="${p.longSharePct}" height="8" rx="4" fill="var(--up)"/></svg></div>`;
  }

  async function render(app, ctx) {
    const { api, esc, setBanner } = ctx;
    if (!document.getElementById('dd-css')) { const s = document.createElement('style'); s.id = 'dd-css'; s.textContent = CSS; document.head.appendChild(s); }
    const sym = ctx.symbol ? decodeURIComponent(ctx.symbol).toUpperCase() : '';
    let d;
    try { d = await api('/derivs/desk' + (sym ? '?symbol=' + encodeURIComponent(sym) : '')); } catch { if (setBanner) setBanner('Derivatives Desk could not load.'); app.innerHTML = '<section class="dd"><h1>Derivatives Desk</h1><p class="muted">Data could not be loaded. Try again shortly.</p></section>'; return; }
    const num = (n) => (n == null ? '-' : Number(n).toLocaleString('en-IN'));
    const L = d.levels.oi, sh = d.shifts;
    const arrow = (f) => (!f || f.flag === 'n/a' ? '-' : f.flag === 'up' ? `&#9650; ${esc(f.by)}` : f.flag === 'down' ? `&#9660; ${esc(Math.abs(f.by))}` : 'unchanged');
    const tile = (k, v, sub) => `<div class="dd-t"><span>${esc(k)}</span><b>${v}</b><span>${sub || ''}</span></div>`;
    const scr = (title, list) => `<div class="dd-card"><h2>${esc(title)}</h2>${list.length ? `<ul class="dd-list">${list.map((r) => `<li><a href="#/derivs-desk/${esc(r.symbol)}">${esc(r.symbol)}</a><span>put/call ${r.pcrOi} &middot; skew ${r.chgSkew}</span></li>`).join('')}</ul>` : '<p class="dd-note">None in the sample.</p>'}</div>`;
    app.innerHTML = `<section class="dd">
      <h1>Derivatives Desk <span class="muted" style="font-size:14px">${esc(d.symbol)} &middot; expiry ${esc(d.expiry)}</span></h1>
      <div class="dd-pills" role="group" aria-label="Symbol">${d.symbols.map((s) => `<button type="button" data-sym="${esc(s)}" aria-pressed="${s === d.symbol}">${esc(s)}</button>`).join('')}</div>
      <div class="dd-card dd-hero"><div>${gauge(d.overview.score, esc, d.overview.label)}</div>
        <div class="dd-chips"><b>${esc(d.overview.label)}</b>
          <div class="dd-chip"><span>Spot</span><b>${num(d.spot)}</b></div><div class="dd-chip"><span>Reversal price</span><b>${num(d.reversal)}</b></div>
          <div class="dd-chip"><span>Max pain</span><b>${num(d.maxPain)}</b></div><div class="dd-chip"><span>Put/call OI</span><b>${d.totals.pcrOi == null ? '-' : d.totals.pcrOi}</b></div>
          ${d.overview.partial ? '<span class="dd-note">Shift signals need a previous session.</span>' : ''}</div></div>
      <div class="dd-card"><h2>Open interest by strike (S = top put OI, R = top call OI)</h2>${ladder(d, esc)}</div>
      <div class="dd-card"><h2>Eight signals</h2><div class="dd-sig">${d.overview.signals.map((s) => `<div class="dd-s"><span class="dd-dot ${s.value > 0 ? 'up' : s.value < 0 ? 'down' : ''}"></span><span>${esc(s.label)}: <b>${esc(s.state)}</b></span></div>`).join('')}</div></div>
      <div class="dd-tiles">
        ${tile('Support (top put OI)', num(L.support[0] && L.support[0].strike), sh ? 'moved ' + arrow(sh.support) : '')}
        ${tile('Resistance (top call OI)', num(L.resistance[0] && L.resistance[0].strike), sh ? 'moved ' + arrow(sh.resistance) : '')}
        ${tile('Reversal price', num(d.reversal), sh ? 'moved ' + arrow(sh.reversal) : '')}
        ${tile('Triple support / resistance', `${num(d.triple.support)} / ${num(d.triple.resistance)}`, 'top on OI, volume and OI change')}
        ${tile('Power support / resistance', `${num(d.power.support && d.power.support.strike)} / ${num(d.power.resistance && d.power.resistance.strike)}`, d.power.support && d.power.support.strong ? 'strong support' : '')}
        ${tile('OI-to-OI', d.oiToOi ? `${d.oiToOi.ratio}x` : '-', d.oiToOi ? `spot ${Math.round(d.oiToOi.spotPosition * 100)}% of the way up the range` : '')}
      </div>
      <div class="dd-two"><div class="dd-card"><h2>FII and Pro, index futures</h2><div style="display:grid;gap:10px">${pulseBar('FII', d.pulse.fii, esc)}${pulseBar('Pro', d.pulse.pro, esc)}<p class="dd-note">Alignment: ${esc(d.pulse.alignment)}</p></div></div>
        <div style="display:grid;gap:14px">${scr('Big Bull build screener', d.screeners.bigBull)}${scr('Big Bear build screener', d.screeners.bigBear)}</div></div>
      <p class="dd-note">${esc(d.disclaimer)}</p></section>`;
    app.querySelectorAll('[data-sym]').forEach((b) => b.addEventListener('click', () => { location.hash = '#/derivs-desk/' + b.dataset.sym; }));
  }
  window.PictoDerivsDesk = { render };
})();
