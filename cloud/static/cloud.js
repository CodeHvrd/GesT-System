'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const nfMoney = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const money = { format: (v) => nfMoney.format(v).replace(/\u00a0/g, ' ') };
const num = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });

const state = { from: null, to: null, preset: 'month' };

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function shortMoney(v) {
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + ' k';
  return '$' + Math.round(v);
}
function pct(v, dec = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(dec).replace('.', ',')} %`;
}
function delta(v, unit = '%', invert = false) {
  if (v === null || v === undefined) return '';
  const cls = v > 0.05 ? (invert ? 'down' : 'up') : v < -0.05 ? (invert ? 'up' : 'down') : 'flat';
  const sign = v > 0 ? '+' : '';
  return `<span class="delta ${cls}">${sign}${v.toFixed(1).replace('.', ',')}${unit === 'pp' ? ' pp' : '%'}</span>`;
}

/* ------------------------------------------------------------------ rangos */
function rangeMonth(today) {
  return [new Date(today.getFullYear(), today.getMonth(), 1), today];
}
function rangePrevMonth(today) {
  return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)];
}
function rangeWeek(today) {
  const day = today.getDate();
  const start = Math.floor((day - 1) / 7) * 7 + 1;
  const end = Math.min(start + 6, endOfMonth(today).getDate());
  return [new Date(today.getFullYear(), today.getMonth(), start), new Date(today.getFullYear(), today.getMonth(), end)];
}

function applyPreset(name) {
  const today = new Date();
  let range;
  if (name === 'week') range = rangeWeek(today);
  else if (name === 'prev-month') range = rangePrevMonth(today);
  else range = rangeMonth(today);
  state.from = iso(range[0]);
  state.to = iso(range[1]);
  state.preset = name;
  $('#from').value = state.from;
  $('#to').value = state.to;
  document.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
  load();
}

/* ------------------------------------------------------------------ datos */
async function load() {
  $('#loading').classList.remove('hidden');
  $('#loading').innerHTML = '<span class="spinner"></span> Cargando datos…';
  $('#loading').hidden = false;
  $('#content').hidden = true;
  try {
    const qs = new URLSearchParams({ from: state.from, to: state.to });
    const res = await fetch('/api/dashboard?' + qs.toString(), { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo cargar');
    render(json.data);
    $('#loading').hidden = true;
    $('#content').hidden = false;
  } catch (err) {
    $('#loading').innerHTML = `<div class="empty">No se pudieron cargar los datos.<br><small>${esc(err.message)}</small></div>`;
  }
}

function render(d) {
  const s = d.summary;
  const k = s.kpis;
  const c = s.comparacion;
  if (d.meta && d.meta.local) {
    const brand = document.getElementById('brand-name');
    if (brand) brand.textContent = d.meta.local;
    document.title = `${d.meta.local} · Resumen de gestión`;
  }
  renderKpis(k, c, s.gastos_detalle);
  renderCompare(s, c);
  renderChart(d.daily);
  renderCats(d.categories);
  renderExpenses(d.expenses);
  renderReview(d.review);
  const sync = d.meta && d.meta.ultima_sync;
  $('#foot').textContent =
    `${d.meta ? d.meta.local : 'Mi local'} · ${s.periodo.etiqueta} · ` +
    (sync && sync.cuando ? `última sincronización ${new Date(sync.cuando).toLocaleString('es-AR')}` : 'sin sincronizaciones registradas') +
    ` · generado ${new Date().toLocaleTimeString('es-AR')}`;
}

/* ------------------------------------------------------------------ kpis */
function card(label, value, sub, extra = '', cls = '') {
  return `<div class="kpi ${cls}">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    ${extra ? `<div class="delta-row">${extra}</div>` : ''}
    <div class="sub">${sub}</div>
  </div>`;
}

function renderKpis(k, c, gastos) {
  const del = (v, unit = '%', invert = false) => delta(v, unit, invert);
  const fuente = gastos ? (gastos.fuente === 'sheet' ? 'planilla' : gastos.fuente === 'fudo' ? 'Fudo' : 'manual') : '—';
  const cards = [
    card('Ventas', money.format(k.ventas), `Menú ${shortMoney(k.ventas_menu)} · Delivery ${shortMoney(k.ventas_delivery)}`, del(c.ventas_pct), 'accent'),
    card('Ventas menú', money.format(k.ventas_menu), `Ticket promedio ${money.format(k.ticket)}`, del(c.ventas_menu_pct)),
    card('Gastos', money.format(k.gastos), `Fuente: ${fuente}`, del(c.gastos_pct, '%', true)),
    card('CMV menú', pct(k.cmv_pct), `Costo ${shortMoney(k.cmv)}`, del(c.cmv_pp, 'pp', true)),
    card('Ganancia bruta', money.format(k.ganancia), 'Ventas menú − CMV', del(c.ganancia_pct)),
  ];
  $('#kpis').innerHTML = cards.join('');
}

function renderCompare(s, c) {
  const a = c.anterior;
  const v = c.ventas_pct === null ? '—' : `${c.ventas_pct > 0 ? '+' : ''}${c.ventas_pct.toFixed(1).replace('.', ',')} %`;
  const g = c.gastos_pct === null ? '—' : `${c.gastos_pct > 0 ? '+' : ''}${c.gastos_pct.toFixed(1).replace('.', ',')} %`;
  $('#compare').innerHTML =
    `Comparado con <b>${esc(s.anterior.etiqueta)}</b>: ventas <b>${v}</b> · gastos <b>${g}</b> · ` +
    `CMV <b>${(c.cmv_pp > 0 ? '+' : '') + c.cmv_pp.toFixed(1).replace('.', ',')} pp</b> ` +
    `(antes ${pct(a.cmv_pct)}).`;
}

/* ------------------------------------------------------------------ chart */
function renderChart(daily) {
  const svg = $('#chart');
  const W = 820, H = 230, padL = 58, padR = 10, padT = 12, padB = 30;
  const n = daily.length || 1;
  const max = Math.max(...daily.map((d) => d.total), 1);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / n;
  const bw = Math.max(2, Math.min(26, slot * 0.6));
  let parts = [];

  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH * i) / 4;
    parts.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="axis" x="${padL - 8}" y="${y - 3}" text-anchor="end">${shortMoney((max * i) / 4)}</text>`);
  }

  daily.forEach((d, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const hMenu = (d.menu / max) * plotH;
    const hDel = (d.delivery / max) * plotH;
    const yMenu = padT + plotH - hMenu;
    const yDel = yMenu - hDel;
    const tip = `${d.fecha} · menú ${money.format(d.menu)} · delivery ${money.format(d.delivery)}`;
    if (hMenu > 0) parts.push(`<rect class="bar bar-menu" x="${x}" y="${yMenu}" width="${bw}" height="${hMenu}" rx="2"><title>${esc(tip)}</title></rect>`);
    if (hDel > 0) parts.push(`<rect class="bar bar-del" x="${x}" y="${yDel}" width="${bw}" height="${hDel}" rx="2"><title>${esc(tip)}</title></rect>`);
    if (i === 0 || i === n - 1 || (n > 8 && i % Math.ceil(n / 6) === 0)) {
      const [y, m, dd] = d.fecha.split('-');
      parts.push(`<text class="axis" x="${padL + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${dd}/${m}</text>`);
    }
  });

  if (max <= 1) parts.push(`<text class="axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">Sin ventas en el período</text>`);
  svg.innerHTML = parts.join('');
  $('#chart-note').textContent = `Máximo diario ${money.format(max)}`;
}

