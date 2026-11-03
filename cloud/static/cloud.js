'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const nfMoney = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const money = { format: (v) => nfMoney.format(v).replace(/\u00a0/g, ' ') };

const state = { from: null, to: null, preset: 'week' };

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function iso(d) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
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
  const arrow = v > 0.05 ? '↑' : v < -0.05 ? '↓' : '·';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(v).toFixed(1).replace('.', ',')}${unit === 'pp' ? ' pp' : ' %'}</span>`;
}
function shortDate(isoStr) {
  const [, m, d] = isoStr.split('-');
  return `${d}/${m}`;
}

/* ------------------------------------------------------------------ rangos */
function rangeMonth(today) {
  return [new Date(today.getFullYear(), today.getMonth(), 1), today];
}
function rangePrevMonth(today) {
  return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)];
}
// Misma convención que la planilla: bloques de 7 días dentro del mes (S1 = 1–7, S2 = 8–14…).
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
async function load(quiet = false) {
  if (!quiet) {
    $('#loading').innerHTML = '<span class="spinner"></span> Cargando datos…';
    $('#loading').hidden = false;
    $('#content').hidden = true;
  }
  try {
    const qs = new URLSearchParams({ from: state.from, to: state.to });
    const res = await fetch('/api/dashboard?' + qs.toString(), { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo cargar');
    render(json.data);
    $('#loading').hidden = true;
    $('#content').hidden = false;
  } catch (err) {
    $('#loading').hidden = false;
    $('#loading').innerHTML = `<div class="empty">No se pudieron cargar los datos.<br><small>${esc(err.message)}</small></div>`;
  }
}

function render(d) {
  const s = d.summary;
  if (d.meta && d.meta.local) {
    $('#brand-name').textContent = d.meta.local;
    document.title = `${d.meta.local} · Resumen de gestión`;
  }
  renderFreshness(d.meta);
  renderProgress(s, d.progress);
  renderKpis(s);
  renderCats(d.categories);
  renderCross(d.cross);
  renderExpenses(d.expenses);
  renderExternal(d.external);
  renderChart(d.daily);
  renderReview(d.review);
  const sync = d.meta && d.meta.ultima_sync;
  $('#foot').textContent =
    `${d.meta ? d.meta.local : 'Mi local'} · ${s.periodo.etiqueta} · ` +
    (sync && sync.cuando ? `última sincronización ${new Date(sync.cuando).toLocaleString('es-AR')}` : 'sin sincronizaciones registradas');
}

/* ------------------------------------------------------------------ frescura */
function renderFreshness(meta) {
  const el = $('#freshness');
  const sync = meta && meta.ultima_sync;
  if (!sync || !sync.cuando) {
    el.className = 'fresh stale';
    el.textContent = 'Sin sincronizaciones registradas';
    return;
  }
  const mins = Math.max(0, Math.round((Date.now() - new Date(sync.cuando).getTime()) / 60000));
  let ago;
  if (mins < 1) ago = 'hace instantes';
  else if (mins < 60) ago = `hace ${mins} min`;
  else if (mins < 1440) ago = `hace ${Math.floor(mins / 60)} h`;
  else ago = `el ${new Date(sync.cuando).toLocaleDateString('es-AR')}`;
  const bad = sync.estado !== 'ok';
  const stale = mins > 60;
  el.className = 'fresh' + (bad || stale ? ' stale' : ' live');
  el.textContent = bad ? `Última sincronización con error (${ago})` : `Actualizado ${ago}`;
}

/* ------------------------------------------------------------------ progreso + métricas */
function renderProgress(s, p) {
  const titles = { week: 'Semana actual', month: 'Mes actual', 'prev-month': 'Mes pasado' };
  $('#period-title').textContent = titles[state.preset] || 'Período';
  $('#period-label').textContent = s.periodo.etiqueta;

  const pill = $('#status-pill');
  const box = $('#progress');
  if (!p) {
    pill.hidden = true;
    box.innerHTML = '';
    box.hidden = true;
    return;
  }
  pill.hidden = false;
  box.hidden = false;
  pill.className = `pill ${p.nivel}`;
  pill.textContent = p.estado;

  const vs = p.pct_vs_anterior_total;
  const unit = state.preset === 'week' ? 'semana' : 'período';
  const bar = (label, value, text, cls = '') => `<div class="bar-row">
      <div class="bar-label"><span>${label}</span><b>${text}</b></div>
      <div class="bar"><i class="${cls}" style="width:${Math.max(0, Math.min(100, value))}%"></i></div>
    </div>`;
  box.innerHTML =
    bar('Tiempo transcurrido', p.pct_tiempo, `día ${p.dias_transcurridos} de ${p.dias_total}`, 'time') +
    (vs === null
      ? ''
      : bar(`Ventas vs ${unit} anterior completa`, vs, `${money.format(p.ventas_acumuladas)} de ${money.format(p.ventas_anterior_total)} (${vs.toFixed(0)} %)`, p.nivel)) +
    `<p class="muted proj">A este ritmo cerrarías en <b>${money.format(p.proyeccion)}</b>` +
    (p.ritmo_pct === null
      ? '.'
      : ` · mismos días ${unit} anterior: ${money.format(p.ventas_anterior_mismos_dias)} ${delta(p.ritmo_pct)}`) +
    '</p>';
}

function kpi(label, value, sub, extra = '', cls = '') {
  return `<div class="kpi ${cls}">
    <div class="label">${esc(label)}</div>
    <div class="value">${value}</div>
    <div class="sub">${sub}${extra ? ' ' + extra : ''}</div>
  </div>`;
}

function renderKpis(s) {
  const k = s.kpis;
  const c = s.comparacion;
  const fuente = k.gastos_fudo_fuente === 'sheet' ? 'planilla' : k.gastos_fudo_fuente === 'fudo' ? 'Fudo en vivo' : 'sin datos';
  $('#kpis').innerHTML = [
    kpi('Ventas', money.format(k.ventas), `Menú ${shortMoney(k.ventas_menu)} · Delivery ${shortMoney(k.ventas_delivery)}`, delta(c.ventas_pct)),
    kpi('Ganancia bruta', money.format(k.ganancia), `CMV ${pct(k.cmv_pct)}`, delta(c.ganancia_pct)),
    kpi('Gastos Fudo', money.format(k.gastos_fudo), `Fuente: ${fuente}`),
    kpi('Gastos externos', money.format(k.gastos_externos), 'Excepcionales cargados'),
    kpi('Gastos fijos', money.format(k.gastos_fijos), 'Prorrateados al período'),
  ].join('');
  const good = k.resultado >= 0;
  $('#result').innerHTML =
    `Gastos totales <b>${money.format(k.gastos)}</b> ${delta(c.gastos_pct, '%', true)}` +
    ` &nbsp;·&nbsp; Resultado (ganancia bruta − gastos) <b class="${good ? 'good' : 'bad'}">${money.format(k.resultado)}</b>`;
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
  const parts = [];

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
    if (n <= 8 || i === 0 || i === n - 1 || i % Math.ceil(n / 6) === 0) {
      const [, m, dd] = d.fecha.split('-');
      parts.push(`<text class="axis" x="${padL + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${dd}/${m}</text>`);
    }
  });

  if (max <= 1) parts.push(`<text class="axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">Sin ventas en el período</text>`);
  svg.innerHTML = parts.join('');
  $('#chart-note').textContent = `Máximo diario ${money.format(max)}`;
}

