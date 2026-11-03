/* Panel del local — interfaz (vanilla JS, sin dependencias) */
'use strict';

/* ------------------------------------------------------------------ utils */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nf = (v, d = 0) => (v == null || Number.isNaN(v) ? '—' : v.toLocaleString('es-AR', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (v, d = 0) => (v == null ? '—' : (v < 0 ? '-$' : '$') + nf(Math.abs(v), d));
const pct = (v, d = 1) => (v == null ? '—' : nf(v, d) + '%');
const signedPct = (v, d = 1) => (v == null ? '—' : (v > 0 ? '+' : '') + nf(v, d) + '%');
const signedPts = (v, d = 1) => (v == null ? '—' : (v > 0 ? '+' : '') + nf(v, d) + ' pts');
const compact = (v) => {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return (v / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 }) + 'M';
  if (a >= 1e3) return Math.round(v / 1e3).toLocaleString('es-AR') + 'k';
  return nf(v, 0);
};
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MESES_L = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const dmy = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}`; };
const dmyFull = (iso) => { if (!iso) return '—'; const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const monthLabel = (key, long = false) => { const [y, m] = key.split('-'); return `${(long ? MESES_L : MESES)[+m - 1]} ${y}`; };
const icon = (name, cls = 'ic') => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

function toast(msg, type = '') {
  const host = $('#toast');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.textContent = msg;
  host.innerHTML = '';
  host.appendChild(t);
  host.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => host.classList.remove('show'), 3200);
}

async function copyText(text, okMsg = 'Copiado') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  toast(okMsg, 'ok');
}

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const j = await res.json().catch(() => ({ ok: false, error: `Respuesta inválida (${res.status})` }));
  if (!j.ok) throw new Error(j.error || 'Error de red');
  return j.data;
}

/* ------------------------------------------------------------------ estado */
const S = {
  route: 'panel',
  overview: null,
  weekKey: null,
  monthKey: null,
  week: null,
  month: null,
  suggest: null,
  entries: null,
  alerts: null,
  sort: 'ventas',
  sortDir: -1,
  alertFilter: 'todas',
  expFilters: { q: '', categoria: '', from: '', to: '', offset: 0, limit: 50 },
};

const ROUTES = [
  { id: 'panel', label: 'Panel', icon: 'panel' },
  { id: 'semanal', label: 'Semanal', icon: 'week' },
  { id: 'mensual', label: 'Mensual', icon: 'month' },
  { id: 'gastos', label: 'Gastos', icon: 'receipt' },
  { id: 'alertas', label: 'Alertas', icon: 'alert' },
  { id: 'datos', label: 'Datos', icon: 'data' },
  { id: 'enlaces', label: 'Enlaces', icon: 'link' },
];

function routeFromHash() {
  const m = location.hash.match(/^#\/([a-z]+)/);
  const r = m && ROUTES.find((x) => x.id === m[1]);
  return r ? r.id : 'panel';
}

function renderNav() {
  const counts = S.overview?.alert_counts || {};
  const crit = (counts.critico || 0) + (counts.atencion || 0);
  $('#nav').innerHTML = ROUTES.map(
    (r) => `<button class="nav-item ${S.route === r.id ? 'active' : ''}" data-act="nav" data-route="${r.id}">
      ${icon(r.icon)}<span class="nav-label">${r.label}</span>
      ${r.id === 'alertas' && crit ? `<span class="badge-dot">${crit}</span>` : ''}
    </button>`
  ).join('');
  if (S.overview?.config?.restaurant) {
    $('#brand-name').textContent = S.overview.config.restaurant;
    document.title = `${S.overview.config.restaurant} · Panel de gestión`;
  }
  const last = S.overview?.last_sync;
  const auto = S.overview?.config?.auto_sync_minutes;
  const st = $('#sync-status');
  if (st) {
    st.innerHTML = last
      ? `Última sync<br><strong>${dmyFull(last.slice(0, 10))} ${last.slice(11, 16)}</strong>${auto ? `<br><span style="color:#6fae9c">Se actualiza sola cada ${auto} min</span>` : ''}`
      : 'Sin sincronizar todavía';
  }
}

function loadingHTML(msg = 'Cargando datos…') {
  return `<div class="loading"><div class="spinner"></div><div>${esc(msg)}</div></div>`;
}

function errorHTML(e) {
  return `<div class="card"><div class="card-body">
    <div class="note danger">${icon('warning')}<div><b>No se pudieron cargar los datos.</b><br>${esc(e.message || e)}</div></div>
    <div class="form-foot"><button class="btn btn-primary" data-act="reload">Reintentar</button></div>
  </div></div>`;
}

const emptyHTML = (title, sub = '', act = '') =>
  `<div class="empty">${icon('list', 'ic-xl')}<div style="font-weight:600;color:var(--ink-2)">${esc(title)}</div>${sub ? `<div class="hint" style="margin-top:4px">${esc(sub)}</div>` : ''}${act}</div>`;

/* ------------------------------------------------------------------ delta chips */
function deltaChip(v, { inverse = false, suffix = '%', pts = false, neutralIfZero = true } = {}) {
  if (v == null || Number.isNaN(v)) return `<span class="muted" title="Sin dato comparable">n/d</span>`;
  const abs = Math.abs(v) < 0.05;
  const good = inverse ? v < 0 : v > 0;
  const cls = abs && neutralIfZero ? 'flat' : good ? 'up' : 'down';
  const arrow = abs ? '' : v > 0 ? '↑' : '↓';
  return `<span class="delta ${cls}">${arrow} ${nf(Math.abs(v), 1)}${suffix}${pts ? ' pts' : ''}</span>`;
}

/* ------------------------------------------------------------------ charts */
function drawWeeklyChart(host, series) {
  if (!host || !series?.length) return;
  const W = Math.max(host.clientWidth || 600, 300), H = 226;
  const P = { l: 44, r: 38, t: 12, b: 36 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const maxV = Math.max(...series.map((s) => s.ventas || 0), 1) * 1.08;
  const maxP = Math.max(...series.map((s) => s.cmv_pct || 0), 10) * 1.35;
  const step = iw / series.length;
  const bw = Math.min(30, step * 0.52);
  const y = (v) => P.t + ih - (v / maxV) * ih;
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = (maxV / 3) * i;
    const yy = y(v);
    g += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}" stroke="#eef1f5"/>`;
    g += `<text x="${P.l - 7}" y="${yy + 3}" text-anchor="end" class="axis">${compact(v)}</text>`;
  }
  let bars = '';
  let labels = '';
  series.forEach((s, i) => {
    const cx = P.l + step * i + step / 2;
    const x = P.l + step * i + (step - bw) / 2;
    const h = Math.max(0, P.t + ih - y(s.ventas || 0));
    const isCurrent = s.key === S.overview?.current_week?.key;
    bars += `<rect x="${x.toFixed(1)}" y="${y(s.ventas || 0).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3"
      fill="${isCurrent ? '#0b6b53' : '#a7ddcd'}" class="chart-bar"><title>${esc(monthLabel(s.month, true))} · ${esc(s.key.slice(-2))} · Ventas ${money(s.ventas)}${s.cmv_pct != null ? ` · CMV ${pct(s.cmv_pct)}` : ''}</title></rect>`;
    labels += `<text x="${cx.toFixed(1)}" y="${H - 18}" text-anchor="middle" class="chart-label">${s.key.slice(-1)}</text>`;
    const showMonth = i === 0 || series[i - 1].month !== s.month;
    if (showMonth)
      labels += `<text x="${cx.toFixed(1)}" y="${H - 4}" text-anchor="middle" class="axis">${esc(MESES[+s.month.slice(5) - 1])}</text>`;
  });
  const pts = series.filter((s) => s.cmv_pct != null);
  let line = '';
  if (pts.length) {
    const px = (s) => P.l + step * series.indexOf(s) + step / 2;
    const py = (s) => P.t + ih - (s.cmv_pct / maxP) * ih;
    line = `<path d="M${pts.map((s) => `${px(s).toFixed(1)},${py(s).toFixed(1)}`).join(' L')}" fill="none" stroke="#b54708" stroke-width="2" stroke-linejoin="round"/>`;
    line += pts.map((s) => `<circle cx="${px(s).toFixed(1)}" cy="${py(s).toFixed(1)}" r="3" fill="#fff" stroke="#b54708" stroke-width="2"><title>${esc(s.key)} · CMV ${pct(s.cmv_pct)}</title></circle>`).join('');
    for (let i = 0; i <= 2; i++) {
      const v = (maxP / 2) * i;
      line += `<text x="${W - P.r + 6}" y="${(P.t + ih - (v / maxP) * ih + 3).toFixed(1)}" class="axis">${Math.round(v)}%</text>`;
    }
  }
  host.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${g}${bars}${line}${labels}</svg>
    <div class="legend"><span><i style="background:#b54708"></i>CMV %</span>${series.some((s) => s.key === S.overview?.current_week?.key) ? '<span><i style="background:#0b6b53"></i>Semana en curso</span>' : ''}<span><i style="background:#a7ddcd"></i>Ventas top 5</span></div>`;
}

function drawMonthChart(host, series) {
  if (!host || !series?.length) return;
  const W = Math.max(host.clientWidth || 600, 300), H = 216;
  const P = { l: 46, r: 40, t: 12, b: 28 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const maxV = Math.max(...series.map((s) => Math.max(s.ventas || 0, s.gastos || 0)), 1) * 1.08;
  const step = iw / series.length;
  const bw = Math.min(26, step * 0.3);
  const y = (v) => P.t + ih - (v / maxV) * ih;
  let g = '';
  for (let i = 0; i <= 3; i++) {
    const v = (maxV / 3) * i, yy = y(v);
    g += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy}" y2="${yy}" stroke="#eef1f5"/><text x="${P.l - 7}" y="${yy + 3}" text-anchor="end" class="axis">${compact(v)}</text>`;
  }
  let bars = '', labels = '';
  series.forEach((s, i) => {
    const cx = P.l + step * i + step / 2;
    const isCurrent = s.mes === S.monthKey;
    const hv = s.ventas ? Math.max(0, P.t + ih - y(s.ventas)) : 0;
    const hg = s.gastos ? Math.max(0, P.t + ih - y(s.gastos)) : 0;
    const op = isCurrent ? 0.55 : 1;
    const tag = isCurrent ? ' (parcial)' : '';
    bars += `<rect x="${(cx - bw - 2).toFixed(1)}" y="${y(s.ventas || 0).toFixed(1)}" width="${bw}" height="${hv.toFixed(1)}" rx="3" fill="#0b6b53" opacity="${op}" class="chart-bar"><title>${esc(monthLabel(s.mes, true))} · Ventas ${money(s.ventas)}${tag}</title></rect>`;
    bars += `<rect x="${(cx + 2).toFixed(1)}" y="${y(s.gastos || 0).toFixed(1)}" width="${bw}" height="${hg.toFixed(1)}" rx="3" fill="#f3b27a" opacity="${op}" class="chart-bar"><title>${esc(monthLabel(s.mes, true))} · Gastos ${money(s.gastos)}${tag}</title></rect>`;
    labels += `<text x="${cx.toFixed(1)}" y="${H - 10}" text-anchor="middle" class="chart-label">${esc(MESES[+s.mes.slice(5) - 1])}</text>`;
  });
  host.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${g}${bars}${labels}</svg>
    <div class="legend"><span><i style="background:#0b6b53"></i>Ventas</span><span><i style="background:#f3b27a"></i>Gastos totales</span><span class="hint">${series.some((s) => s.mes === S.monthKey) ? 'El mes en curso va atenuado' : ''}</span></div>`;
}

function drawDailyChart(host, daily, week) {
  if (!host) return;
  const days = [];
  const start = new Date(week.start + 'T12:00:00');
  const end = new Date(week.end + 'T12:00:00');
  const map = new Map((daily || []).map((d) => [d.fecha, d]));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days.push({ iso, date: new Date(d), ...(map.get(iso) || { ventas: 0, cmv: 0, qty: 0 }) });
  }
  const W = Math.max(host.clientWidth || 500, 260), H = 130;
  const P = { l: 34, r: 8, t: 8, b: 22 };
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const maxV = Math.max(...days.map((d) => d.ventas || 0), 1) * 1.1;
  const step = iw / days.length;
  const bw = Math.min(40, step * 0.55);
  let bars = '', labels = '';
  days.forEach((d, i) => {
    const h = ((d.ventas || 0) / maxV) * ih;
    const x = P.l + step * i + (step - bw) / 2;
    bars += `<rect x="${x.toFixed(1)}" y="${(P.t + ih - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(h, d.ventas ? 2 : 0).toFixed(1)}" rx="3" fill="${d.ventas ? '#0b6b53' : '#e4e7ec'}" class="chart-bar"><title>${dmy(d.iso)} · ${d.ventas ? money(d.ventas) : 'sin ventas'}</title></rect>`;
    if (d.ventas) bars += `<text x="${(x + bw / 2).toFixed(1)}" y="${(P.t + ih - h - 5).toFixed(1)}" text-anchor="middle" class="chart-value">${compact(d.ventas)}</text>`;
    labels += `<text x="${(P.l + step * i + step / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="chart-label">${['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.date.getDay()]}</text>`;
  });
  host.innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${bars}${labels}</svg>`;
}

function hbars(items, { max, render }) {
  const top = Math.max(max || 1, ...items.map((i) => i.value));
  return items
    .map(
      (it) => `<div class="hbar-row">
      <div class="hbar-label" title="${esc(it.label)}">${esc(it.label)}</div>
      <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(2, (it.value / top) * 100).toFixed(1)}%;background:${it.color || '#0e8a6a'}"></div></div>
      <div class="hbar-val">${render ? render(it) : money(it.value)}</div>
    </div>`
    )
    .join('');
}

/* ------------------------------------------------------------------ componentes */
function kpi({ label, value, foot = '', cls = '', spark = '', hint = '' }) {
  return `<div class="kpi" ${hint ? `title="${esc(hint)}"` : ''}>
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value ${cls}">${value}</div>
    ${spark ? `<div class="kpi-spark">${spark}</div>` : ''}
    <div class="kpi-foot">${foot}</div>
  </div>`;
}

function alertCard(a, compactMode = false) {
  const items = a.items || [];
  const showMore = items.length >= 2;
  const level = a.nivel === 'critico' ? 'Crítico' : a.nivel === 'atencion' ? 'Atención' : 'Info';
  return `<div class="alert-card ${a.nivel}">
    <div class="alert-icon ${a.nivel}">${icon(a.nivel === 'critico' ? 'alert' : a.nivel === 'atencion' ? 'warning' : 'info')}</div>
    <div class="alert-main">
      <div class="alert-title">${esc(a.titulo)}</div>
      <div class="alert-detail">${esc(a.detalle)}</div>
      ${a.accion && !compactMode ? `<div class="alert-action">${icon('target')}<span>${esc(a.accion)}</span></div>` : ''}
      ${showMore ? `<details class="alert-more">
        <summary><span class="when-closed">Ver detalle</span><span class="when-open">Ocultar</span> <span class="alert-count">${items.length}</span></summary>
        <ul class="alert-list">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
        <div class="alert-list-foot"><button class="btn btn-ghost btn-sm" data-act="copy-alert">${icon('copy')} Copiar lista</button></div>
      </details>` : ''}
    </div>
    <div class="alert-meta"><span class="chip ${a.nivel} sm">${level}</span></div>
  </div>`;
}

function periodNav({ kind, items, current, labelFn }) {
  const idx = items.findIndex((i) => i.key === current);
  const prev = items[idx - 1], next = items[idx + 1];
  const opts = items
    .slice()
    .reverse()
    .map((i) => `<option value="${i.key}" ${i.key === current ? 'selected' : ''}>${esc(labelFn(i))}</option>`)
    .join('');
  return `<div class="period-nav">
    <button data-act="${kind}-prev" ${!prev ? 'disabled' : ''} title="Anterior">${icon('left')}</button>
    <select data-act="${kind}-select" aria-label="Elegir período">${opts}</select>
    <button data-act="${kind}-next" ${!next ? 'disabled' : ''} title="Siguiente">${icon('right')}</button>
  </div>`;
}

function statusChip(st) {
  if (st.status === 'en_curso') return `<span class="chip warn">En curso · día ${st.days_elapsed} de ${st.days_total}</span>`;
  if (st.status === 'futura') return `<span class="chip gray">Futura</span>`;
  return `<span class="chip ok">Cerrada</span>`;
}

function catTable(cats, { showPrevMonth = false, note = '', showDeltas = true } = {}) {
  const sorted = cats.slice().sort((a, b) => {
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1;
    return S.sort === 'ventas' ? (b.ventas || 0) - (a.ventas || 0) : S.sort === 'cmv' ? (b.cmv_pct || 0) - (a.cmv_pct || 0) : S.sort === 'delta' ? (b.delta_ventas_pct || -999) - (a.delta_ventas_pct || -999) : (b.part || 0) - (a.part || 0);
  });
  if (S.sortDir === 1) sorted.reverse();
  const head = `<tr>
    <th class="sortable" data-act="sort" data-sort="ventas">Categoría</th>
    <th class="r">Cant.</th>
    <th class="r sortable" data-act="sort" data-sort="ventas">Ventas</th>
    <th class="r sortable" data-act="sort" data-sort="cmv">CMV %</th>
    <th class="r">Ganancia</th>
    <th class="r sortable" data-act="sort" data-sort="part">Part. %</th>
    ${showDeltas ? `<th class="r sortable" data-act="sort" data-sort="delta">Δ ventas</th>
    ${showPrevMonth ? '<th class="r">Δ vs mes ant.</th>' : '<th class="r">Δ CMV</th>'}` : ''}
  </tr>`;
  const maxPart = Math.max(...cats.map((c) => c.part || 0), 1);
  const body = sorted
    .map((c) => {
      const barW = ((c.part || 0) / maxPart) * 100;
      return `<tr class="${c.virtual ? 'virtual-row' : ''}">
      <td class="cat-name">${esc(c.categoria)}${c.desaparecida ? ' <span class="chip sm gray">sin ventas</span>' : ''}</td>
      <td class="r num">${nf(c.qty || 0)}</td>
      <td class="r num">${money(c.ventas)}</td>
      <td class="r num">${c.cmv_pct == null ? '—' : pct(c.cmv_pct)}${c.target ? `<div class="obj ${c.cmv_pct > c.target[1] ? 'over' : ''}">obj. ${nf(c.target[0], 0)}–${nf(c.target[1], 0)}%</div>` : ''}</td>
      <td class="r num">${money(c.ganancia)}</td>
      <td class="r num"><div class="part-cell"><span class="part-bar" style="width:${barW.toFixed(1)}%"></span><span class="part-val">${c.part == null ? '—' : pct(c.part)}</span></div></td>
      ${showDeltas ? `<td class="r">${deltaChip(c.delta_ventas_pct)}</td>
      ${showPrevMonth ? `<td class="r">${deltaChip(c.delta_ventas_pm_pct)}</td>` : `<td class="r">${deltaChip(c.delta_cmv_pts, { inverse: true, suffix: '', pts: true })}</td>`}` : ''}
    </tr>`;
    })
    .join('');
  const totalV = cats.reduce((a, c) => a + (c.ventas || 0), 0);
  const totalC = cats.reduce((a, c) => a + (c.cmv || 0), 0);
  const totalQ = cats.reduce((a, c) => a + (c.qty || 0), 0);
  const totalPart = cats.reduce((a, c) => a + (c.part || 0), 0);
  return `<div class="table-wrap"><table class="tbl">
    <thead>${head}</thead>
    <tbody>${body || `<tr><td colspan="8">${emptyHTML('Sin categorías para este período')}</td></tr>`}</tbody>
    <tfoot><tr>
      <td>Total</td><td class="r num">${nf(totalQ)}</td><td class="r num">${money(totalV)}</td>
      <td class="r num">${totalV ? pct((totalC / totalV) * 100) : '—'}</td>
      <td class="r num">${money(totalV - totalC)}</td><td class="r num">${pct(Math.min(100, totalPart))}</td>${showDeltas ? '<td></td><td></td>' : ''}
    </tr></tfoot>
  </table></div>${note ? `<div class="hint" style="margin-top:8px">${esc(note)}</div>` : ''}`;
}

function prodTable(items, { metric = 'ventas', note = '' } = {}) {
  if (!items?.length) return emptyHTML('Sin datos');
  return `<div class="table-wrap"><table class="tbl tbl-compact">
    <thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">${metric === 'margen' ? 'Ganancia' : 'Ventas'}</th><th class="r">CMV %</th></tr></thead>
    <tbody>${items
      .map(
        (p) => `<tr><td><div class="prod-name">${esc(p.producto)}</div><div class="prod-cat">${esc(p.categoria || '')}</div></td>
        <td class="r num">${nf(p.qty || 0)}</td><td class="r num">${money(metric === 'margen' ? p.ganancia : p.ventas)}</td>
        <td class="r num">${p.cmv == 0 ? '<span class="chip sm atencion">sin costo</span>' : pct(p.cmv_pct)}</td></tr>`
      )
      .join('')}</tbody></table></div>${note ? `<div class="hint" style="margin-top:8px">${esc(note)}</div>` : ''}`;
}

function expenseBars(byCat, total) {
  if (!byCat?.length) return emptyHTML('Sin gastos en el período');
  const max = Math.max(...byCat.map((c) => c.monto), 1);
  return hbars(
    byCat.slice(0, 8).map((c) => ({ label: c.categoria, value: c.monto, color: c.categoria === 'Reposiciones' ? '#0e8a6a' : c.fijo ? '#94a3b8' : '#f3b27a' })),
    {
      max,
      render: (it) => `${money(it.value)}<span class="muted small"> · ${pct((it.value / (total || 1)) * 100)}</span>`,
    }
  );
}

/* ------------------------------------------------------------------ vistas */
function headerHTML({ title, sub, nav = '', actions = '' }) {
  return `<div class="page-head">
    <div><h1 class="page-title">${esc(title)}</h1><div class="page-sub">${sub}</div></div>
    <div class="head-actions">${nav}${actions}</div>
  </div>`;
}

function criticalBanner(alerts) {
  const crit = alerts?.find((a) => a.nivel === 'critico');
  if (!crit) return '';
  const total = alerts.filter((a) => a.nivel === 'critico').length;
  return `<div class="note danger" style="margin-bottom:14px">${icon('alert')}
    <div><b>${esc(crit.titulo)}</b><br>${esc(crit.detalle)} ${total > 1 ? `<a href="#/alertas">Ver ${total} alertas críticas</a>` : `<a href="#/alertas">Ver alerta</a>`}</div></div>`;
}

function weekSourceNote(week) {
  if (!week) return '';
  if (!week.sales.has_data) return `<span class="chip gray sm">Sin ventas cargadas</span>`;
  if (week.sales.source === 'historico')
    return `<span class="chip warn sm" title="Los datos vienen de Historico_Semanal, que guarda solo las 5 categorías principales">Histórico · top 5</span>`;
  return week.sales.origen === 'fudo'
    ? `<span class="chip ok sm" title="Ventas traídas directo de la API de Fudo">Fudo · API</span>`
    : `<span class="chip ok sm" title="Ventas leídas de la pestaña Import_Fudo_Detalle">Detalle Fudo · planilla</span>`;
}

/* ================================================================ PANEL */
function renderPanel() {
  const ov = S.overview, w = S.week;
  const wk = w.week;
  const sales = w.sales, cmp = w.comparison, exp = w.expenses;
  const margin = sales.ventas ? (sales.ganancia / sales.ventas) * 100 : null;
  const cash = sales.ventas - exp.total;
  const cashMargin = sales.ventas ? (cash / sales.ventas) * 100 : null;
  const cur = ov.current_week;
  const curData = ov.current || { ventas: 0, gastos: 0, has_sales: false, ventas_source: 'ventas' };

  const nav = periodNav({ kind: 'week', items: ov.weeks, current: S.weekKey, labelFn: (i) => `${i.label} · ${i.key.slice(0, 7)} · ${i.status === 'en_curso' ? 'en curso' : 'cerrada'}` });

  const kpis = `<div class="kpis">
    ${kpi({
      label: 'Ventas',
      value: money(sales.ventas),
      foot: `${deltaChip(cmp.delta_ventas_pct)} <span class="muted">vs ${esc(cmp.prev_label)}</span>`,
      hint: cmp.basis === 'top5' ? 'La comparación se hace sobre las 5 categorías principales para que sea equivalente entre semanas.' : '',
    })}
    ${kpi({
      label: 'CMV',
      value: sales.ventas ? pct(sales.cmv_pct) : '—',
      foot: `<span class="num">${money(sales.cmv)}</span> ${deltaChip(cmp.delta_cmv_pts, { inverse: true, suffix: '', pts: true })}`,
    })}
    ${kpi({ label: 'Ganancia bruta', value: money(sales.ganancia), foot: margin == null ? '' : `<span class="muted">margen ${pct(margin)}</span>` })}
    ${kpi({
      label: 'Compras y gastos',
      value: money(exp.total),
      foot: `<span class="muted">fijos ${money(exp.fijo)} · var. ${money(exp.variable)}</span>`,
      hint: 'Todo lo cargado en la pestaña Gastos durante la semana.',
    })}
    ${kpi({
      label: 'Resultado de caja',
      value: money(cash),
      cls: cash < 0 ? 'neg' : '',
      foot: cashMargin == null ? '' : `<span class="muted">${pct(cashMargin)} de las ventas</span>`,
      hint: 'Ventas menos compras y gastos. Es una foto de caja: las compras de mercadería incluyen stock.',
    })}
    ${kpi({
      label: 'Días con ventas',
      value: `${w.coverage.days_with_sales}/${w.coverage.days_expected || wk.days_total}`,
      foot: weekSourceNote(w),
      cls: 'sm',
    })}
  </div>`;

  const alertsCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Para revisar</h3><div class="card-sub">${(ov.alert_counts.critico || 0)} críticas · ${(ov.alert_counts.atencion || 0)} atenciones · ${(ov.alert_counts.info || 0)} avisos</div></div>
      <a class="btn btn-ghost btn-sm" href="#/alertas">Ver todas ${icon('right')}</a></div>
    <div class="card-body">${ov.alerts.slice(0, 4).map((a) => alertCard(a, true)).join('') || emptyHTML('Todo en orden', 'No hay alertas activas')}</div></div>`;

  const cats = w.categories.filter((c) => (c.ventas || 0) > 0);
  const partCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Participación por categoría</h3><div class="card-sub">${esc(wk.label)} · ${weekSourceNote(w)}</div></div></div>
    <div class="card-body">${cats.length ? hbars(
      cats.slice(0, 8).map((c) => ({ label: c.categoria, value: c.ventas, color: c.cmv_pct > 33 ? '#d97706' : '#0e8a6a' })),
      { max: sales.ventas, render: (it) => `${money(it.value)}<span class="muted small"> · ${pct((it.value / (sales.ventas || 1)) * 100)}</span>` }
    ) : emptyHTML('Sin ventas cargadas para esta semana', 'Importá el detalle de Fudo y volvé a sincronizar.')}</div></div>`;

  const series = ov.series_weekly || [];
  const chartCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Ventas por semana</h3><div class="card-sub">Últimas ${series.length} semanas · top 5 categorías del histórico</div></div></div>
    <div class="card-body">${series.length ? '<div class="chart-host" data-chart="weekly"></div>' : emptyHTML('Todavía no hay semanas cerradas', 'A medida que cierres semanas van a aparecer en este gráfico.')}</div></div>`;

  const expCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Gastos de la semana</h3><div class="card-sub">${money(exp.total)} · ${exp.count} movimientos · fijos ${money(exp.fijo)}</div></div>
    <a class="btn btn-ghost btn-sm" href="#/gastos">Cargar ${icon('plus')}</a></div>
    <div class="card-body">${expenseBars(exp.by_cat, exp.total)}
      <div class="mini-title">Principales proveedores</div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Proveedor</th><th class="r">Compras</th><th class="r">Monto</th></tr></thead><tbody>
      ${exp.top_suppliers.slice(0, 5).map((p) => `<tr><td>${esc(p.descripcion)}</td><td class="r num muted">${p.n}</td><td class="r num">${money(p.monto)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin compras cargadas</td></tr>'}
      </tbody></table></div>
    </div></div>`;

  const narrative = `<div class="card"><div class="card-head"><div><h3 class="card-title">Resumen listo para enviar</h3><div class="card-sub">Se genera solo con los datos de la semana. Podés editarlo antes de copiarlo.</div></div>
      <div class="card-tools"><button class="btn btn-sm" data-act="copy-narrative">${icon('copy')} Copiar</button></div></div>
    <div class="card-body"><textarea class="textarea-copy" id="narrative" style="min-height:170px">${esc(w.narrative)}</textarea></div></div>`;

  const curSales = ov.current_week;
  const curCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Semana en curso</h3><div class="card-sub">${esc(cur.label)} · ${esc(cur.key)}</div></div>${statusChip(cur)}</div>
    <div class="card-body">
      <div class="kv"><span>Ventas cargadas</span><b>${curData.has_sales ? money(curData.ventas) + (curData.ventas_source === 'historico' ? ' <span class="hint">(top 5)</span>' : '') : '<span class="chip atencion sm">sin cargar</span>'}</b></div>
      <div class="kv"><span>Gastos cargados</span><b>${money(curData.gastos)}</b></div>
      <div class="kv"><span>Movimientos de gasto</span><b>${nf(curData.gastos_count || 0)}</b></div>
      <div class="kv"><span>Días transcurridos</span><b>${cur.days_elapsed} de ${cur.days_total}</b></div>
      <div class="note brand" style="margin-top:12px">${icon('info')}<div>Para cerrar la semana, importá el detalle de ventas desde Fudo y cargá los gastos que falten.</div></div>
      <div class="form-foot"><a class="btn btn-sm" href="#/gastos">${icon('receipt')} Cargar gastos</a><a class="btn btn-sm" href="#/semanal">${icon('week')} Ver semanal</a></div>
    </div></div>`;

  return `${headerHTML({
    title: 'Panel',
    sub: `Semana ${esc(wk.label)} · ${wk.status === 'en_curso' ? 'en curso' : 'cerrada'} · base ${esc(wk.key)}`,
    nav,
    actions: `<button class="btn" data-act="sync">${icon('refresh')} Sincronizar</button>`,
  })}
  ${criticalBanner(ov.alerts)}
  ${kpis}
  <div class="split mt">${chartCard}${partCard}</div>
  <div class="split mt">${expCard}${curCard}</div>
  <div class="split mt">${narrative}${alertsCard}</div>`;
}

function mountPanel() {
  const host = $('[data-chart="weekly"]');
  if (host) drawWeeklyChart(host, S.overview?.series_weekly || []);
}

/* ================================================================ SEMANAL */
function renderSemanal() {
  const ov = S.overview, w = S.week, wk = w.week;
  if (!w.sales.has_data) {
    return `${headerHTML({ title: 'Semanal', sub: `Semana ${esc(wk.label)} · ${esc(wk.key)}`, nav: periodNav({ kind: 'week', items: ov.weeks, current: S.weekKey, labelFn: (i) => `${i.label} · ${i.key}` }) })}
      ${emptyHTML('No hay ventas cargadas para esta semana', 'Importá el detalle de Fudo en la pestaña Import_Fudo_Detalle y volvé a sincronizar.', `<div class="form-foot" style="justify-content:center"><button class="btn btn-primary" data-act="sync">${icon('refresh')} Sincronizar ahora</button></div>`)}
      <div class="card mt"><div class="card-body">
        <h3 class="card-title" style="margin-bottom:10px">Gastos cargados en la semana</h3>
        <div class="kpi-value sm">${money(w.expenses.total)}</div>
        <div class="hint">${w.expenses.count} movimientos · fijos ${money(w.expenses.fijo)} · variables ${money(w.expenses.variable)}</div>
      </div></div>`;
  }
  const s = w.sales, cmp = w.comparison, exp = w.expenses;
  const nav = periodNav({ kind: 'week', items: ov.weeks, current: S.weekKey, labelFn: (i) => `${i.label} · ${i.key} · ${i.status === 'en_curso' ? 'en curso' : 'cerrada'}` });
  const margin = s.ventas ? (s.ganancia / s.ventas) * 100 : null;

  const kpis = `<div class="kpis kpis-5">
    ${kpi({ label: 'Ventas', value: money(s.ventas), foot: `${deltaChip(cmp.delta_ventas_pct)} vs ${esc(cmp.prev_label)}` })}
    ${kpi({ label: 'CMV', value: pct(s.cmv_pct), foot: `<span class="num">${money(s.cmv)}</span> · ${deltaChip(cmp.delta_cmv_pts, { inverse: true, suffix: '', pts: true })}` })}
    ${kpi({ label: 'Ganancia bruta', value: money(s.ganancia), foot: margin == null ? '' : `margen ${pct(margin)}` })}
    ${kpi({ label: 'Compras y gastos', value: money(exp.total), foot: `${exp.count} movimientos` })}
    ${kpi({ label: 'Resultado de caja', value: money(s.ventas - exp.total), cls: s.ventas - exp.total < 0 ? 'neg' : '', foot: `<span class="hint">incluye compras de stock</span>` })}
  </div>`;

  const compare = `<div class="card"><div class="card-head"><div><h3 class="card-title">Comparaciones</h3><div class="card-sub">${cmp.basis === 'top5' ? 'Sobre las 5 categorías principales, para comparar peras con peras.' : 'Sobre el total de ventas.'}</div></div></div>
    <div class="card-body"><div class="compare-grid">
      <div><div class="hint">vs semana anterior (${esc(cmp.prev_label)})</div>
        <div class="big-delta ${cmp.delta_ventas_pct > 0 ? 'pos' : 'neg'}">${signedPct(cmp.delta_ventas_pct)}</div>
        <div class="hint">CMV ${deltaChip(cmp.delta_cmv_pts, { inverse: true, suffix: '', pts: true })}</div></div>
      <div><div class="hint">vs misma semana del mes anterior (${esc(cmp.same_month_label)})</div>
        <div class="big-delta ${cmp.same_month_delta_pct > 0 ? 'pos' : 'neg'}">${signedPct(cmp.same_month_delta_pct)}</div>
        <div class="hint">${cmp.basis === 'top5' ? 'top 5 categorías' : 'ventas totales'}</div></div>
      <div><div class="hint">Fuente de datos</div>
        <div style="margin-top:6px">${weekSourceNote(w)}</div>
        <div class="hint" style="margin-top:6px">${w.coverage.days_with_sales} de ${wk.days_total} días con ventas</div></div>
    </div></div></div>`;

  const daily = `<div class="card"><div class="card-head"><div><h3 class="card-title">Ventas por día</h3><div class="card-sub">${esc(wk.label)}</div></div></div>
    <div class="card-body"><div class="chart-host" data-chart="daily"></div>
    ${w.coverage.missing_days?.length ? `<div class="note warn" style="margin-top:10px">${icon('warning')}<div>Faltan ventas de: ${w.coverage.missing_days.map(dmy).join(', ')}</div></div>` : ''}</div></div>`;

  const catsCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Categorías</h3><div class="card-sub">Ordená haciendo clic en los encabezados</div></div>
    <div class="card-tools"><button class="btn btn-sm" data-act="export-week">${icon('download')} CSV</button></div></div>
    <div class="card-body" style="padding-top:12px">${catTable(w.categories)}</div></div>`;

  const prods = `<div class="grid g-3 mt">
    <div class="card"><div class="card-head"><div><h3 class="card-title">Más vendidos</h3><div class="card-sub">Por facturación</div></div></div><div class="card-body" style="padding-top:10px">${prodTable(w.products.top.slice(0, 7))}</div></div>
    <div class="card"><div class="card-head"><div><h3 class="card-title">Mayor ganancia</h3><div class="card-sub">Aporte en pesos</div></div></div><div class="card-body" style="padding-top:10px">${prodTable(w.products.best, { metric: 'margen' })}</div></div>
    <div class="card"><div class="card-head"><div><h3 class="card-title">CMV más alto</h3><div class="card-sub">Productos con ventas relevantes</div></div></div><div class="card-body" style="padding-top:10px">${prodTable(w.products.worst, { metric: 'cmv', note: 'Solo productos con más del 2% de la facturación semanal.' })}</div></div>
  </div>`;

  const uncosted = w.products.uncosted.length
    ? `<div class="card mt"><div class="card-head"><div><h3 class="card-title">Productos sin costear</h3><div class="card-sub">${w.products.uncosted.length} productos · ${money(w.products.uncosted_total)} de ventas sin CMV (${pct((w.products.uncosted_total / (s.ventas || 1)) * 100)})</div></div><span class="chip critico">Revisar</span></div>
      <div class="card-body" style="padding-top:10px"><div class="table-wrap"><table class="tbl"><thead><tr><th>Producto</th><th>Categoría</th><th class="r">Cant.</th><th class="r">Ventas</th></tr></thead><tbody>
      ${w.products.uncosted.slice(0, 12).map((p) => `<tr><td class="cat-name">${esc(p.producto)}</td><td class="muted small">${esc(p.categoria)}</td><td class="r num">${nf(p.qty)}</td><td class="r num">${money(p.ventas)}</td></tr>`).join('')}
      </tbody></table></div><div class="hint" style="margin-top:8px">Cargales el costo en Fudo para que el CMV y la ganancia de la categoría sean reales.</div></div></div>`
    : '';

  const expCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Gastos de la semana</h3><div class="card-sub">${money(exp.total)} ${exp.delta_pct != null ? `· ${deltaChip(exp.delta_pct)} vs semana anterior` : ''}</div></div>
    <a class="btn btn-ghost btn-sm" href="#/gastos">Cargar ${icon('plus')}</a></div>
    <div class="card-body">${expenseBars(exp.by_cat, exp.total)}</div></div>`;

  const supCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Principales proveedores</h3><div class="card-sub">Compras de la semana</div></div></div>
    <div class="card-body" style="padding-top:10px">${exp.top_suppliers.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Proveedor</th><th class="r">Compras</th><th class="r">Monto</th></tr></thead><tbody>
      ${exp.top_suppliers.slice(0, 8).map((p) => `<tr><td class="cat-name">${esc(p.descripcion)}</td><td class="r num">${p.n}</td><td class="r num">${money(p.monto)}</td></tr>`).join('')}
      </tbody></table></div>` : emptyHTML('Sin compras esta semana')}</div></div>`;

  const narrative = `<div class="card"><div class="card-head"><div><h3 class="card-title">Resumen semanal</h3><div class="card-sub">Editable · se copia al portapapeles tal como está</div></div>
    <div class="card-tools">
      <button class="btn btn-sm" data-act="copy-narrative">${icon('copy')} Copiar texto</button>
      <button class="btn btn-sm" data-act="copy-week-rows">${icon('list')} Filas para el histórico</button>
    </div></div>
    <div class="card-body"><textarea class="textarea-copy" id="narrative">${esc(w.narrative)}</textarea>
    <div class="hint" style="margin-top:8px">${icon('whatsapp', 'ic')} Podés pegarlo directo en WhatsApp o en la pestaña Semana_Actual.</div></div></div>`;

  return `${headerHTML({
    title: 'Semanal',
    sub: `Semana ${esc(wk.label)} · ${esc(wk.key)} · ${s.ventas ? money(s.ventas) : ''} · ${statusChip(wk)}`,
    nav,
    actions: `<button class="btn" data-act="copy-narrative">${icon('copy')} Copiar resumen</button><button class="btn" data-act="sync">${icon('refresh')} Sincronizar</button>`,
  })}
  ${criticalBanner(w.alerts)}
  ${kpis}
  <div class="split mt">${compare}${daily}</div>
  <div class="mt">${catsCard}</div>
  <div class="mt">${narrative}</div>
  ${prods}
  ${uncosted}
  <div class="split mt">${expCard}${supCard}</div>`;
}

function mountSemanal() {
  const d = $('[data-chart="daily"]');
  if (d) drawDailyChart(d, S.week?.daily, S.week?.week);
}

/* ================================================================ MENSUAL */
function renderMensual() {
  const ov = S.overview, m = S.month;
  if (!m) return loadingHTML();
  const mo = m.month, t = m.totals, exp = m.expenses;
  const nav = periodNav({ kind: 'month', items: ov.months, current: S.monthKey, labelFn: (i) => i.label });
  const prevClose = m.prev_close;
  const hasVirtual = m.categories.some((c) => c.virtual);

  const kpis = `<div class="kpis">
    ${kpi({ label: 'Ventas', value: money(t.ventas), foot: t.source === 'cierre' ? '<span class="chip ok sm">cierre cargado</span>' : `<span class="chip warn sm">${mo.partial ? 'parcial' : t.complete ? 'calculado' : 'calculado'}</span>` })}
    ${kpi({ label: 'CMV', value: pct(t.cmv_pct), foot: `<span class="num">${money(t.cmv)}</span>` })}
    ${kpi({ label: 'Resultado bruto', value: money(t.bruto), foot: `<span class="muted">ventas − CMV</span>` })}
    ${kpi({ label: 'Gastos totales', value: money(exp.total), foot: `<span class="muted">${exp.count} movimientos</span>` })}
    ${kpi({ label: mo.partial ? 'Resultado (parcial)' : 'Resultado final', value: money(t.ganancia_neta), cls: t.ganancia_neta < 0 ? 'neg' : '', foot: `<span class="muted">margen ${pct(t.margen_neto)}</span>`, hint: mo.partial ? 'Mes en curso: las ventas cargadas y los gastos no cubren el mismo período.' : '' })}
    ${kpi({ label: 'Gastos fijos', value: money(exp.fijo), foot: `<span class="muted">${pct((exp.fijo / (exp.total || 1)) * 100)} del total · var. ${money(exp.variable)}</span>`, cls: 'sm' })}
  </div>`;

  const compare = `<div class="card"><div class="card-head"><div><h3 class="card-title">Comparación con ${esc(monthLabel(prevMonthKey(mo.key), true))}</h3><div class="card-sub">${m.deltas ? 'Sobre cierres cargados' : prevClose ? 'El mes todavía no está cerrado' : 'Sin datos del mes anterior'}</div></div></div>
    <div class="card-body">
    ${m.deltas ? `<div class="compare-grid">
      <div><div class="hint">Ventas</div><div class="big-delta ${(m.deltas.ventas || 0) >= 0 ? 'pos' : 'neg'}">${signedPct(m.deltas.ventas)}</div></div>
      <div><div class="hint">Gastos</div><div class="big-delta ${(m.deltas.gastos || 0) <= 0 ? 'pos' : 'neg'}">${signedPct(m.deltas.gastos)}</div></div>
      <div><div class="hint">CMV</div><div class="big-delta ${(m.deltas.cmv_pts || 0) <= 0 ? 'pos' : 'neg'}">${signedPts(m.deltas.cmv_pts)}</div></div>
    </div>` : prevClose ? `<div class="hint" style="margin-bottom:6px">Así cerró ${esc(monthLabel(prevClose.mes, true))}:</div>
      <div class="kv"><span>Ventas</span><b>${money(prevClose.ventas)}</b></div>
      <div class="kv"><span>CMV</span><b>${pct(prevClose.cmv_pct)} · ${money(prevClose.cmv)}</b></div>
      <div class="kv"><span>Gastos</span><b>${money(prevClose.gastos)}</b></div>
      <div class="kv"><span>Resultado final</span><b class="${prevClose.resultado < 0 ? 'neg' : 'pos'}">${money(prevClose.resultado)}</b></div>` : `<div class="hint">No hay cierre del mes anterior para comparar.</div>`}
    ${mo.partial ? `<div class="note warn" style="margin-top:12px">${icon('warning')}<div>Mes en curso: las ventas cargadas cubren ${(t.weeks_available || []).length} semana(s) y los gastos llegan hasta el ${dmy(mo.today)}. Los totales y las comparaciones son parciales.</div></div>` : ''}
    </div></div>`;

  const chart = `<div class="card"><div class="card-head"><div><h3 class="card-title">Ventas y gastos por mes</h3><div class="card-sub">Últimos ${m.series.length} meses</div></div></div>
    <div class="card-body"><div class="chart-host" data-chart="monthly"></div></div></div>`;

  const cats = `<div class="card mt"><div class="card-head"><div><h3 class="card-title">Categorías del mes</h3><div class="card-sub">${m.categories.length} rubros · ${m.categories_source === 'historico' ? 'histórico semanal (top 5 por semana)' : 'detalle de ventas'}</div></div>
    <button class="btn btn-sm" data-act="export-month">${icon('download')} CSV</button></div>
    <div class="card-body" style="padding-top:12px">${catTable(m.categories, {
      showPrevMonth: true,
      showDeltas: !mo.partial,
      note: mo.partial
        ? 'Mes en curso: todavía no hay con qué comparar cada categoría contra el mes anterior.'
        : hasVirtual
        ? 'Las categorías del histórico semanal cubren el top 5 de cada semana; el resto se agrupa en la última fila.'
        : '',
    })}</div></div>`;

  const expCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Gastos por rubro</h3><div class="card-sub">${money(exp.total)} · ${exp.count} movimientos</div></div></div>
    <div class="card-body" style="padding-top:10px">
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Rubro</th><th class="r">Monto</th><th class="r">% del total</th><th class="r">vs mes ant.</th></tr></thead><tbody>
      ${exp.by_cat.map((c) => `<tr><td class="cat-name">${esc(c.categoria)} ${c.fijo ? '<span class="chip sm gray">fijo</span>' : ''}</td><td class="r num">${money(c.monto)}</td><td class="r num">${pct((c.monto / (exp.total || 1)) * 100)}</td><td class="r">${deltaChip(c.delta_pct)}</td></tr>`).join('') || '<tr><td colspan="4">Sin datos</td></tr>'}
      </tbody></table></div></div></div>`;

  const supCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Proveedores del mes</h3><div class="card-sub">Ranking por monto</div></div></div>
    <div class="card-body" style="padding-top:10px"><div class="table-wrap"><table class="tbl"><thead><tr><th>Proveedor</th><th class="r">Compras</th><th class="r">Monto</th></tr></thead><tbody>
    ${exp.top_suppliers.map((p) => `<tr><td class="cat-name">${esc(p.descripcion)}</td><td class="r num">${p.n}</td><td class="r num">${money(p.monto)}</td></tr>`).join('') || '<tr><td colspan="3">Sin datos</td></tr>'}
    </tbody></table></div></div></div>`;

  const close = m.close
    ? `<div class="card"><div class="card-head"><div><h3 class="card-title">Cierre cargado</h3><div class="card-sub">Pestaña Historico_Mensual</div></div><span class="chip ok">Cerrado</span></div>
      <div class="card-body"><div class="kv"><span>Ventas</span><b>${money(m.close.ventas)}</b></div>
      <div class="kv"><span>CMV</span><b>${money(m.close.cmv)} · ${pct(m.close.cmv_pct)}</b></div>
      <div class="kv"><span>Gastos</span><b>${money(m.close.gastos)}</b></div>
      <div class="kv"><span>Resultado final</span><b class="${m.close.resultado < 0 ? 'neg' : 'pos'}">${money(m.close.resultado)}</b></div>
      <div class="kv"><span>Gastos según planilla</span><b>${money(exp.total)}</b></div>
      ${Math.abs((m.close.gastos || 0) - exp.total) > (m.close.gastos || 1) * 0.01 ? `<div class="note warn" style="margin-top:10px">${icon('warning')}<div>El cierre (${money(m.close.gastos)}) no coincide con la planilla de Gastos (${money(exp.total)}). Conviene actualizarlo.</div></div>` : ''}
      </div></div>`
    : `<div class="card"><div class="card-head"><div><h3 class="card-title">Cierre del mes</h3><div class="card-sub">Todavía no hay cierre cargado</div></div></div>
      <div class="card-body">${emptyHTML('Sin cierre cargado', 'Cuando cierres el mes, cargá los totales en Historico_Mensual y van a aparecer acá.')}
      <div class="form-foot"><button class="btn btn-sm" data-act="copy-month-close">${icon('copy')} Copiar totales del mes</button></div></div></div>`;

  const narrative = `<div class="card"><div class="card-head"><div><h3 class="card-title">Resumen del mes</h3><div class="card-sub">Editable antes de copiar</div></div>
    <button class="btn btn-sm" data-act="copy-narrative">${icon('copy')} Copiar</button></div>
    <div class="card-body"><textarea class="textarea-copy" id="narrative">${esc(m.narrative)}</textarea></div></div>`;

  return `${headerHTML({
    title: 'Mensual',
    sub: `${esc(mo.label)} · ${mo.status === 'en_curso' ? 'mes en curso' : mo.status === 'futura' ? 'mes futuro' : 'mes cerrado'}`,
    nav,
    actions: `<button class="btn" data-act="sync">${icon('refresh')} Sincronizar</button>`,
  })}
  ${criticalBanner(m.alerts)}
  ${kpis}
  <div class="split mt">${chart}${compare}</div>
  ${cats}
  <div class="split mt">${expCard}${supCard}</div>
  <div class="split mt">${narrative}${close}</div>`;
}

function prevMonthKey(key) {
  const [y, mm] = key.split('-').map(Number);
  const d = new Date(y, mm - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function mountMensual() {
  const host = $('[data-chart="monthly"]');
  if (host) drawMonthChart(host, S.month?.series || []);
}

/* ================================================================ GASTOS */
function renderGastos() {
  const sug = S.suggest || { categorias: [], subcategorias: [], proveedores: [], recientes: [], semana: [] };
  const ent = S.entries || { pendientes: [], tsv: '' };
  const prefs = getEntryPrefs();
  const today = prefs.fecha || new Date().toISOString().slice(0, 10);
  const cats = sug.categorias.length ? sug.categorias.map((c) => c.categoria) : ['Reposiciones'];
  const catOptions = [...new Set(['Reposiciones', 'Sueldos', 'ProveedoresNoProductivos', 'Servicios Base', 'Impuestos', 'Alquiler', 'Extras', 'Mantenimiento', ...cats])];
  const selCat = prefs.categoria || 'Reposiciones';
  const selTipo = prefs.tipo || 'Variable';
  const recent = ent.pendientes;
  const lastWeek = sug.semana || [];
  const quick = (sug.recientes || []).slice(0, 10);

  const form = `<div class="card"><div class="card-head"><div><h3 class="card-title">Cargar un gasto</h3><div class="card-sub">Con <kbd>Enter</kbd> guardás y seguís cargando. El campo de monto acepta puntos y comas.</div></div>
    <span class="chip brand">${esc((S.overview?.pending_entries || 0))} pendientes de enviar</span></div>
    <div class="card-body">
      <form id="entry-form" class="form-grid" autocomplete="off">
        <div class="field span-2"><label for="f-fecha">Fecha</label><input id="f-fecha" name="fecha" type="date" value="${today}" required></div>
        <div class="field span-2"><label for="f-tipo">Tipo</label><select id="f-tipo" name="tipo"><option ${selTipo === 'Variable' ? 'selected' : ''}>Variable</option><option ${selTipo === 'Fijo' ? 'selected' : ''}>Fijo</option></select></div>
        <div class="field span-4"><label for="f-cat">Categoría</label><select id="f-cat" name="categoria">${catOptions.map((c) => `<option ${c === selCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        <div class="field span-4"><label for="f-sub">Subcategoría</label><input id="f-sub" name="subcategoria" list="dl-sub" placeholder="Proveedor, SueldoCocina…"></div>
        <div class="field span-5"><label for="f-desc">Proveedor / descripción</label><input id="f-desc" name="descripcion" list="dl-prov" required placeholder="Promarco, MDQ Huevos, EDEA…" autofocus>
          <div class="hint" id="prov-hint">&nbsp;</div></div>
        <div class="field span-4"><label for="f-monto">Monto</label><input id="f-monto" name="monto" class="amount-input" inputmode="decimal" placeholder="$ 0" required></div>
        <div class="field span-3" style="justify-content:flex-end"><button class="btn btn-primary" type="submit" style="height:40px">${icon('plus')} Guardar gasto</button></div>
        <datalist id="dl-prov">${sug.proveedores.map((p) => `<option value="${esc(p.descripcion)}">`).join('')}</datalist>
        <datalist id="dl-sub">${[...new Set(sug.subcategorias.map((s) => s.subcategoria))].map((s) => `<option value="${esc(s)}">`).join('')}</datalist>
      </form>
      ${quick.length ? `<div class="quick-wrap"><div class="hint">Últimos proveedores:</div><div class="quick-providers">${quick.map((p) => `<button type="button" class="qp" data-act="quick-prov" data-name="${esc(p.descripcion)}" data-monto="${p.monto}" data-cat="${esc(p.categoria || '')}" data-sub="${esc(p.subcategoria || '')}" title="Última compra ${dmyFull(p.fecha)}"><b>${esc(p.descripcion)}</b><span>${money(p.monto)}</span></button>`).join('')}</div></div>` : ''}
    </div></div>`;

  const repCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Repetir compras de la semana</h3><div class="card-sub">Proveedores con movimientos en los últimos 7 días</div></div></div>
    <div class="card-body" style="padding-top:10px">${lastWeek.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Proveedor</th><th class="r">Monto</th><th class="r"></th></tr></thead><tbody>
      ${lastWeek.slice(0, 12).map((p) => `<tr><td class="cat-name">${esc(p.descripcion)}<div class="hint">${dmyFull(p.fecha)} · ${p.n} movimiento(s)</div></td><td class="r num">${money(p.monto)}</td>
      <td class="r"><button class="btn btn-sm" data-act="quick-add" data-name="${esc(p.descripcion)}" data-monto="${p.monto}" data-cat="${esc(p.categoria || '')}" data-sub="${esc(p.subcategoria || '')}" data-tipo="${esc(p.tipo || '')}">${icon('plus')} Agregar</button></td></tr>`).join('')}
      </tbody></table></div>` : emptyHTML('Sin movimientos recientes', 'Cuando cargues compras van a aparecer acá para repetirlas.')}
      <div class="hint" style="margin-top:8px">Se agregan con la fecha de hoy. Después podés revisarlas en la lista de pendientes.</div>
    </div></div>`;

  const pendingCard = `<div class="card"><div class="card-head"><div><h3 class="card-title">Pendientes de enviar</h3><div class="card-sub">${ent.pendientes.length} gasto(s) cargados en la app</div></div>
    <div class="card-tools">
      ${ent.pendientes.length && S.overview?.config?.webhook ? `<button class="btn btn-sm btn-primary" data-act="push-entries">${icon('send')} Enviar al Sheet</button>` : ''}
      ${ent.pendientes.length ? `<button class="btn btn-sm" data-act="copy-paste">${icon('copy')} Copiar para pegar</button>` : ''}
    </div></div>
    <div class="card-body" style="padding-top:10px">
      ${ent.pendientes.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Proveedor</th><th>Categoría</th><th class="r">Monto</th><th class="r"></th></tr></thead><tbody>
        ${ent.pendientes.map((e) => `<tr><td class="num">${dmyFull(e.fecha)}</td><td class="cat-name">${esc(e.descripcion)}</td><td class="muted small">${esc(e.categoria)}${e.subcategoria ? ' · ' + esc(e.subcategoria) : ''}</td><td class="r num">${money(e.monto)}</td>
        <td class="r"><button class="btn btn-ghost btn-sm" data-act="del-entry" data-id="${e.id}" title="Descartar">${icon('trash')}</button></td></tr>`).join('')}
      </tbody></table></div>` : emptyHTML('No hay cargas pendientes', 'Todo lo que cargues acá aparece en esta lista hasta que llegue a la planilla.')}
      ${ent.pendientes.length ? `<div class="note info" style="margin-top:10px">${icon('info')}<div>Si todavía no conectaste el envío automático, copiá el bloque y pegalo al final de la pestaña <b>Gastos</b> en una sola operación.</div></div>` : ''}
    </div></div>`;

  const bulk = `<div class="card"><div class="card-head"><div><h3 class="card-title">Carga rápida en lote</h3><div class="card-sub">Pegá varias compras: una por línea, con el monto al final o separado por tabulación</div></div></div>
    <div class="card-body"><textarea class="textarea-copy" id="bulk" style="min-height:110px" placeholder="Promarco 25.000&#10;MDQ Huevos 26.500&#10;Coca Cola	131.000"></textarea>
    <div class="form-foot"><button class="btn btn-sm" data-act="bulk-preview">${icon('list')} Revisar</button><span class="hint" id="bulk-info"></span></div>
    <div id="bulk-preview"></div></div></div>`;

  return `${headerHTML({
    title: 'Carga de gastos',
    sub: 'Lo que cargues queda pendiente hasta llegar a la planilla. Enter guarda y deja el formulario listo para el siguiente.',
    actions: `<a class="btn" href="#/datos">${icon('list')} Ver todos</a><button class="btn" data-act="sync">${icon('refresh')} Sincronizar</button>`,
  })}
  ${form}
  <div class="split mt">${repCard}${pendingCard}</div>
  <div class="mt">${bulk}</div>
  <div class="mt">${recentTable()}</div>`;
}

function recentTable() {
  const d = S.expensesRecent || { rows: [], total: 0 };
  return `<div class="card"><div class="card-head"><div><h3 class="card-title">Últimos movimientos de la planilla</h3><div class="card-sub">${d.total} gastos · ${money(d.sum)}</div></div>
    <div class="card-tools"><input class="field-inline" id="quick-search" placeholder="Buscar proveedor…" value="${esc(S.expFilters.q)}" style="height:32px;border:1px solid var(--line);border-radius:8px;padding:0 10px;width:190px">
    <button class="btn btn-sm" data-act="search-exp">${icon('search')}</button></div></div>
    <div class="card-body" style="padding-top:10px">${d.rows.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Fecha</th><th>Proveedor</th><th>Categoría</th><th class="r">Monto</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td class="num">${dmyFull(r.fecha)}</td><td class="cat-name">${esc(r.descripcion)}</td><td class="muted small">${esc(r.categoria)}</td><td class="r num">${money(r.monto)}</td></tr>`).join('')}
      </tbody></table></div>` : emptyHTML('Sin resultados')}</div></div>`;
}

function mountGastos() {
  const form = $('#entry-form');
  if (!form) return;
  const desc = $('#f-desc');
  desc?.addEventListener('input', () => updateProvHint());
  desc?.addEventListener('change', () => {
    const p = findProv(desc.value);
    if (p) {
      const cat = $('#f-cat'), sub = $('#f-sub'), tipo = $('#f-tipo');
      if (cat && p.categoria) cat.value = p.categoria;
      if (sub && p.subcategoria) sub.value = p.subcategoria;
      if (tipo && p.tipo) tipo.value = p.tipo;
      updateProvHint();
    }
  });
  $('#f-monto')?.addEventListener('blur', (e) => {
    const v = parseAmount(e.target.value);
    if (v != null) e.target.value = v.toLocaleString('es-AR');
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    await saveEntry();
  });
  updateProvHint();
}

function findProv(name) {
  const q = (name || '').trim().toLowerCase();
  if (!q) return null;
  return (S.suggest?.proveedores || []).find((p) => p.descripcion.toLowerCase() === q) ||
    (S.suggest?.proveedores || []).find((p) => p.descripcion.toLowerCase().startsWith(q));
}

function updateProvHint() {
  const hint = $('#prov-hint');
  if (!hint) return;
  const p = findProv($('#f-desc')?.value);
  if (!p) { hint.innerHTML = '&nbsp;'; return; }
  hint.innerHTML = `Última compra: <b>${money(p.ultimo_monto)}</b> el ${dmyFull(p.ultima_fecha)} · ${esc(p.categoria || '')}${p.subcategoria ? ' / ' + esc(p.subcategoria) : ''} · ${p.n} registros`;
}

function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;
  const neg = s.startsWith('-');
  s = s.replace('-', '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/\./g, '');
  const v = parseFloat(s);
  return Number.isFinite(v) ? (neg ? -v : v) : null;
}

function getEntryPrefs() {
  try { return JSON.parse(localStorage.getItem('entryPrefs') || '{}'); } catch { return {}; }
}

function setEntryPrefs(p) {
  try { localStorage.setItem('entryPrefs', JSON.stringify({ ...getEntryPrefs(), ...p })); } catch {}
}

async function saveEntry() {
  const f = $('#entry-form');
  const data = Object.fromEntries(new FormData(f).entries());
  const monto = parseAmount(data.monto);
  if (!data.descripcion?.trim()) return toast('Falta el proveedor o la descripción', 'err');
  if (monto == null || monto <= 0) return toast('Falta el monto', 'err');
  try {
    const res = await api('/api/entries', { method: 'POST', body: JSON.stringify({ ...data, monto }) });
    setEntryPrefs({ fecha: data.fecha, categoria: data.categoria, tipo: data.tipo });
    toast(`Guardado: ${data.descripcion} ${money(monto)}`, 'ok');
    await refreshGastos(true);
    const d = $('#f-desc');
    if (d) { d.value = ''; d.focus(); }
    const sub = $('#f-sub');
    if (sub) sub.value = '';
    const m = $('#f-monto');
    if (m) m.value = '';
    updateProvHint();
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function refreshGastos(focus = false) {
  const [sug, ent, recent, ov] = await Promise.all([
    api('/api/suggest'),
    api('/api/entries'),
    api(`/api/expenses?limit=25&q=${encodeURIComponent(S.expFilters.q || '')}`),
    api('/api/overview'),
  ]);
  S.suggest = sug;
  S.entries = ent;
  S.expensesRecent = recent;
  S.overview = ov;
  renderNav();
  $('#view').innerHTML = renderGastos();
  mountGastos();
  if (focus) {
    const d = $('#f-desc');
    if (d) d.focus();
  }
}

/* ================================================================ ALERTAS */
function renderAlertas() {
  const alerts = S.alerts || [];
  const counts = { todas: alerts.length, critico: alerts.filter((a) => a.nivel === 'critico').length, atencion: alerts.filter((a) => a.nivel === 'atencion').length, info: alerts.filter((a) => a.nivel === 'info').length };
  const filtered = S.alertFilter === 'todas' ? alerts : alerts.filter((a) => a.nivel === S.alertFilter);
  const groups = [
    { id: 'critico', title: 'Críticas', sub: 'Resolver antes de cerrar la semana' },
    { id: 'atencion', title: 'Atención', sub: 'Vale la pena revisar' },
    { id: 'info', title: 'Información', sub: 'Datos para tener en cuenta' },
  ].filter((g) => filtered.some((a) => a.nivel === g.id));
  return `${headerHTML({ title: 'Alertas', sub: `${counts.todas} activas · ${counts.critico} críticas · ${counts.atencion} atenciones`, actions: `<button class="btn" data-act="sync">${icon('refresh')} Sincronizar</button>` })}
    <div class="pill-row" style="margin-bottom:14px">
      ${['todas', 'critico', 'atencion', 'info'].map((f) => `<button class="btn btn-sm ${S.alertFilter === f ? 'btn-primary' : ''}" data-act="alert-filter" data-filter="${f}">${f === 'todas' ? 'Todas' : f === 'critico' ? 'Críticas' : f === 'atencion' ? 'Atención' : 'Info'} <span class="chip sm ${S.alertFilter === f ? '' : 'gray'}">${counts[f] || 0}</span></button>`).join('')}
    </div>
    ${groups.map((g) => `<div class="mt"><div class="section-title">${g.title} <span class="hint">· ${g.sub}</span></div>${filtered.filter((a) => a.nivel === g.id).map((a) => alertCard(a)).join('')}</div>`).join('') || emptyHTML('Sin alertas en este filtro', 'Buen momento para revisar la planilla igual.')}`;
}

/* ================================================================ DATOS */
function renderDatos() {
  const d = S.expensesData || { rows: [], total: 0, sum: 0, categorias: [] };
  const issues = S.quality || [];
  const f = S.expFilters;
  const pages = Math.max(1, Math.ceil(d.total / f.limit));
  const page = Math.floor(f.offset / f.limit) + 1;
  return `${headerHTML({ title: 'Datos', sub: `${d.total} gastos · ${money(d.sum)} en el filtro actual`, actions: `<button class="btn" data-act="export-expenses">${icon('download')} CSV</button><button class="btn" data-act="sync">${icon('refresh')} Sincronizar</button>` })}
    ${issues.length ? `<div class="card" style="margin-bottom:14px"><div class="card-head"><div><h3 class="card-title">Calidad de datos</h3><div class="card-sub">Problemas detectados en la planilla</div></div><span class="chip atencion">${issues.length}</span></div>
      <div class="card-body">${issues.map((i) => `<div class="issue-row"><div class="issue-dot"></div><div><b>${esc(i.titulo)}</b><div class="hint">${esc(i.detalle)}</div></div></div>`).join('')}</div></div>` : ''}
    <div class="card"><div class="card-head"><div><h3 class="card-title">Movimientos</h3><div class="card-sub">Filtrá por fecha, categoría o texto</div></div></div>
    <div class="card-body">
      <div class="filters">
        <div class="field"><label>Desde</label><input type="date" id="flt-from" value="${esc(f.from)}"></div>
        <div class="field"><label>Hasta</label><input type="date" id="flt-to" value="${esc(f.to)}"></div>
        <div class="field"><label>Categoría</label><select id="flt-cat"><option value="">Todas</option>${d.categorias.map((c) => `<option ${c === f.categoria ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></div>
        <div class="field" style="flex:1"><label>Buscar</label><input id="flt-q" placeholder="Proveedor, descripción…" value="${esc(f.q)}"></div>
        <div class="field" style="justify-content:flex-end"><button class="btn btn-primary" data-act="apply-exp">${icon('search')} Filtrar</button></div>
      </div>
      <div class="table-wrap" style="margin-top:14px"><table class="tbl"><thead><tr><th>Fecha</th><th>Mes</th><th>Tipo</th><th>Categoría</th><th>Subcategoría</th><th>Descripción</th><th class="r">Monto</th></tr></thead><tbody>
      ${d.rows.map((r) => `<tr><td class="num">${dmyFull(r.fecha)}</td><td class="num muted">${esc(r.mes)}</td><td><span class="chip sm ${r.tipo === 'Fijo' ? 'gray' : ''}">${esc(r.tipo)}</span></td><td>${esc(r.categoria)}</td><td class="muted small">${esc(r.subcategoria)}</td><td>${esc(r.descripcion)}</td><td class="r num">${money(r.monto)}</td></tr>`).join('') || `<tr><td colspan="7">${emptyHTML('Sin movimientos')}</td></tr>`}
      </tbody></table></div>
      <div class="pager"><button class="btn btn-sm" data-act="exp-page" data-dir="-1" ${page <= 1 ? 'disabled' : ''}>${icon('left')} Anterior</button><span class="hint">Página ${page} de ${pages}</span><button class="btn btn-sm" data-act="exp-page" data-dir="1" ${page >= pages ? 'disabled' : ''}>Siguiente ${icon('right')}</button></div>
    </div></div>`;
}

async function loadDatos() {
  const f = S.expFilters;
  const q = new URLSearchParams({ limit: f.limit, offset: f.offset, from: f.from, to: f.to, categoria: f.categoria, q: f.q });
  const [data, quality] = await Promise.all([api('/api/expenses?' + q), api('/api/quality')]);
  S.expensesData = data;
  S.quality = quality;
}

/* ================================================================ ENLACES */
function renderEnlaces() {
  const ov = S.overview;
  const cfg = ov.config || {};
  const rep = ov.last_sync_report;
  const tabs = cfg.tabs || {};
  const counts = ov.counts || {};
  const fudoTo = new Date().toISOString().slice(0, 10);
  const fudoFrom = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
  const comp = Object.entries(tabs).map(([k, t]) => {
    const r = (ov.last_sync_report?.tabs || []).find((x) => x.key === k);
    const filas = { gastos: counts.expenses, ventas: counts.sales, semanal: counts.weekly_history, mensual: counts.monthly_history }[k];
    const imported = filas != null;
    return `<tr><td class="cat-name">${esc(t.name)}</td><td class="mono muted">${esc(t.gid || '—')}</td><td class="r num">${imported ? nf(filas) : '—'}</td>
      <td>${imported ? (r ? `<span class="chip sm ${r.status === 'ok' ? 'ok' : 'atencion'}">${r.status === 'ok' ? 'OK' : 'Error'}</span>` : '<span class="hint">—</span>') : '<span class="chip sm gray">referencia</span>'}</td>
      <td class="r"><a class="btn btn-ghost btn-sm" href="${esc(t.url)}" target="_blank" rel="noopener">${icon('external')} Abrir</a></td></tr>`;
  }).join('');
  const lastTabs = ov.last_sync_report?.tabs || [];
  return `${headerHTML({ title: 'Enlaces', sub: 'Conexión con la planilla y envío automático de gastos', actions: `<button class="btn btn-primary" data-act="sync">${icon('refresh')} Sincronizar ahora</button>` })}
    <div class="card"><div class="card-head"><div><h3 class="card-title">Planilla de Google</h3><div class="card-sub">La app lee la planilla cada vez que sincronizás. No hace falta descargar nada.</div></div>
      <span class="chip ${ov.sync_ok === false ? 'atencion' : 'ok'}">${ov.last_sync ? 'Conectada' : 'Sin sincronizar'}</span></div>
      <div class="card-body">
        <div class="form-grid" style="margin-bottom:10px">
          <div class="field span-4"><label>Nombre del local</label><input id="cfg-name" value="${esc(cfg.restaurant || '')}" placeholder="Nombre del local"></div>
          <div class="field span-8"><label>Link de la planilla</label><input id="cfg-sheet" value="${esc(cfg.sheet_url || '')}"></div>
        </div>
        <div class="form-grid" style="margin-bottom:4px">
          <div class="field span-3"><label>Actualizar sola cada (min)</label><input id="cfg-autosync" type="number" min="0" max="1440" value="${cfg.auto_sync_minutes ?? 15}"></div>
        </div>
        <div class="hint" style="margin-bottom:10px">0 = solo cuando tocás Sincronizar. Mientras la app está abierta, relee la planilla cada X minutos y refresca las estadísticas.</div>
        <div class="form-grid" style="margin-bottom:10px">
          <div class="field span-8"><label>API key de Google (opcional)</label><input id="cfg-apikey" placeholder="${cfg.google_api ? 'ya configurada · pegá otra para reemplazarla' : 'AIza…'}"></div>
          <div class="field span-4" style="justify-content:flex-end"><button class="btn btn-sm" data-act="test-api">${icon('cloud')} Probar API</button></div>
        </div>
        <div class="hint" id="api-status">${cfg.google_api
          ? 'API configurada: la app la usa primero y, si falla, cae al enlace CSV.'
          : 'Sin API key: la app lee por el enlace público (funciona igual).'}</div>
        <div class="form-foot" style="margin-top:10px"><button class="btn btn-primary btn-sm" data-act="save-sheet">${icon('check')} Guardar conexión</button>
        <a class="btn btn-sm" href="${esc(cfg.sheet_url)}" target="_blank" rel="noopener">${icon('external')} Abrir en Google Sheets</a>
        <span class="hint">La planilla tiene que estar compartida como “cualquiera con el enlace puede ver”.</span></div>
        <div class="table-wrap" style="margin-top:14px"><table class="tbl"><thead><tr><th>Pestaña</th><th>gid</th><th class="r">Filas</th><th>Estado</th><th></th></tr></thead><tbody>${comp}</tbody></table></div>
      </div></div>

    <div class="card mt"><div class="card-head"><div><h3 class="card-title">Fudo · API pública</h3><div class="card-sub">Para leer ventas, gastos e insumos directo de Fudo. Requiere Plan Pro y un usuario de API con permisos de lectura.</div></div>
      <span class="chip ${cfg.fudo ? 'ok' : 'gray'}">${cfg.fudo ? 'Credenciales guardadas' : 'Sin configurar'}</span></div>
      <div class="card-body">
        <div class="form-grid">
          <div class="field span-6"><label>API Key</label><input id="fudo-key" autocomplete="off" placeholder="${cfg.fudo ? 'ya configurada · pegá otra para reemplazarla' : 'Administración → Usuarios → editar el usuario de API'}"></div>
          <div class="field span-6"><label>API Secret</label><input id="fudo-secret" type="password" autocomplete="new-password" placeholder="${cfg.fudo ? 'ya guardada · se puede reemplazar' : 'botón Establecer (se muestra una sola vez)'}"></div>
        </div>
        <div class="form-foot">
          <button class="btn btn-primary btn-sm" data-act="save-fudo">${icon('check')} Guardar credenciales</button>
          <button class="btn btn-sm" data-act="test-fudo">${icon('cloud')} Probar conexión</button>
          <span class="hint" id="fudo-status">${cfg.fudo ? 'Credenciales guardadas. Probá la conexión para ver un gasto real.' : 'Sin credenciales: la app sigue funcionando con la planilla.'}</span>
        </div>

        <div class="import-block">
          <div class="import-title">Traer las ventas de Fudo</div>
          <div class="form-foot" style="margin-top:6px">
            <div class="field" style="max-width:150px;margin:0"><label>Desde</label><input id="fudo-from" type="date" value="${fudoFrom}"></div>
            <div class="field" style="max-width:150px;margin:0"><label>Hasta</label><input id="fudo-to" type="date" value="${fudoTo}"></div>
            <button class="btn btn-sm" data-act="fudo-sales-preview">${icon('search')} Probar sin guardar</button>
            <button class="btn btn-sm btn-primary" data-act="fudo-sales-import">${icon('download')} Importar ventas</button>
            <button class="btn btn-sm btn-ghost" data-act="fudo-sales-clear" title="Borra la importación de Fudo del rango y deja que la planilla vuelva a mandar">Quitar importación</button>
          </div>
          <div class="hint" style="margin-top:6px">Reemplaza en la app las semanas que cubre el rango. La planilla no se toca.</div>
          <div id="fudo-import-out"></div>
        </div>

        <div class="form-foot" style="margin-top:4px">
          <span class="hint">Ver una muestra de:</span>
          <button class="btn btn-sm" data-act="fudo-preview" data-resource="expenses">Gastos</button>
          <button class="btn btn-sm" data-act="fudo-preview" data-resource="sales">Ventas</button>
          <button class="btn btn-sm" data-act="fudo-preview" data-resource="ingredients">Insumos</button>
          <button class="btn btn-sm" data-act="fudo-preview" data-resource="providers">Proveedores</button>
        </div>
        <div id="fudo-sample"></div>
        <details class="alert-more" style="margin-top:10px"><summary>¿De dónde salen estos datos?</summary>
          <ol class="steps">
            <li>En Fudo: <b>Aplicaciones externas → API Pública General</b> (plan Pro).</li>
            <li>En Fudo: <b>Administración → Usuarios</b> → crear un usuario de API con permisos de lectura de Ventas, Gastos, Productos e Insumos.</li>
            <li>Editar ese usuario: copiar la <b>API Key</b>, tocar <b>Establecer</b> y copiar la <b>API Secret</b> (no se vuelve a mostrar).</li>
            <li>Pegarlas acá y probar la conexión. La app pide un token que dura 24 h y lo renueva sola.</li>
          </ol>
        </details>
      </div></div>

    <div class="split mt">
      <div class="card"><div class="card-head"><div><h3 class="card-title">Última sincronización</h3><div class="card-sub">${ov.last_sync ? dmyFull(ov.last_sync.slice(0, 10)) + ' ' + ov.last_sync.slice(11, 16) : 'Todavía no sincronizaste'}</div></div></div>
        <div class="card-body" style="padding-top:10px">${lastTabs.length ? `<div class="table-wrap"><table class="tbl"><thead><tr><th>Pestaña</th><th class="r">Filas</th><th>Resultado</th><th class="r">Tiempo</th></tr></thead><tbody>
          ${lastTabs.map((r) => `<tr><td class="cat-name">${esc(r.name || r.key)}</td><td class="r num">${nf(r.rows || 0)}</td><td>${r.status === 'ok' ? '<span class="chip sm ok">OK</span>' : `<span class="chip sm atencion" title="${esc(r.message || '')}">Error</span>`}</td><td class="r muted">${r.ms ? nf(r.ms) + ' ms' : '—'}</td></tr>`).join('')}
          </tbody></table></div>` : emptyHTML('Sin sincronizaciones')}
        ${lastTabs.some((t) => t.warnings?.length) ? `<div class="note warn" style="margin-top:10px">${icon('warning')}<div>${lastTabs.flatMap((t) => (t.warnings || []).map((w) => esc(t.name + ': ' + w))).slice(0, 5).join('<br>')}</div></div>` : ''}
        </div></div>
      <div class="card"><div class="card-head"><div><h3 class="card-title">Envío automático de gastos</h3><div class="card-sub">Opcional: cargar en la app y que se escriba en el Sheet</div></div>
        <span class="chip ${cfg.webhook ? 'ok' : 'gray'}">${cfg.webhook ? 'Configurado' : 'Sin configurar'}</span></div>
        <div class="card-body">
          <div class="note info" style="margin-bottom:12px">${icon('info')}<div>Para que la app escriba en la planilla hace falta un pequeño script de Google (5 minutos, se hace una sola vez).</div></div>
          <div class="form-grid">
            <div class="field span-8"><label>URL del Web App (termina en /exec)</label><input id="cfg-webhook" placeholder="https://script.google.com/macros/s/…/exec" value="${esc(cfg.webhook_url || '')}"></div>
            <div class="field span-4"><label>Token</label><input id="cfg-token" placeholder="${cfg.webhook ? 'dejalo vacío para conservarlo' : 'token secreto'}"></div>
          </div>
          <div class="form-foot"><button class="btn btn-primary btn-sm" data-act="save-webhook">${icon('check')} Guardar</button>
            <button class="btn btn-sm" data-act="toggle-code">${icon('list')} Ver script</button></div>
          <div id="code-box" style="display:none;margin-top:12px">
            <pre class="code" id="code-pre">Cargando…</pre>
            <div class="form-foot"><button class="btn btn-sm" data-act="copy-code">${icon('copy')} Copiar script</button></div>
          </div>
          <ol class="steps">
            <li>Abrí la planilla → <b>Extensiones → Apps Script</b>.</li>
            <li>Pegá el script, cambiá el token por uno tuyo y guardá.</li>
            <li><b>Implementar → Nueva implementación → Aplicación web</b>. Ejecutar como <b>yo</b>, acceso <b>cualquier persona</b>.</li>
            <li>Copiá la URL que termina en <span class="mono">/exec</span> y pegala acá junto con el token.</li>
          </ol>
        </div></div>
    </div>

    <div class="card mt"><div class="card-head"><div><h3 class="card-title">Objetivos de CMV</h3><div class="card-sub">Una categoría por línea, por ejemplo <span class="mono">Cafetería = 15-20</span>. Se usan para marcar la tabla semanal y para alertar cuando una categoría se pasa.</div></div></div>
      <div class="card-body">
        <textarea class="textarea-copy" id="cmv-targets" style="min-height:150px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px">${esc(cfg.cmv_targets_text || '')}</textarea>
        <div class="form-foot"><button class="btn btn-primary btn-sm" data-act="save-targets">${icon('check')} Guardar objetivos</button>
          <span class="hint">El rango es el % de CMV sobre ventas que considerás rentable. Si una categoría no tiene objetivo, no se controla.</span></div>
      </div></div>

    <div class="card mt"><div class="card-head"><div><h3 class="card-title">Estado del sistema</h3><div class="card-sub">Datos guardados localmente en <span class="mono">data/gestion.db</span></div></div></div>
      <div class="card-body"><div class="stat-grid">
        <div><div class="hint">Gastos</div><div class="stat-num">${nf(counts.expenses || 0)}</div></div>
        <div><div class="hint">Ventas (líneas)</div><div class="stat-num">${nf(counts.sales || 0)}</div></div>
        <div><div class="hint">Semanas en el histórico</div><div class="stat-num">${nf(new Set((S.overview?.series_weekly || []).map((w) => w.key)).size)}</div></div>
        <div><div class="hint">Meses analizados</div><div class="stat-num">${nf((S.overview?.months || []).length)}</div></div>
        <div><div class="hint">Cargas pendientes</div><div class="stat-num">${nf(counts.entries || 0)}</div></div>
      </div></div></div>`;
}

/* ================================================================ router */
async function loadOverview() {
  S.overview = await api('/api/overview');
  if (!S.weekKey) S.weekKey = S.overview.default_week;
  if (!S.monthKey) S.monthKey = S.overview.current_week.month;
  renderNav();
}

async function ensureWeek() {
  if (!S.weekKey) S.weekKey = S.overview.default_week;
  S.week = await api('/api/week?key=' + encodeURIComponent(S.weekKey));
}

async function ensureMonth() {
  if (!S.monthKey) S.monthKey = S.overview.current_week.month;
  S.month = await api('/api/month?month=' + encodeURIComponent(S.monthKey));
}

async function render(silent = false) {
  S.route = routeFromHash();
  const view = $('#view');
  renderNav();
  if (!silent) view.innerHTML = loadingHTML();
  try {
    if (!S.overview) await loadOverview();
    renderNav();
    if (S.route === 'panel') {
      await ensureWeek();
      view.innerHTML = renderPanel();
      mountPanel();
    } else if (S.route === 'semanal') {
      await ensureWeek();
      view.innerHTML = renderSemanal();
      mountSemanal();
    } else if (S.route === 'mensual') {
      await ensureMonth();
      view.innerHTML = renderMensual();
      mountMensual();
    } else if (S.route === 'gastos') {
      await refreshGastos();
    } else if (S.route === 'alertas') {
      S.alerts = await api('/api/alerts');
      view.innerHTML = renderAlertas();
    } else if (S.route === 'datos') {
      await loadDatos();
      view.innerHTML = renderDatos();
    } else if (S.route === 'enlaces') {
      S.overview = await api('/api/overview');
      S.overview.config = S.overview.config || {};
      view.innerHTML = renderEnlaces();
    }
    if (!silent) window.scrollTo({ top: 0 });
    autoGrowTextareas();
  } catch (e) {
    console.error(e);
    view.innerHTML = errorHTML(e);
  }
}

function autoGrowTextareas() {
  $$('textarea.textarea-copy').forEach((ta) => {
    ta.style.overflow = 'hidden';
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight + 4, 640) + 'px';
  });
}

/* ------------------------------------------------------------------ eventos */
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const stop = () => { ev.preventDefault(); ev.stopPropagation(); };
  try {
    if (act === 'nav') { location.hash = '#/' + el.dataset.route; return; }
    if (act === 'reload') { S.overview = null; return render(); }
    if (act === 'sync') { return syncNow(el); }
    if (act === 'copy-narrative') {
      const ta = $('#narrative');
      return copyText(ta ? ta.value : S.week?.narrative || '', 'Resumen copiado');
    }
    if (act === 'copy-week-rows') {
      const d = await api('/api/paste/week?key=' + encodeURIComponent(S.weekKey));
      return copyText(d.tsv, 'Filas copiadas: pegalas en Historico_Semanal');
    }
    if (act === 'copy-month-close') {
      const m = S.month;
      const t = m.totals;
      const rows = [m.month.key, t.ventas, t.cmv, t.bruto, t.cmv_pct / 100, t.gastos, t.ganancia_neta, t.margen_neto / 100].join('\t');
      return copyText(rows, 'Totales del mes copiados');
    }
    if (act === 'week-prev' || act === 'week-next') {
      const idx = S.overview.weeks.findIndex((w) => w.key === S.weekKey);
      const next = S.overview.weeks[idx + (act === 'week-prev' ? -1 : 1)];
      if (next) { S.weekKey = next.key; return render(); }
      return;
    }
    if (act === 'month-prev' || act === 'month-next') {
      const idx = S.overview.months.findIndex((w) => w.key === S.monthKey);
      const next = S.overview.months[idx + (act === 'month-prev' ? -1 : 1)];
      if (next) { S.monthKey = next.key; return render(); }
      return;
    }
    if (act === 'sort') {
      const k = el.dataset.sort;
      if (S.sort === k) S.sortDir *= -1; else { S.sort = k; S.sortDir = -1; }
      if (S.route === 'semanal') { $('#view').innerHTML = renderSemanal(); mountSemanal(); }
      return;
    }
    if (act === 'export-week') { window.location = '/api/export/week.csv?key=' + encodeURIComponent(S.weekKey); return; }
    if (act === 'export-month') { window.location = '/api/export/month.csv?month=' + encodeURIComponent(S.monthKey); return; }
    if (act === 'export-expenses') {
      const f = S.expFilters;
      window.location = `/api/export/expenses.csv?from=${f.from}&to=${f.to}&categoria=${encodeURIComponent(f.categoria)}&q=${encodeURIComponent(f.q)}`;
      return;
    }
    if (act === 'apply-exp') {
      S.expFilters.from = $('#flt-from').value;
      S.expFilters.to = $('#flt-to').value;
      S.expFilters.categoria = $('#flt-cat').value;
      S.expFilters.q = $('#flt-q').value;
      S.expFilters.offset = 0;
      await loadDatos();
      $('#view').innerHTML = renderDatos();
      return;
    }
    if (act === 'exp-page') {
      const dir = +el.dataset.dir;
      S.expFilters.offset = Math.max(0, S.expFilters.offset + dir * S.expFilters.limit);
      await loadDatos();
      $('#view').innerHTML = renderDatos();
      return;
    }
    if (act === 'search-exp') {
      S.expFilters.q = $('#quick-search').value;
      await refreshGastos();
      return;
    }
    if (act === 'quick-prov' || act === 'quick-add') {
      const d = el.dataset;
      const desc = $('#f-desc'), monto = $('#f-monto'), cat = $('#f-cat'), sub = $('#f-sub'), tipo = $('#f-tipo');
      if (desc) desc.value = d.name || '';
      if (monto) monto.value = Number(d.monto || 0).toLocaleString('es-AR');
      if (cat && d.cat) cat.value = d.cat;
      if (sub && d.sub) sub.value = d.sub;
      if (tipo && d.tipo) tipo.value = d.tipo;
      if (act === 'quick-add') { await saveEntry(); }
      else { updateProvHint(); monto?.focus(); }
      return;
    }
    if (act === 'del-entry') {
      await api('/api/entries/discard', { method: 'POST', body: JSON.stringify({ id: +el.dataset.id }) });
      toast('Carga descartada');
      await refreshGastos();
      return;
    }
    if (act === 'copy-paste') {
      const d = await api('/api/entries');
      return copyText(d.tsv || '', d.count ? 'Bloque copiado: pegalo al final de la pestaña Gastos' : 'No hay nada para copiar');
    }
    if (act === 'push-entries') {
      el.disabled = true;
      try {
        const r = await api('/api/entries/push', { method: 'POST', body: '{}' });
        toast(`${r.pushed} gasto(s) enviados a la planilla`, 'ok');
        await refreshGastos();
      } finally {
        el.disabled = false;
      }
      return;
    }
    if (act === 'bulk-preview') {
      const lines = ($('#bulk')?.value || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const rows = lines.map(parseBulkLine).filter(Boolean);
      S.bulkRows = rows;
      $('#bulk-preview').innerHTML = rows.length
        ? `<div class="table-wrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>Proveedor</th><th class="r">Monto</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.descripcion)}</td><td class="r num">${money(r.monto)}</td></tr>`).join('')}</tbody></table></div>
           <div class="form-foot"><button class="btn btn-primary btn-sm" data-act="bulk-save">${icon('plus')} Agregar ${rows.length} gasto(s)</button></div>`
        : `<div class="hint" style="margin-top:8px">No pude leer ninguna línea. Formato: <span class="mono">Proveedor 25.000</span></div>`;
      return;
    }
    if (act === 'bulk-save') {
      const rows = S.bulkRows || [];
      let ok = 0, err = 0;
      for (const r of rows) {
        const res = await api('/api/entries', { method: 'POST', body: JSON.stringify({ ...r, fecha: $('#f-fecha')?.value || new Date().toISOString().slice(0, 10), categoria: 'Reposiciones', tipo: 'Variable', subcategoria: 'Proveedor' }) });
        if (res.ok) ok++; else err++;
      }
      toast(`${ok} cargados${err ? `, ${err} con error` : ''}`, err ? 'err' : 'ok');
      $('#bulk').value = '';
      $('#bulk-preview').innerHTML = '';
      await refreshGastos();
      return;
    }
    if (act === 'copy-alert') {
      const list = el.closest('.alert-more')?.querySelector('.alert-list');
      return copyText(list ? list.innerText : '', 'Detalle copiado');
    }
    if (act === 'alert-filter') { S.alertFilter = el.dataset.filter; $('#view').innerHTML = renderAlertas(); return; }
    if (act === 'save-sheet') {
      const url = $('#cfg-sheet').value;
      const name = $('#cfg-name')?.value || '';
      const apiKey = $('#cfg-apikey')?.value?.trim() || '';
      const autoSync = $('#cfg-autosync')?.value;
      const body = { sheet_url: url, restaurant: name };
      if (apiKey) body.google_api_key = apiKey;
      if (autoSync != null && autoSync !== '') body.auto_sync_minutes = Number(autoSync);
      await api('/api/config', { method: 'POST', body: JSON.stringify(body) });
      toast('Conexión guardada', 'ok');
      S.overview = await api('/api/overview');
      renderNav();
      $('#view').innerHTML = renderEnlaces();
      return;
    }
    if (act === 'test-api') {
      const st = $('#api-status');
      const key = $('#cfg-apikey')?.value?.trim() || '';
      st.textContent = 'Probando la API de Google…';
      try {
        if (key) await api('/api/config', { method: 'POST', body: JSON.stringify({ google_api_key: key }) });
        const r = await api('/api/sheets/test');
        st.innerHTML = `<span class="chip ok sm">API OK</span> Leyó ${nf(r.rows)} filas de la pestaña Gastos.`;
      } catch (e) {
        st.innerHTML = `<span class="chip atencion sm">No funcionó</span> ${esc(e.message)}`;
      }
      return;
    }
    if (act === 'save-targets') {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ cmv_targets_text: $('#cmv-targets').value }) });
      toast('Objetivos de CMV guardados', 'ok');
      S.overview = await api('/api/overview');
      $('#view').innerHTML = renderEnlaces();
      return;
    }
    if (act === 'save-fudo') {
      const key = $('#fudo-key')?.value?.trim() || '';
      const secret = $('#fudo-secret')?.value?.trim() || '';
      if (!key && !secret) return toast('Pegá la API Key o la API Secret', 'err');
      await api('/api/config', { method: 'POST', body: JSON.stringify({ fudo_api_key: key, fudo_api_secret: secret }) });
      toast('Credenciales de Fudo guardadas', 'ok');
      S.overview = await api('/api/overview');
      $('#view').innerHTML = renderEnlaces();
      return;
    }
    if (act === 'test-fudo') {
      const st = $('#fudo-status');
      const key = $('#fudo-key')?.value?.trim() || '';
      const secret = $('#fudo-secret')?.value?.trim() || '';
      st.textContent = 'Conectando con Fudo…';
      try {
        if (key || secret) {
          await api('/api/config', { method: 'POST', body: JSON.stringify({ fudo_api_key: key, fudo_api_secret: secret }) });
        }
        const d = await api('/api/fudo/test');
        st.innerHTML = '<span class="chip ok sm">Conectado</span> La API de Fudo respondió correctamente.';
        $('#fudo-sample').innerHTML = `<div class="hint" style="margin-top:8px">Respuesta de prueba (un gasto real):</div>
          <pre class="code" style="max-height:420px">${esc(JSON.stringify(d, null, 2))}</pre>`;
      } catch (e) {
        st.innerHTML = `<span class="chip atencion sm">No funcionó</span> ${esc(e.message)}`;
        $('#fudo-sample').innerHTML = '';
      }
      return;
    }
    if (act === 'fudo-sales-preview') {
      const box = $('#fudo-import-out');
      const from = $('#fudo-from').value, to = $('#fudo-to').value;
      box.innerHTML = `<div class="hint" style="margin-top:8px">Consultando Fudo…</div>`;
      try {
        const d = await api(`/api/fudo/sales/preview?from=${from}&to=${to}`);
        const c = d.control;
        const ok = c.diferencia_pct <= 2;
        box.innerHTML = `<div class="note ${ok ? 'ok' : 'warn'}" style="margin-top:10px">${icon(ok ? 'check' : 'warning')}<div>
          <b>${money(d.ventas)}</b> en ${nf(d.lineas)} líneas · ${d.dias} días · ${d.productos} productos · CMV ${pct(d.cmv_pct)}.<br>
          Control contra Fudo: ${money(c.ventas_fudo)} en ventas vs ${money(c.ventas_items)} en ítems → ${pct(c.diferencia_pct)} de diferencia.
          ${ok ? 'La lectura cuadra.' : 'Ojo: revisar antes de importar.'}<br>
          <span class="hint">Precio leído por ${d.modo === 'unidad' ? 'unidad' : 'línea'} · semanas: ${esc(d.semanas.join(', '))}</span>
        </div></div>
        ${d.muestra?.length ? `<div class="table-wrap" style="margin-top:8px"><table class="tbl"><thead><tr><th>Fecha</th><th>Producto</th><th>Categoría</th><th class="r">Cant.</th><th class="r">Ventas</th><th class="r">CMV</th></tr></thead><tbody>${d.muestra.map((l) => `<tr><td class="num">${dmy(l.fecha)}</td><td>${esc(l.producto)}</td><td class="muted small">${esc(l.categoria)}</td><td class="r num">${nf(l.cantidad)}</td><td class="r num">${money(l.ventas)}</td><td class="r num">${money(l.cmv)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
      } catch (e) {
        box.innerHTML = `<div class="note danger" style="margin-top:10px">${icon('warning')}<div>${esc(e.message)}</div></div>`;
      }
      return;
    }
    if (act === 'fudo-sales-import') {
      const from = $('#fudo-from').value, to = $('#fudo-to').value;
      if (!confirm(`¿Importar las ventas de Fudo del ${dmyFull(from)} al ${dmyFull(to)}?\n\nSe reemplazan las semanas que cubre el rango dentro de la app. La planilla no se modifica.`)) return;
      const box = $('#fudo-import-out');
      box.innerHTML = `<div class="hint" style="margin-top:8px">Importando desde Fudo…</div>`;
      try {
        const r = await api('/api/fudo/sales/import', { method: 'POST', body: JSON.stringify({ from, to }) });
        box.innerHTML = `<div class="note ok" style="margin-top:10px">${icon('check')}<div><b>Importado:</b> ${nf(r.lineas)} líneas · ${money(r.ventas)} de ventas · CMV ${pct(r.cmv_pct)}. Semanas: ${esc(r.semanas.join(', '))}.</div></div>
          <div class="form-foot"><a class="btn btn-sm" href="#/semanal">${icon('week')} Ver semanal</a><a class="btn btn-sm" href="#/panel">${icon('panel')} Ver panel</a></div>`;
        toast('Ventas importadas desde Fudo', 'ok');
        S.overview = await api('/api/overview');
        renderNav();
      } catch (e) {
        box.innerHTML = `<div class="note danger" style="margin-top:10px">${icon('warning')}<div>${esc(e.message)}</div></div>`;
      }
      return;
    }
    if (act === 'fudo-sales-clear') {
      const from = $('#fudo-from').value, to = $('#fudo-to').value;
      if (!confirm(`¿Quitar la importación de Fudo del ${dmyFull(from)} al ${dmyFull(to)}?\n\nLas semanas de ese rango vuelven a leerse de la planilla en la próxima sincronización.`)) return;
      const box = $('#fudo-import-out');
      try {
        const r = await api('/api/fudo/sales/clear', { method: 'POST', body: JSON.stringify({ from, to }) });
        toast(`Se quitaron ${r.deleted} línea(s) importadas de Fudo`, 'ok');
        box.innerHTML = `<div class="note info" style="margin-top:10px">${icon('info')}<div>Se borraron ${nf(r.deleted)} líneas de ${esc(r.semanas.join(', '))}. En la próxima sincronización vuelven a entrar las de la planilla.</div></div>`;
        S.overview = await api('/api/overview');
        renderNav();
      } catch (e) {
        box.innerHTML = `<div class="note danger" style="margin-top:10px">${icon('warning')}<div>${esc(e.message)}</div></div>`;
      }
      return;
    }
    if (act === 'fudo-preview') {
      const res = el.dataset.resource;
      const box = $('#fudo-sample');
      box.innerHTML = `<div class="hint" style="margin-top:8px">Pidiendo una muestra de ${esc(res)}…</div>`;
      try {
        const d = await api('/api/fudo/preview?resource=' + encodeURIComponent(res));
        box.innerHTML = `<div class="hint" style="margin-top:8px">Muestra de ${esc(res)} (cruda, tal como la devuelve Fudo):</div>
          <pre class="code" style="max-height:420px">${esc(JSON.stringify(d, null, 2))}</pre>`;
      } catch (e) {
        box.innerHTML = `<div class="note danger" style="margin-top:8px">${icon('warning')}<div>${esc(e.message)}</div></div>`;
      }
      return;
    }
    if (act === 'save-webhook') {
      await api('/api/config', { method: 'POST', body: JSON.stringify({ webhook_url: $('#cfg-webhook').value, webhook_token: $('#cfg-token').value }) });
      toast('Envío automático configurado', 'ok');
      S.overview = await api('/api/overview');
      $('#view').innerHTML = renderEnlaces();
      return;
    }
    if (act === 'toggle-code') {
      const box = $('#code-box');
      box.style.display = box.style.display === 'none' ? 'block' : 'none';
      if (box.style.display === 'block' && $('#code-pre').textContent === 'Cargando…') {
        const r = await fetch('/code.gs.txt'); $('#code-pre').textContent = await r.text();
      }
      return;
    }
    if (act === 'copy-code') { return copyText($('#code-pre').textContent, 'Script copiado'); }
  } catch (e) {
    console.error(e);
    toast(e.message || 'Error', 'err');
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target.closest('[data-act="week-select"], [data-act="month-select"]');
  if (!el) return;
  if (el.dataset.act === 'week-select') S.weekKey = el.value;
  else S.monthKey = el.value;
  await render();
});

function parseBulkLine(line) {
  const m = line.match(/^(.*?)[\s\t;|]+[$]?\s*([\d.,]+)\s*$/);
  if (!m) return null;
  const monto = parseAmount(m[2]);
  if (!monto) return null;
  return { descripcion: m[1].trim(), monto };
}

async function syncNow(btn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span> Sincronizando…';
  try {
    const rep = await api('/api/sync', { method: 'POST', body: '{}' });
    const tabs = rep.tabs || [];
    const rows = tabs.reduce((a, t) => a + (t.rows || 0), 0);
    toast(rep.ok ? `Sincronizado: ${rows} filas` : 'Sincronizado con avisos', rep.ok ? 'ok' : 'err');
    S.overview = await api('/api/overview');
    S.overview.last_sync_report = rep;
    lastSyncSeen = S.overview.last_sync;
    await render();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
  }
}

/* Refresco automático: el servidor relee la planilla cada N minutos y la web
   se entera comparando la fecha de última sincronización. */
let lastSyncSeen = null;

async function pollUpdates() {
  if (document.hidden) return;
  try {
    const ov = await api('/api/overview');
    const ls = ov.last_sync;
    if (!lastSyncSeen) {
      lastSyncSeen = ls;
      return;
    }
    if (!ls || ls === lastSyncSeen) return;
    lastSyncSeen = ls;
    S.overview = ov;
    const typing = document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (S.route === 'gastos' || typing) {
      renderNav();
      return; // no pisamos una carga en curso
    }
    await render(true);
  } catch {
    /* silencio: si falla, se reintenta en la próxima vuelta */
  }
}

window.addEventListener('resize', () => {
  clearTimeout(window._rz);
  window._rz = setTimeout(() => {
    if (S.route === 'panel') mountPanel();
    if (S.route === 'semanal') mountSemanal();
    if (S.route === 'mensual') mountMensual();
  }, 180);
});

window.addEventListener('hashchange', () => render());

/* ------------------------------------------------------------------ boot */
(async function boot() {
  try {
    await loadOverview();
    lastSyncSeen = S.overview?.last_sync || null;
    await render();
    setInterval(pollUpdates, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) pollUpdates();
    });
  } catch (e) {
    $('#view').innerHTML = errorHTML(e);
  }
})();