/* ------------------------------------------------------------------ categorías */
function renderCats(cats) {
  const tbody = $('#cats tbody');
  if (!cats || !cats.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin ventas de menú en el período.</td></tr>';
    $('#cats-note').textContent = '';
    return;
  }
  const total = cats.reduce((s, c) => s + c.ventas, 0) || 1;
  const rows = cats.slice(0, 12).map((c) => {
    const cmvCls = c.estado_cmv === 'sobre' ? 'sobre' : c.estado_cmv === 'bajo' ? 'bajo' : 'ok';
    const d = c.delta_pct === null ? '—' : `${c.delta_pct > 0 ? '▲' : c.delta_pct < 0 ? '▼' : '·'} ${Math.abs(c.delta_pct).toFixed(0)} %`;
    const dCls = c.delta_pct === null ? 'muted' : c.delta_pct > 0 ? 'good' : 'bad';
    const target = c.objetivo ? `<div class="muted">obj. ${c.objetivo.min.toFixed(0)}–${c.objetivo.max.toFixed(0)} %</div>` : '';
    return `<tr>
      <td><div class="cat-name">${esc(c.categoria)}</div>${target}</td>
      <td class="r num">${money.format(c.ventas)}</td>
      <td class="r"><span class="cmv ${cmvCls}">${pct(c.cmv_pct)}</span></td>
      <td class="r"><span class="bar-share"><i style="width:${Math.min(100, c.participacion)}%"></i></span> <span class="muted">${pct(c.participacion, 0)}</span></td>
      <td class="r num ${dCls}">${d}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join('');
  $('#cats-note').textContent = cats.length > 12 ? `top 12 de ${cats.length}` : `${cats.length} categorías`;
}

/* ------------------------------------------------------------------ gastos */
function renderExpenses(exp) {
  if (!exp || !exp.total) {
    $('#expenses').innerHTML = '<div class="empty">Sin gastos cargados en el período.</div>';
    $('#exp-note').textContent = '';
    return;
  }
  const fuente = exp.fuente === 'sheet' ? 'planilla' : exp.fuente === 'fudo' ? 'Fudo' : 'manual';
  const cats = (exp.categorias || []).slice(0, 6);
  const max = cats.reduce((m, c) => Math.max(m, c.total), 1);
  $('#exp-note').textContent = `${exp.n} movimientos · fuente: ${fuente}`;
  $('#expenses').innerHTML =
    `<div class="exp-total">${money.format(exp.total)}</div>
     <div class="exp-meta">${cats.length ? `Top ${cats.length} de ${exp.categorias.length} categorías` : ''}</div>` +
    (cats.length
      ? cats.map((c) => `<div class="exp-row">
          <span class="name">${esc(c.categoria)}</span>
          <span class="val">${money.format(c.total)}</span>
          <span class="track"><i style="width:${(c.total / max) * 100}%"></i></span>
        </div>`).join('')
      : '<div class="empty">Sin detalle por categoría.</div>');
}

/* ------------------------------------------------------------------ revisión */
function findingHtml(f) {
  const items = f.items && f.items.length
    ? `<details><summary>Ver detalle (${f.items.length})</summary><ul>${f.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>`
    : '';
  return `<article class="finding">
    <div class="t">${esc(f.titulo)}</div>
    <div class="d">${esc(f.detalle)}</div>
    <div class="a">→ ${esc(f.accion)}</div>
    ${items}
  </article>`;
}

function renderReview(review) {
  const levels = [
    ['critico', 'rev-critico', 'n-critico'],
    ['atencion', 'rev-atencion', 'n-atencion'],
    ['info', 'rev-info', 'n-info'],
  ];
  levels.forEach(([key, box, count]) => {
    const items = (review && review[key]) || [];
    $(`#${count}`).textContent = items.length;
    $(`#${box}`).innerHTML = items.length
      ? items.map(findingHtml).join('')
      : '<div class="none">Sin novedades.</div>';
  });
}

/* ------------------------------------------------------------------ eventos */
document.querySelectorAll('[data-preset]').forEach((b) => {
  b.addEventListener('click', () => applyPreset(b.dataset.preset));
});
$('#apply').addEventListener('click', () => {
  const from = $('#from').value;
  const to = $('#to').value;
  if (!from || !to) return;
  state.from = from;
  state.to = to;
  state.preset = null;
  document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active'));
  load();
});
$('#from').addEventListener('change', () => { if (state.preset) document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active')); });

// Al inicio del mes el mes en curso casi no tiene datos: mostramos el mes cerrado.
applyPreset(new Date().getDate() <= 3 ? 'prev-month' : 'month');