/* ------------------------------------------------------------------ categorías */
function renderCats(cats) {
  const box = $('#cats');
  if (!cats || !cats.length) {
    box.innerHTML = '<div class="empty">Sin ventas de menú en el período.</div>';
    $('#cats-note').textContent = '';
    return;
  }
  const shown = cats.slice(0, 10);
  box.innerHTML = shown.map((c, i) => {
    const cmvCls = c.estado_cmv === 'sobre' ? 'sobre' : c.estado_cmv === 'bajo' ? 'bajo' : 'ok';
    const prods = (c.productos || []).map((p) => `<li>
        <span class="p-name">${esc(p.producto)}</span>
        <span class="p-qty">${p.cantidad} u.</span>
        <span class="p-val num">${money.format(p.ventas)}</span>
      </li>`).join('');
    return `<details class="cat"${i === 0 ? ' open' : ''}>
      <summary>
        <span class="cat-name">${esc(c.categoria)}</span>
        <span class="cat-bar"><i style="width:${Math.min(100, c.participacion)}%"></i></span>
        <span class="cat-part muted">${pct(c.participacion, 0)}</span>
        <span class="cmv ${cmvCls}" title="CMV">${pct(c.cmv_pct, 0)}</span>
        <span class="cat-val num">${money.format(c.ventas)}</span>
      </summary>
      <ul class="prods">${prods || '<li class="muted">Sin detalle de artículos.</li>'}</ul>
    </details>`;
  }).join('');
  $('#cats-note').textContent = cats.length > 10 ? `top 10 de ${cats.length}` : `${cats.length} categorías`;
}

/* ------------------------------------------------------------------ gastos */
function renderCross(rows) {
  const tbody = $('#cross tbody');
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty">Sin datos.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((m) => {
    let diff = '<span class="muted">—</span>';
    if (m.diferencia !== null && m.diferencia !== undefined) {
      const base = m.fudo || 1;
      const rel = Math.abs(m.diferencia) / base * 100;
      const cls = rel < 2 ? 'good' : rel < 10 ? 'warn-text' : 'bad';
      diff = `<span class="${cls}">${m.diferencia > 0 ? '+' : ''}${money.format(m.diferencia)}</span>`;
    }
    const cell = (v) => (v ? money.format(v) : '<span class="muted">—</span>');
    return `<tr>
      <td>${esc(m.etiqueta)}</td>
      <td class="r num">${cell(m.fudo)}</td>
      <td class="r num">${cell(m.planilla)}</td>
      <td class="r num">${diff}</td>
      <td class="r num">${cell(m.externos)}</td>
    </tr>`;
  }).join('');
}

function renderExpenses(exp) {
  if (!exp || !exp.total) {
    $('#expenses').innerHTML = '<div class="empty">Sin gastos de Fudo en el período.</div>';
    return;
  }
  const fuente = exp.fuente === 'sheet' ? 'planilla' : exp.fuente === 'fudo' ? 'Fudo' : 'manual';
  const cats = (exp.categorias || []).slice(0, 8);
  const max = cats.reduce((m, c) => Math.max(m, c.total), 1);
  $('#expenses').innerHTML =
    `<div class="exp-meta">${money.format(exp.total)} · ${exp.n} movimientos · fuente: ${fuente}</div>` +
    cats.map((c) => `<div class="exp-row">
        <span class="name">${esc(c.categoria)}</span>
        <span class="val">${money.format(c.total)}</span>
        <span class="track"><i style="width:${(c.total / max) * 100}%"></i></span>
      </div>`).join('');
}

/* ------------------------------------------------------------------ gastos externos */
function renderExternal(ext) {
  const row = (x, right, sub) => `<div class="ext-row">
      <div><div class="ext-name">${esc(x.nombre)}</div><div class="muted">${sub}</div></div>
      <div class="ext-right"><span class="num">${money.format(x.monto)}</span>
        <button type="button" class="x" data-del="${x.id}" data-kind="${right}" aria-label="Quitar ${esc(x.nombre)}" title="Quitar">×</button></div>
    </div>`;
  $('#ext-fijos').innerHTML = ext.fijos.length
    ? ext.fijos.map((x) => row(x, 'fijo', `${x.frecuencia === 'semanal' ? 'por semana' : 'por mes'}${x.desde ? ' · desde ' + shortDate(x.desde) : ''}`)).join('')
    : '<div class="empty">Todavía no cargaste gastos fijos.</div>';
  $('#ext-exc').innerHTML = ext.excepcionales.length
    ? ext.excepcionales.map((x) => row(x, 'excepcional', shortDate(x.fecha))).join('')
    : '<div class="empty">Sin gastos excepcionales en este período.</div>';
}

function syncFormKind() {
  const fijo = $('#ext-kind').value === 'fijo';
  $('#ext-freq-box').hidden = !fijo;
  $('#ext-date-label').textContent = fijo ? 'Desde (opcional)' : 'Fecha';
  if (fijo) $('#ext-date').value = '';
  else $('#ext-date').value = iso(new Date());
}

function formMessage(text, ok = true) {
  const el = $('#ext-msg');
  el.textContent = text;
  el.className = 'form-msg ' + (ok ? 'ok' : 'err');
}

async function addExternal(ev) {
  ev.preventDefault();
  const form = ev.currentTarget;
  const body = Object.fromEntries(new FormData(form).entries());
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo guardar');
    $('#ext-name').value = '';
    $('#ext-amount').value = '';
    formMessage('Gasto agregado.');
    await load(true);
  } catch (err) {
    formMessage(err.message, false);
  } finally {
    btn.disabled = false;
  }
}

async function removeExternal(id, kind) {
  const msg = kind === 'fijo'
    ? '¿Dar de baja este gasto fijo? Se deja de contar desde hoy y el historial se mantiene.'
    : '¿Quitar este gasto?';
  if (!confirm(msg)) return;
  try {
    const res = await fetch('/api/external?id=' + encodeURIComponent(id), { method: 'DELETE' });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo quitar');
    formMessage('Gasto quitado.');
    await load(true);
  } catch (err) {
    formMessage(err.message, false);
  }
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
$('#ext-kind').addEventListener('change', syncFormKind);
$('#ext-form').addEventListener('submit', addExternal);
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-del]');
  if (btn) removeExternal(btn.dataset.del, btn.dataset.kind);
});

// refresco silencioso cada 5 min para que "Actualizado hace…" y los datos no queden viejos
setInterval(() => { if (!document.hidden && state.from) load(true); }, 300000);

syncFormKind();
applyPreset('week');
