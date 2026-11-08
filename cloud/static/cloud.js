'use strict';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => Array.from(el.querySelectorAll(sel));
const nfMoney = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
const money = { format: (v) => nfMoney.format(Number(v || 0)).replace(/\u00a0/g, ' ') };

const state = {
  from: null,
  to: null,
  preset: 'week',
  section: 'dashboard',
  expandedKpi: null,
  data: null,
  notifPopTab: 'all',
  notifAreaFilter: 'all',
  expGroupFilter: 'all',
  expSearch: '',
};

const SECTION_META = {
  dashboard: { badge: '📊 Dashboard', title: 'Resumen general del negocio' },
  ventas: { badge: '💰 Ventas', title: 'Ventas, Canales (Delivery vs Salón) y Medios de Pago' },
  ganancias: { badge: '📈 Ganancias', title: 'Ecuación de Ganancia Bruta, Margen y Costeo (CMV)' },
  gastos: { badge: '🧾 Gastos', title: 'Gastos Fudo vs Contable, Externos, Fijos y Listado Completo' },
  notificaciones: { badge: '🔔 Notificaciones', title: 'Centro de Notificaciones y Novedades a Atender' },
};

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
  const n = Number(v || 0);
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1).replace('.', ',') + ' M';
  if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + ' k';
  return '$' + Math.round(n);
}
function pct(v, dec = 1) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(dec).replace('.', ',')} %`;
}
function delta(v, unit = '%', invert = false) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '';
  const n = Number(v);
  const cls = n > 0.05 ? (invert ? 'down' : 'up') : n < -0.05 ? (invert ? 'up' : 'down') : 'flat';
  const arrow = n > 0.05 ? '↑' : n < -0.05 ? '↓' : '·';
  return `<span class="delta ${cls}">${arrow} ${Math.abs(n).toFixed(1).replace('.', ',')}${unit === 'pp' ? ' pp' : ' %'}</span>`;
}
function shortDate(isoStr) {
  if (!isoStr) return '—';
  const parts = String(isoStr).split('-');
  if (parts.length < 3) return isoStr;
  return `${parts[2]}/${parts[1]}`;
}

/* ------------------------------------------------------------------ navegación por secciones */
function setSection(name, scrollTarget = null) {
  if (!SECTION_META[name]) name = 'dashboard';
  state.section = name;
  $$('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === name));
  $$('[data-view]').forEach((v) => { v.hidden = v.dataset.view !== name; });
  const meta = SECTION_META[name];
  if ($('#active-section-badge')) $('#active-section-badge').textContent = meta.badge;
  if ($('#active-section-title')) $('#active-section-title').textContent = meta.title;
  if ($('#notif-popover')) {
    $('#notif-popover').hidden = true;
    $('#btn-notif-toggle')?.setAttribute('aria-expanded', 'false');
  }
  if (scrollTarget) {
    setTimeout(() => {
      const el = $(scrollTarget);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  } else {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
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
  $$('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === name));
  load();
}

/* ------------------------------------------------------------------ carga de datos */
async function load(quiet = false) {
  if (!quiet) {
    $('#loading').innerHTML = '<span class="spinner"></span> Cargando datos del período…';
    $('#loading').hidden = false;
    $('#content').hidden = true;
  }
  try {
    const qs = new URLSearchParams({ from: state.from, to: state.to });
    const res = await fetch('/api/dashboard?' + qs.toString(), { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo cargar');
    state.data = json.data;
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
    document.title = `${d.meta.local} · GesT`;
  }
  renderFreshness(d.meta);
  renderVersion(d.meta && d.meta.version);
  renderProgress(s, d.progress);
  renderKpis(s);
  renderExpandedKpi();
  renderChart('#chart', '#chart-note', d.daily);
  renderChart('#chart-ventas', '#chart-ventas-note', d.daily);
  renderCats('#dash-cats', '#dash-cats-note', d.categories, 6);
  renderCats('#cats', '#cats-note', d.categories, 20);
  renderVentasSection(s);
  renderGananciasSection(s, d.categories);
  renderGastosSection(s, d.expenses, d.cross, d.external);
  renderNotifications(d.review);

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
  el.textContent = bad ? `Última sincronización con observación (${ago})` : `Datos sincronizados ${ago}`;
}

/* ------------------------------------------------------------------ progreso + KPIs interactivos */
function renderProgress(s, p) {
  const titles = { week: 'Semana actual', month: 'Mes actual', 'prev-month': 'Mes pasado' };
  $('#period-title').textContent = titles[state.preset] || `Período (${s.periodo.etiqueta})`;
  $('#period-label').textContent = `${s.periodo.etiqueta} · ${s.periodo.dias} días`;

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

function renderKpis(s) {
  const k = s.kpis;
  const c = s.comparacion;
  const delPct = pct(k.delivery_pct, 0);
  const salPct = pct(k.salon_pct, 0);

  $('#kpis').innerHTML = [
    `<article class="kpi-card ${state.expandedKpi === 'ventas' ? 'selected' : ''}" data-kpi="ventas" tabindex="0" role="button" aria-expanded="${state.expandedKpi === 'ventas'}">
      <div>
        <div class="label">💰 Ventas</div>
        <div class="value num">${money.format(k.ventas)}</div>
      </div>
      <div class="sub">
        <span>Delivery ${shortMoney(k.ventas_delivery)} (${delPct}) · Salón ${shortMoney(k.ventas_salon)} (${salPct})</span>
        ${delta(c.ventas_pct)}
      </div>
    </article>`,
    `<article class="kpi-card ${state.expandedKpi === 'ganancias' ? 'selected' : ''}" data-kpi="ganancias" tabindex="0" role="button" aria-expanded="${state.expandedKpi === 'ganancias'}">
      <div>
        <div class="label">📈 Ganancia Bruta</div>
        <div class="value num">${money.format(k.ganancia)}</div>
      </div>
      <div class="sub">
        <span>Margen ${pct(k.margen_bruto_pct)} · CMV ${pct(k.cmv_pct)}</span>
        ${delta(c.ganancia_pct)}
      </div>
    </article>`,
    `<article class="kpi-card ${state.expandedKpi === 'gastos' ? 'selected' : ''}" data-kpi="gastos" tabindex="0" role="button" aria-expanded="${state.expandedKpi === 'gastos'}">
      <div>
        <div class="label">🧾 Gastos</div>
        <div class="value num">${money.format(k.gastos)}</div>
      </div>
      <div class="sub">
        <span>Total gastos del período (click para desglose)</span>
        ${delta(c.gastos_pct, '%', true)}
      </div>
    </article>`,
  ].join('');

  const good = k.resultado >= 0;
  $('#result').innerHTML =
    `<div>Gastos totales del período: <b>${money.format(k.gastos)}</b> ${delta(c.gastos_pct, '%', true)}</div>` +
    `<div>Resultado Neto (Ganancia Bruta − Gastos): <b class="${good ? 'good' : 'bad'}">${money.format(k.resultado)}</b></div>`;
}

function renderExpandedKpi() {
  const box = $('#kpi-expanded');
  if (!box || !state.data || !state.expandedKpi) {
    if (box) box.hidden = true;
    return;
  }
  const s = state.data.summary;
  const k = s.kpis;
  const per = s.periodo.etiqueta;
  box.hidden = false;

  if (state.expandedKpi === 'ventas') {
    const pms = (k.medios_pago || []).slice(0, 6).map((m) => `
      <div class="exp-stat-row">
        <span>${esc(m.metodo)} <small class="muted">(${m.tipo === 'efectivo' ? 'Efectivo' : 'Virtual'})</small></span>
        <b class="num">${money.format(m.monto)} (${pct(m.pct)})</b>
      </div>
    `).join('');

    box.innerHTML = `
      <div class="exp-panel-head">
        <h3>💰 Detalle de Ventas · ${esc(per)}</h3>
        <button type="button" class="exp-panel-close" data-close-kpi>Cerrar ✕</button>
      </div>
      <div class="exp-panel-grid">
        <div class="exp-box">
          <h4>Participación por Canal (Delivery vs Salón)</h4>
          <div class="dual-bar">
            <div class="seg-b" style="width:${Math.max(0, Math.min(100, k.delivery_pct))}%" title="Delivery y Take Away"></div>
            <div class="seg-a" style="width:${Math.max(0, Math.min(100, k.salon_pct))}%" title="Salón"></div>
          </div>
          <div class="exp-stat-row">
            <span>🛵 <b>Delivery y Take Away</b> (Total fuera de salón)</span>
            <b class="num">${money.format(k.ventas_delivery)} (${pct(k.delivery_pct)})</b>
          </div>
          <div class="exp-stat-row">
            <span class="muted">&nbsp;&nbsp;↳ Delivery propio / Mostrador (WhatsApp/Retiro)</span>
            <span class="num">${money.format(k.ventas_delivery_propio)}</span>
          </div>
          <div class="exp-stat-row">
            <span class="muted">&nbsp;&nbsp;↳ Apps de Delivery (Pedidos Ya)</span>
            <span class="num">${money.format(k.ventas_delivery_apps)}</span>
          </div>
          <div class="exp-stat-row">
            <span>🍽️ <b>Salón (Mesas en el local)</b></span>
            <b class="num">${money.format(k.ventas_salon)} (${pct(k.salon_pct)})</b>
          </div>
        </div>

        <div class="exp-box">
          <h4>Cobros en Efectivo vs Transferencia / Virtual</h4>
          <div class="dual-bar">
            <div class="seg-a" style="width:${Math.max(0, Math.min(100, k.efectivo_pct))}%" title="Efectivo"></div>
            <div class="seg-b" style="width:${Math.max(0, Math.min(100, k.virtual_pct))}%" title="Transferencia / Virtual"></div>
          </div>
          <div class="exp-stat-row">
            <span>💵 <b>Vendido en Efectivo</b></span>
            <b class="num">${money.format(k.efectivo)} (${pct(k.efectivo_pct)})</b>
          </div>
          <div class="exp-stat-row">
            <span>💳 <b>Vendido en Transferencia / Virtual</b></span>
            <b class="num">${money.format(k.virtual)} (${pct(k.virtual_pct)})</b>
          </div>
          <div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--line-2)">
            ${pms || '<div class="muted">Sin desglose de pagos registrado.</div>'}
          </div>
        </div>
      </div>
      <div class="exp-panel-foot">
        <button type="button" class="goto-footer-link" data-goto="ventas">..ir a "Ventas" →</button>
      </div>
    `;
    return;
  }

  if (state.expandedKpi === 'ganancias') {
    const eq = k.ecuacion_ganancia || {};
    box.innerHTML = `
      <div class="exp-panel-head">
        <h3>📈 Ecuación y Desglose de Ganancia Bruta · ${esc(per)}</h3>
        <button type="button" class="exp-panel-close" data-close-kpi>Cerrar ✕</button>
      </div>
      <div class="eq-banner">
        <span>Ecuación utilizada:</span>
        <span class="eq-formula">${esc(eq.formula || 'Ganancia Bruta = Ventas Costeadas − CMV')}</span>
      </div>
      <div class="eq-steps">
        <div class="eq-step">
          <div class="k">1. Ventas Totales del Período</div>
          <div class="v num">${money.format(eq.ventas_totales ?? k.ventas)}</div>
          <div class="s">Salón + Delivery propio + Apps (${k.ventas_n} tickets)</div>
        </div>
        <div class="eq-step">
          <div class="k">2. Ventas Costeadas (Carta)</div>
          <div class="v num">${money.format(eq.ventas_costeadas ?? k.ventas_menu)}</div>
          <div class="s">Ventas con receta asignada en Fudo</div>
        </div>
        <div class="eq-step">
          <div class="k">3. (−) Costo Mercadería (CMV)</div>
          <div class="v num">− ${money.format(eq.cmv ?? k.cmv)}</div>
          <div class="s">Representa el ${pct(eq.cmv_pct ?? k.cmv_pct)} sobre carta</div>
        </div>
        <div class="eq-step highlight">
          <div class="k">4. (=) Ganancia Bruta Reflejada</div>
          <div class="v num">${money.format(eq.ganancia_bruta ?? k.ganancia)}</div>
          <div class="s">Margen Bruto: <b>${pct(eq.margen_bruto_pct ?? k.margen_bruto_pct)}</b></div>
        </div>
        <div class="eq-step">
          <div class="k">5. (−) Gastos Totales → Resultado</div>
          <div class="v num ${(eq.resultado_neto ?? k.resultado) >= 0 ? 'good' : 'bad'}">${money.format(eq.resultado_neto ?? k.resultado)}</div>
          <div class="s">Descontando ${money.format(eq.gastos_totales ?? k.gastos)} de gastos</div>
        </div>
      </div>
      <div class="exp-panel-foot">
        <button type="button" class="goto-footer-link" data-goto="ganancias">..ir a "Ganancias" →</button>
      </div>
    `;
    return;
  }

  if (state.expandedKpi === 'gastos') {
    const dif = k.gastos_fudo_dif || 0;
    const difCls = Math.abs(dif) < 5000 ? 'good' : 'warn-text';
    box.innerHTML = `
      <div class="exp-panel-head">
        <h3>🧾 Separación de Gastos del Período · ${esc(per)}</h3>
        <button type="button" class="exp-panel-close" data-close-kpi>Cerrar ✕</button>
      </div>
      <div class="exp-panel-grid">
        <div class="exp-box">
          <h4>1 · Gastos Fudo / Planilla Contable (Reposición)</h4>
          <div class="exp-stat-big num">${money.format(k.gastos_fudo)}</div>
          <div class="exp-stat-row" style="margin-top:8px">
            <span>Cargado en Fudo API:</span>
            <b class="num">${money.format(k.gastos_fudo_api)}</b>
          </div>
          <div class="exp-stat-row">
            <span>Planilla Contable / Reposición:</span>
            <b class="num">${money.format(k.gastos_planilla_contable)}</b>
          </div>
          <div class="exp-stat-row">
            <span>Diferencia detectada:</span>
            <b class="num ${difCls}">${dif > 0 ? '+' : ''}${money.format(dif)}</b>
          </div>
        </div>

        <div class="exp-box">
          <h4>2 · Gastos Externos (Planilla Gestión sin Reposición)</h4>
          <div class="exp-stat-big num">${money.format(k.gastos_externos)}</div>
          <p class="muted" style="margin-top:6px">
            Gastos operativos variables de la Planilla Gestión que <b>no son reposición</b> (Proveedores no productivos, Extras, Mantenimiento) más excepcionales.
          </p>
        </div>

        <div class="exp-box">
          <h4>3 · Gastos Fijos (Separados en Gastos)</h4>
          <div class="exp-stat-big num">${money.format(k.gastos_fijos)}</div>
          <p class="muted" style="margin-top:6px">
            Sueldos, Alquiler, Servicios Base, Impuestos y abonos fijos registrados en el período.
          </p>
        </div>
      </div>
      <div class="exp-panel-foot">
        <button type="button" class="goto-footer-link" data-goto="gastos" data-scroll="#all-expenses-card">..ir a "Gastos" →</button>
      </div>
    `;
  }
}

/* ------------------------------------------------------------------ gráfico diario */
function renderChart(svgSel, noteSel, daily) {
  const svg = $(svgSel);
  if (!svg) return;
  const W = 820, H = 230, padL = 58, padR = 10, padT = 12, padB = 30;
  const list = daily || [];
  const n = list.length || 1;
  const max = Math.max(...list.map((d) => d.total), 1);
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const slot = plotW / n;
  const bw = Math.max(3, Math.min(26, slot * 0.62));
  const parts = [];

  for (let i = 0; i <= 4; i++) {
    const y = padT + plotH - (plotH * i) / 4;
    parts.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y}" y2="${y}"/>`);
    parts.push(`<text class="axis" x="${padL - 8}" y="${y - 3}" text-anchor="end">${shortMoney((max * i) / 4)}</text>`);
  }

  list.forEach((d, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const sal = d.salon ?? d.menu ?? 0;
    const del = d.delivery ?? 0;
    const hSal = (sal / max) * plotH;
    const hDel = (del / max) * plotH;
    const ySal = padT + plotH - hSal;
    const yDel = ySal - hDel;
    const tip = `${d.fecha} · Total ${money.format(d.total)} · Delivery/TakeAway ${money.format(del)} · Salón ${money.format(sal)}`;
    if (hSal > 0) parts.push(`<rect class="bar bar-menu" x="${x}" y="${ySal}" width="${bw}" height="${hSal}" rx="2"><title>${esc(tip)}</title></rect>`);
    if (hDel > 0) parts.push(`<rect class="bar bar-del" x="${x}" y="${yDel}" width="${bw}" height="${hDel}" rx="2"><title>${esc(tip)}</title></rect>`);
    if (n <= 8 || i === 0 || i === n - 1 || i % Math.ceil(n / 6) === 0) {
      const [, m, dd] = d.fecha.split('-');
      parts.push(`<text class="axis" x="${padL + slot * i + slot / 2}" y="${H - 8}" text-anchor="middle">${dd}/${m}</text>`);
    }
  });

  if (max <= 1) parts.push(`<text class="axis" x="${W / 2}" y="${H / 2}" text-anchor="middle">Sin ventas en el período</text>`);
  svg.innerHTML = parts.join('');
  if ($(noteSel)) $(noteSel).textContent = `Pico diario: ${money.format(max)}`;
}

/* ------------------------------------------------------------------ categorías */
function renderCats(boxSel, noteSel, cats, limit = 10) {
  const box = $(boxSel);
  if (!box) return;
  if (!cats || !cats.length) {
    box.innerHTML = '<div class="empty">Sin ventas registradas en el período.</div>';
    if ($(noteSel)) $(noteSel).textContent = '';
    return;
  }
  const shown = cats.slice(0, limit);
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
  if ($(noteSel)) $(noteSel).textContent = cats.length > limit ? `Top ${limit} de ${cats.length} categorías` : `${cats.length} categorías`;
}

/* ------------------------------------------------------------------ SECCIÓN VENTAS */
function renderVentasSection(s) {
  const box = $('#ventas-overview');
  if (!box) return;
  const k = s.kpis;
  const pms = (k.medios_pago || []).map((m) => `
    <tr>
      <td><b>${esc(m.metodo)}</b></td>
      <td><span class="badge-grupo ${m.tipo === 'efectivo' ? 'reposicion' : 'fudo'}">${m.tipo === 'efectivo' ? 'Efectivo' : 'Virtual / Transferencia'}</span></td>
      <td class="r num">${pct(m.pct)}</td>
      <td class="r num"><b>${money.format(m.monto)}</b></td>
    </tr>
  `).join('');

  box.innerHTML = `
    <div class="exp-panel-grid">
      <div class="exp-box">
        <h4>Participación Real por Canal</h4>
        <div class="exp-stat-big num">${money.format(k.ventas)} <small class="muted">(${k.ventas_n} ventas · ticket prom. ${money.format(k.ticket)})</small></div>
        <div class="dual-bar">
          <div class="seg-b" style="width:${Math.max(0, Math.min(100, k.delivery_pct))}%"></div>
          <div class="seg-a" style="width:${Math.max(0, Math.min(100, k.salon_pct))}%"></div>
        </div>
        <div class="exp-stat-row">
          <span>🛵 <b>Delivery y Take Away (Fuera de Salón)</b></span>
          <b class="num">${money.format(k.ventas_delivery)} (${pct(k.delivery_pct)})</b>
        </div>
        <div class="exp-stat-row">
          <span class="muted">&nbsp;&nbsp;• Delivery propio / Mostrador (WhatsApp y Retiro)</span>
          <span class="num">${money.format(k.ventas_delivery_propio)}</span>
        </div>
        <div class="exp-stat-row">
          <span class="muted">&nbsp;&nbsp;• Apps (Pedidos Ya)</span>
          <span class="num">${money.format(k.ventas_delivery_apps)}</span>
        </div>
        <div class="exp-stat-row">
          <span>🍽️ <b>Salón (Mesas en el local)</b></span>
          <b class="num">${money.format(k.ventas_salon)} (${pct(k.salon_pct)})</b>
        </div>
      </div>

      <div class="exp-box">
        <h4>Cobros: Efectivo vs Transferencia / Virtual</h4>
        <div class="dual-bar">
          <div class="seg-a" style="width:${Math.max(0, Math.min(100, k.efectivo_pct))}%"></div>
          <div class="seg-b" style="width:${Math.max(0, Math.min(100, k.virtual_pct))}%"></div>
        </div>
        <div class="exp-stat-row">
          <span>💵 <b>Total Efectivo</b></span>
          <b class="num">${money.format(k.efectivo)} (${pct(k.efectivo_pct)})</b>
        </div>
        <div class="exp-stat-row">
          <span>💳 <b>Total Transferencia / Virtual</b></span>
          <b class="num">${money.format(k.virtual)} (${pct(k.virtual_pct)})</b>
        </div>
        <div class="table-wrap" style="margin-top:10px">
          <table>
            <thead><tr><th>Medio de pago</th><th>Clasificación</th><th class="r">%</th><th class="r">Monto</th></tr></thead>
            <tbody>${pms || '<tr><td colspan="4" class="empty">Sin pagos detallados</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/* ------------------------------------------------------------------ SECCIÓN GANANCIAS */
function renderGananciasSection(s, cats) {
  const eqBox = $('#ganancias-equation');
  const tbody = $('#ganancias-table tbody');
  const k = s.kpis;
  const eq = k.ecuacion_ganancia || {};

  if (eqBox) {
    eqBox.innerHTML = `
      <div class="eq-banner">
        <span>Fórmula aplicada en el período (${esc(s.periodo.etiqueta)}):</span>
        <span class="eq-formula">${esc(eq.formula || 'Ganancia Bruta = Ventas Costeadas − CMV')}</span>
      </div>
      <div class="eq-steps">
        <div class="eq-step">
          <div class="k">Ventas Totales</div>
          <div class="v num">${money.format(k.ventas)}</div>
          <div class="s">Salón + Delivery + Apps</div>
        </div>
        <div class="eq-step">
          <div class="k">Ventas Costeadas (Carta)</div>
          <div class="v num">${money.format(k.ventas_menu)}</div>
          <div class="s">Productos con receta en Fudo</div>
        </div>
        <div class="eq-step">
          <div class="k">(−) Costo Mercadería (CMV)</div>
          <div class="v num">− ${money.format(k.cmv)}</div>
          <div class="s">CMV promedio: <b>${pct(k.cmv_pct)}</b></div>
        </div>
        <div class="eq-step highlight">
          <div class="k">(=) Ganancia Bruta</div>
          <div class="v num">${money.format(k.ganancia)}</div>
          <div class="s">Margen Bruto: <b>${pct(k.margen_bruto_pct)}</b></div>
        </div>
        <div class="eq-step">
          <div class="k">(−) Gastos Totales del Período</div>
          <div class="v num">− ${money.format(k.gastos)}</div>
          <div class="s">Fudo/Repo + Externos + Fijos</div>
        </div>
        <div class="eq-step">
          <div class="k">(=) Resultado Neto Final</div>
          <div class="v num ${k.resultado >= 0 ? 'good' : 'bad'}">${money.format(k.resultado)}</div>
          <div class="s">Ganancia Bruta − Gastos Totales</div>
        </div>
      </div>
    `;
  }

  if (tbody) {
    if (!cats || !cats.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">Sin datos de categorías en el período.</td></tr>';
      return;
    }
    tbody.innerHTML = cats.map((c) => {
      const gan = (c.ventas || 0) - (c.cmv || 0);
      const obj = c.objetivo ? `${c.objetivo.min}–${c.objetivo.max} %` : '—';
      const stCls = c.estado_cmv === 'sobre' ? 'bad' : c.estado_cmv === 'bajo' ? 'warn-text' : 'good';
      const stLbl = c.estado_cmv === 'sobre' ? 'Sobre objetivo' : c.estado_cmv === 'bajo' ? 'Bajo objetivo' : c.objetivo ? 'En objetivo' : 'Sin meta';
      return `<tr>
        <td><b>${esc(c.categoria)}</b></td>
        <td class="r num">${c.cantidad}</td>
        <td class="r num">${money.format(c.ventas)}</td>
        <td class="r num">${money.format(c.cmv)}</td>
        <td class="r num"><b>${money.format(gan)}</b></td>
        <td class="r num"><span class="cmv ${c.estado_cmv}">${pct(c.cmv_pct)}</span></td>
        <td class="r num muted">${obj}</td>
        <td><span class="${stCls}">${stLbl}</span></td>
      </tr>`;
    }).join('');
  }
}

/* ------------------------------------------------------------------ SECCIÓN GASTOS */
function renderGastosSection(s, exp, cross, ext) {
  const k = s.kpis;
  const sumBox = $('#gastos-summary-cards');
  if (sumBox) {
    const dif = k.gastos_fudo_dif || 0;
    sumBox.innerHTML = `
      <div class="g-card total">
        <div class="k">Total Gastos del Período</div>
        <div class="v num">${money.format(k.gastos)}</div>
        <div class="s">Reposición/Fudo + Externos + Fijos</div>
      </div>
      <div class="g-card">
        <div class="k">1 · Gastos Fudo / Reposición</div>
        <div class="v num">${money.format(k.gastos_fudo)}</div>
        <div class="s">Fudo API: ${shortMoney(k.gastos_fudo_api)} · Planilla: ${shortMoney(k.gastos_planilla_contable)} (Dif: ${dif > 0 ? '+' : ''}${shortMoney(dif)})</div>
      </div>
      <div class="g-card">
        <div class="k">2 · Gastos Externos (Sin Reposición)</div>
        <div class="v num">${money.format(k.gastos_externos)}</div>
        <div class="s">Planilla Gestión (Variables no-reposición) + manuales</div>
      </div>
      <div class="g-card">
        <div class="k">3 · Gastos Fijos (Separados)</div>
        <div class="v num">${money.format(k.gastos_fijos)}</div>
        <div class="s">Sueldos, Alquiler, Servicios Base e Impuestos</div>
      </div>
    `;
  }

  // Alerta de Planilla Contable si requiere permiso
  const cAlert = $('#contable-alert');
  if (cAlert) {
    const cs = exp && exp.contable_sheet;
    if (cs && cs.status === 'needs_access') {
      cAlert.hidden = false;
      cAlert.innerHTML = `<b>ℹ️ Nota sobre Planilla Contable:</b> ${esc(cs.message)} Podés habilitar "Cualquier persona con el enlace puede ver" en Google Drive y tocar el ícono de recarga Fudo.`;
    } else {
      cAlert.hidden = true;
    }
  }

  // Tabla mensual comparativa
  const crossBody = $('#cross tbody');
  if (crossBody) {
    if (!cross || !cross.length) {
      crossBody.innerHTML = '<tr><td colspan="7" class="empty">Sin datos mensuales.</td></tr>';
    } else {
      crossBody.innerHTML = cross.map((m) => {
        let diff = '<span class="muted">—</span>';
        if (m.diferencia !== null && m.diferencia !== undefined) {
          const cls = Math.abs(m.diferencia) < 5000 ? 'good' : 'warn-text';
          diff = `<span class="${cls}">${m.diferencia > 0 ? '+' : ''}${money.format(m.diferencia)}</span>`;
        }
        const cell = (v) => (v ? money.format(v) : '<span class="muted">$ 0</span>');
        return `<tr>
          <td><b>${esc(m.etiqueta)}</b></td>
          <td class="r num">${cell(m.fudo)}</td>
          <td class="r num">${cell(m.planilla)}</td>
          <td class="r num">${diff}</td>
          <td class="r num">${cell(m.externos)}</td>
          <td class="r num">${cell(m.fijos)}</td>
          <td class="r num"><b>${cell(m.total)}</b></td>
        </tr>`;
      }).join('');
    }
  }

  // Revisión bidireccional: Gastos que NO están en ambas listas (Gastos Fudo <-> Proveedores Varios)
  const recContBox = $('#reconcile-contable-fudo');
  if (recContBox) {
    const cr = exp && exp.contable_reconciliation;
    const disc = (cr && cr.discrepancias_pendientes) || [];
    const fudoOnly = (cr && cr.fudo_sin_contable) || [];
    if (!disc.length && !fudoOnly.length) {
      recContBox.innerHTML = `<div class="empty good">✓ Todos los comprobantes de <b>Proveedores Varios</b> coinciden con <b>Gastos Fudo</b> en este período${cr && cr.externos_auto_guardados ? ` (${cr.externos_auto_guardados} gastos de otras cuentas guardados automáticamente como Externos en la DB)` : ''}.</div>`;
    } else {
      const sheetRows = disc.map((it) => {
        const cellLink = it.sheet_cell_url
          ? `<a href="${esc(it.sheet_cell_url)}" target="_blank" rel="noopener" class="link-pill" title="Ir directo a la celda ${esc(it.celda_ref || '')} en Google Sheets">📍 Celda ${esc(it.celda_ref || 'B' + it.fila_origen)} en Sheets ↗</a>`
          : `<span class="muted">Fila ${esc(it.fila_origen || '—')}</span>`;
        return `<tr>
          <td class="num">${shortDate(it.fecha)}</td>
          <td><span class="badge-grupo reposicion">En Proveedores Varios · Falta en Fudo</span></td>
          <td><b>${esc(it.proveedor)}</b> <small class="muted">(${esc(it.hoja_mes || 'NOVIEMBRE 26')})</small></td>
          <td>${cellLink}</td>
          <td class="r num"><b>${money.format(it.monto)}</b></td>
          <td class="r">
            <button type="button" class="link-pill" data-reconcile-hash="${esc(it.row_hash)}" data-reconcile-state="conciliado_fudo">✓ Conciliado en Fudo</button>
            <button type="button" class="link-pill" data-reconcile-hash="${esc(it.row_hash)}" data-reconcile-state="confirmado_externo">Guardar Externo</button>
          </td>
        </tr>`;
      }).join('');

      const fudoRows = fudoOnly.map((f) => {
        const sheetUrl = 'https://docs.google.com/spreadsheets/d/1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh/edit?gid=1313414032#gid=1313414032';
        return `<tr>
          <td class="num">${shortDate(f.fecha)}</td>
          <td><span class="badge-grupo fudo">En Fudo API · Falta en Proveedores Varios</span></td>
          <td><b>${esc(f.proveedor)}</b> <small class="muted">(${esc(f.categoria || 'Fudo #' + f.fudo_id)})</small></td>
          <td><a href="${sheetUrl}" target="_blank" rel="noopener" class="link-pill">📗 Pasar a Planilla Contable ↗</a></td>
          <td class="r num"><b>${money.format(f.monto)}</b></td>
          <td class="r"><span class="muted">Fudo #${esc(f.fudo_id)}</span></td>
        </tr>`;
      }).join('');

      recContBox.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Discrepancia (No está en ambas listas)</th>
              <th>Proveedor / Hoja</th>
              <th>Ubicación en Google Sheets</th>
              <th class="r">Monto</th>
              <th class="r">Acción en Neon DB</th>
            </tr>
          </thead>
          <tbody>${sheetRows}${fudoRows}</tbody>
        </table>
      `;
    }
  }

  // Reconciliación por proveedor
  const recBox = $('#reconcile-providers');
  if (recBox) {
    const recs = (exp && exp.reconciliacion_proveedores) || [];
    if (!recs.length) {
      recBox.innerHTML = '<div class="empty">Sin movimientos de proveedores para comparar en este período.</div>';
    } else {
      recBox.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>Proveedor / Concepto</th>
              <th class="r">Planilla (Reposición)</th>
              <th class="r">Fudo API</th>
              <th class="r">Diferencia (Planilla − Fudo)</th>
            </tr>
          </thead>
          <tbody>
            ${recs.slice(0, 15).map((p) => {
              const cls = Math.abs(p.diferencia) < 1000 ? 'good' : 'warn-text';
              return `<tr>
                <td><b>${esc(p.proveedor)}</b></td>
                <td class="r num">${money.format(p.planilla)} <small class="muted">(${p.planilla_n})</small></td>
                <td class="r num">${money.format(p.fudo)} <small class="muted">(${p.fudo_n})</small></td>
                <td class="r num"><span class="${cls}">${p.diferencia > 0 ? '+' : ''}${money.format(p.diferencia)}</span></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `;
    }
  }

  // Cajas de Gastos Externos (sin reposición) y Gastos Fijos
  const renderCatBars = (cats, emptyMsg) => {
    if (!cats || !cats.length) return `<div class="empty">${emptyMsg}</div>`;
    const max = cats.reduce((m, c) => Math.max(m, c.total), 1);
    return cats.map((c) => `
      <div class="exp-row">
        <span class="name">${esc(c.categoria)} <small class="muted">(${c.n} mov.)</small></span>
        <span class="val">${money.format(c.total)}</span>
        <span class="track"><i style="width:${(c.total / max) * 100}%"></i></span>
      </div>
    `).join('');
  };

  if ($('#gastos-externos-box')) {
    $('#gastos-externos-box').innerHTML = renderCatBars(
      exp && exp.categorias_externos,
      'Sin gastos externos (no-reposición) en este período.'
    );
  }
  if ($('#gastos-fijos-box')) {
    $('#gastos-fijos-box').innerHTML = renderCatBars(
      exp && exp.categorias_fijos,
      'Sin gastos fijos registrados en las fechas seleccionadas.'
    );
  }

  renderExternal(ext);
  renderAllExpensesTable();
}

function renderAllExpensesTable() {
  const tbody = $('#all-expenses-table tbody');
  const countEl = $('#all-expenses-count');
  if (!tbody || !state.data || !state.data.expenses) return;

  const all = state.data.expenses.movimientos || [];
  const q = state.expSearch.trim().toLowerCase();
  const grp = state.expGroupFilter;

  const filtered = all.filter((m) => {
    if (grp !== 'all' && m.grupo !== grp) return false;
    if (q) {
      const hay = `${m.categoria} ${m.subcategoria} ${m.descripcion} ${m.origen}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const sumFiltered = filtered.reduce((acc, m) => acc + (m.monto || 0), 0);
  if (countEl) {
    countEl.textContent = `${filtered.length} movimientos mostrados · Suma: ${money.format(sumFiltered)}`;
  }

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">No hay gastos que coincidan con el filtro seleccionado.</td></tr>';
    return;
  }

  tbody.innerHTML = filtered.map((m) => {
    const cellPill = m.sheet_cell_url && m.celda_ref
      ? ` <a href="${esc(m.sheet_cell_url)}" target="_blank" rel="noopener" class="link-pill" title="Abrir celda ${esc(m.celda_ref)} en Google Sheets">📍 ${esc(m.celda_ref)} ↗</a>`
      : '';
    return `
    <tr>
      <td class="num">${shortDate(m.fecha)}</td>
      <td><span class="badge-grupo ${esc(m.grupo)}">${esc(m.origen)}</span>${cellPill}</td>
      <td><b>${esc(m.categoria)}</b></td>
      <td>${esc(m.subcategoria || '—')}</td>
      <td>${esc(m.descripcion || '—')}</td>
      <td class="r num"><b>${money.format(m.monto)}</b></td>
    </tr>
  `;
  }).join('');
}

/* ------------------------------------------------------------------ gastos adicionales portal */
function renderExternal(ext) {
  if (!ext) return;
  const row = (x, right, sub) => `<div class="ext-row">
      <div><div class="ext-name">${esc(x.nombre)}</div><div class="muted">${sub}</div></div>
      <div class="ext-right"><span class="num">${money.format(x.monto)}</span>
        <button type="button" class="x" data-del="${x.id}" data-kind="${right}" aria-label="Quitar ${esc(x.nombre)}" title="Quitar">×</button></div>
    </div>`;
  $('#ext-fijos').innerHTML = ext.fijos.length
    ? ext.fijos.map((x) => row(x, 'fijo', `${x.frecuencia === 'semanal' ? 'por semana' : 'por mes'}${x.desde ? ' · desde ' + shortDate(x.desde) : ''}`)).join('')
    : '<div class="empty">Sin gastos fijos manuales en el portal (se leen de la Planilla Gestión).</div>';
  $('#ext-exc').innerHTML = ext.excepcionales.length
    ? ext.excepcionales.map((x) => row(x, 'excepcional', shortDate(x.fecha))).join('')
    : '<div class="empty">Sin gastos excepcionales manuales en este período.</div>';
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

/* ------------------------------------------------------------------ NOTIFICACIONES (Ventana flotante + Sección) */
function findingHtml(f) {
  const sec = f.seccion || 'dashboard';
  const secLabel = SECTION_META[sec] ? SECTION_META[sec].badge : 'Ir a sección';
  const items = f.items && f.items.length
    ? `<details><summary>Ver detalle (${f.items.length})</summary><ul>${f.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>`
    : '';
  return `<article class="finding">
    <div class="t">${esc(f.titulo)}</div>
    <div class="d">${esc(f.detalle)}</div>
    <div class="a">💡 ${esc(f.accion)}</div>
    ${items}
    <div class="finding-foot">
      <button type="button" class="link-pill" data-goto="${esc(sec)}">Atender en ${esc(secLabel)} →</button>
    </div>
  </article>`;
}

function renderNotifications(review) {
  const crit = (review && review.critico) || [];
  const aten = (review && review.atencion) || [];
  const info = (review && review.info) || [];
  const totalCount = crit.length + aten.length + info.length;

  // Badge superior y badge en sidebar
  const badge = $('#notif-badge');
  if (badge) {
    badge.textContent = totalCount;
    badge.className = 'notif-badge ' + (crit.length ? '' : aten.length ? 'warn' : totalCount ? 'info' : 'zero');
  }
  if ($('#side-notif-count')) $('#side-notif-count').textContent = totalCount;

  // Contadores de pestañas de la ventana flotante
  if ($('#np-c-all')) $('#np-c-all').textContent = totalCount;
  if ($('#np-c-critico')) $('#np-c-critico').textContent = crit.length;
  if ($('#np-c-atencion')) $('#np-c-atencion').textContent = aten.length;
  if ($('#np-c-info')) $('#np-c-info').textContent = info.length;

  renderNotifPopoverList(review);
  renderNotifSectionLevels(review);
}

function renderNotifPopoverList(review) {
  const listEl = $('#notif-pop-list');
  if (!listEl || !review) return;
  const all = [
    ...(review.critico || []).map((x) => ({ ...x, _lvl: 'critico', _tag: '🔴 Crítico' })),
    ...(review.atencion || []).map((x) => ({ ...x, _lvl: 'atencion', _tag: '🟠 Atención' })),
    ...(review.info || []).map((x) => ({ ...x, _lvl: 'info', _tag: '🔵 Info' })),
  ];
  const filtered = state.notifPopTab === 'all' ? all : all.filter((x) => x._lvl === state.notifPopTab);
  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty">Sin notificaciones en esta clasificación.</div>';
    return;
  }
  listEl.innerHTML = filtered.map((f) => {
    const sec = f.seccion || 'notificaciones';
    return `<div class="np-item ${f._lvl}" data-goto="${esc(sec)}">
      <div class="np-item-top">
        <span class="t">${esc(f.titulo)}</span>
        <small class="muted">${f._tag}</small>
      </div>
      <div class="d">${esc(f.detalle)}</div>
      <span class="go">Atender novedad →</span>
    </div>`;
  }).join('');
}

function renderNotifSectionLevels(review) {
  if (!review) return;
  const area = state.notifAreaFilter;
  const levels = [
    ['critico', 'rev-critico', 'n-critico'],
    ['atencion', 'rev-atencion', 'n-atencion'],
    ['info', 'rev-info', 'n-info'],
  ];
  levels.forEach(([key, box, count]) => {
    const raw = (review && review[key]) || [];
    const items = area === 'all' ? raw : raw.filter((x) => (x.seccion || 'dashboard') === area);
    if ($(`#${count}`)) $(`#${count}`).textContent = items.length;
    if ($(`#${box}`)) {
      $(`#${box}`).innerHTML = items.length
        ? items.map(findingHtml).join('')
        : '<div class="none">Sin novedades en esta categoría.</div>';
    }
  });
}

/* ------------------------------------------------------------------ versión y actualización */
let _remoteVerInfo = null;

function renderVersion(ver) {
  const v = ver || '—';
  const btn = $('#btn-update-top');
  const foot = $('#ver-badge');
  if (btn && !_remoteVerInfo) {
    btn.title = `Versión activa: ${v} · Click para actualizar desde GitHub`;
  }
  if (foot && !_remoteVerInfo) {
    foot.textContent = `Versión activa: ${v}`;
  }
}

async function checkRemoteVersion() {
  try {
    const res = await fetch('/api/version?remote=1', { headers: { Accept: 'application/json' } });
    const json = await res.json();
    if (!json.ok || !json.data) return;
    const d = json.data;
    _remoteVerInfo = d;
    const btn = $('#btn-update-top');
    const dot = $('#ver-dot');
    const foot = $('#ver-badge');
    if (d.remoto && d.remoto.corta) {
      if (d.al_dia) {
        if (btn) {
          btn.classList.remove('has-update');
          btn.title = `Al día (${d.version}) · Último commit en GitHub (${d.remoto.corta}): ${d.remoto.mensaje || ''}`;
        }
        if (dot) dot.hidden = true;
        if (foot) foot.textContent = `Versión en uso: ${d.version} (al día con GitHub · ${d.remoto.mensaje || ''})`;
      } else {
        if (btn) {
          btn.classList.add('has-update');
          btn.title = `Nueva versión disponible (${d.remoto.corta}): ${d.remoto.mensaje || ''} · Click para actualizar`;
        }
        if (dot) dot.hidden = false;
        if (foot) foot.textContent = `Versión en uso: ${d.version} · disponible en GitHub: ${d.remoto.corta}`;
      }
    }
  } catch (_e) {
    // silencioso
  }
}

async function forceUpdate() {
  const btn = $('#btn-update-top');
  const dot = $('#ver-dot');
  const msg = $('#ver-msg');
  const syncMsg = $('#sync-msg');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  if (syncMsg) { syncMsg.hidden = false; syncMsg.textContent = 'Actualizando a la última versión de Git…'; }
  if (msg) msg.textContent = 'Consultando último commit en GitHub…';
  try {
    const res = await fetch('/api/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo actualizar');
    const u = json.data;
    const label = `Actualizado a ${u.actual} (${u.mensaje || 'última versión'}) · recargando…`;
    if (msg) msg.textContent = label;
    if (syncMsg) syncMsg.textContent = label;
    if (btn) {
      btn.classList.remove('has-update');
      btn.title = `Actualizado a ${u.actual}`;
    }
    if (dot) dot.hidden = true;
    setTimeout(() => {
      window.location.replace('/?v=' + encodeURIComponent(u.actual) + '&t=' + Date.now());
    }, 500);
  } catch (err) {
    if (msg) msg.textContent = `Error: ${err.message}`;
    if (syncMsg) { syncMsg.hidden = false; syncMsg.textContent = `Error de versión: ${err.message}`; }
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

async function resolveContableDiscrepancy(rowHash, estado) {
  const msg = $('#sync-msg');
  if (msg) { msg.hidden = false; msg.textContent = 'Guardando resolución en Neon DB…'; }
  try {
    const res = await fetch('/api/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ row_hash: rowHash, estado }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || 'No se pudo resolver');
    if (msg) {
      msg.textContent = 'Discrepancia actualizada en Neon DB.';
      setTimeout(() => { if (msg) msg.hidden = true; }, 4000);
    }
    await load(true);
  } catch (err) {
    if (msg) { msg.hidden = false; msg.textContent = `Error al conciliar: ${err.message}`; }
  }
}

async function syncFudo(extra = {}, _retried = false) {
  const btn = $('#btn-sync-fudo');
  const msg = $('#sync-msg');
  const form = $('#fudo-creds-form');
  if (btn) { btn.disabled = true; btn.classList.add('spinning'); }
  if (msg) { msg.hidden = false; msg.textContent = 'Sincronizando ventas y gastos con Fudo y Planillas…'; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55000);
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ days: 10, from: state.from, to: state.to, ...extra }),
      signal: ctrl.signal,
    });
    const json = await res.json();
    if (!json.ok) {
      if (!_retried && (res.status === 404 || String(json.error || '').includes('desconocido') || String(json.error || '').includes('en curso'))) {
        if (msg) msg.textContent = 'Actualizando servidor en vivo…';
        await fetch('/api/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: '{}',
        });
        return await syncFudo(extra, true);
      }
      if (json.needs_credentials && form) {
        form.hidden = false;
        if (msg) msg.textContent = 'Ingresá tu API Key y API Secret de Fudo por única vez:';
        return;
      }
      throw new Error(json.error || 'No se pudo sincronizar con Fudo');
    }
    if (form) form.hidden = true;
    const v = (json.data && json.data.ventas) || {};
    const g = (json.data && json.data.gastos) || {};
    if (msg) {
      msg.textContent = `Sincronizado (${v.written ?? 0} ventas${g.written != null ? ` · ${g.written} gastos Fudo` : ''} actualizados).`;
      setTimeout(() => { if (msg) msg.hidden = true; }, 6000);
    }
    await load(true);
  } catch (err) {
    const text = err.name === 'AbortError' ? 'La consulta tardó demasiado; volvé a intentar.' : err.message;
    if (msg) { msg.hidden = false; msg.textContent = `Error Fudo: ${text}`; }
  } finally {
    clearTimeout(timer);
    if (btn) { btn.disabled = false; btn.classList.remove('spinning'); }
  }
}

/* ------------------------------------------------------------------ eventos */
// Navegación del menú lateral izquierdo
$$('[data-nav]').forEach((b) => {
  b.addEventListener('click', () => setSection(b.dataset.nav));
});

// Presets y filtro de fechas
$$('[data-preset]').forEach((b) => {
  b.addEventListener('click', () => applyPreset(b.dataset.preset));
});
$('#apply').addEventListener('click', () => {
  const from = $('#from').value;
  const to = $('#to').value;
  if (!from || !to) return;
  state.from = from;
  state.to = to;
  state.preset = null;
  $$('[data-preset]').forEach((b) => b.classList.remove('active'));
  load();
});

// Delegación global de clicks (KPIs expandibles, botones "ir a...", eliminar gasto externo, cerrar popover)
document.addEventListener('click', (ev) => {
  // Click en tarjeta KPI del cuadro del período
  const kpiCard = ev.target.closest('[data-kpi]');
  if (kpiCard) {
    const kpiName = kpiCard.dataset.kpi;
    state.expandedKpi = state.expandedKpi === kpiName ? null : kpiName;
    if (state.data) {
      renderKpis(state.data.summary);
      renderExpandedKpi();
    }
    return;
  }

  // Botón cerrar panel KPI expandido
  if (ev.target.closest('[data-close-kpi]')) {
    state.expandedKpi = null;
    if (state.data) {
      renderKpis(state.data.summary);
      renderExpandedKpi();
    }
    return;
  }

  // Botones "..ir a Ventas / Ganancias / Gastos" o navegación interna
  const gotoBtn = ev.target.closest('[data-goto]');
  if (gotoBtn) {
    const targetSec = gotoBtn.dataset.goto;
    const scrollSel = gotoBtn.dataset.scroll || null;
    setSection(targetSec, scrollSel);
    return;
  }

  // Eliminar gasto externo manual
  const delBtn = ev.target.closest('[data-del]');
  if (delBtn) {
    removeExternal(delBtn.dataset.del, delBtn.dataset.kind);
    return;
  }

  // Conciliar / resolver discrepancia de Planilla Contable en Neon DB
  const recBtn = ev.target.closest('[data-reconcile-hash]');
  if (recBtn) {
    resolveContableDiscrepancy(recBtn.dataset.reconcileHash, recBtn.dataset.reconcileState);
    return;
  }

  // Cerrar ventana flotante de notificaciones si se clickea afuera
  const pop = $('#notif-popover');
  const anchor = $('.notif-anchor');
  if (pop && !pop.hidden && anchor && !anchor.contains(ev.target)) {
    pop.hidden = true;
    $('#btn-notif-toggle')?.setAttribute('aria-expanded', 'false');
  }
});

// Soporte de teclado (Enter / Space) en los recuadros KPI
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' || ev.key === ' ') {
    const kpiCard = ev.target.closest('[data-kpi]');
    if (kpiCard) {
      ev.preventDefault();
      kpiCard.click();
    }
  }
});

// Ventana flotante de Notificaciones (botón Info)
if ($('#btn-notif-toggle')) {
  $('#btn-notif-toggle').addEventListener('click', () => {
    const pop = $('#notif-popover');
    if (!pop) return;
    const nextOpen = pop.hidden;
    pop.hidden = !nextOpen;
    $('#btn-notif-toggle').setAttribute('aria-expanded', String(nextOpen));
  });
}
if ($('#btn-close-notif')) {
  $('#btn-close-notif').addEventListener('click', () => {
    $('#notif-popover').hidden = true;
    $('#btn-notif-toggle')?.setAttribute('aria-expanded', 'false');
  });
}
if ($('#btn-go-notificaciones')) {
  $('#btn-go-notificaciones').addEventListener('click', () => setSection('notificaciones'));
}
$$('[data-np-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.notifPopTab = tab.dataset.npTab;
    $$('[data-np-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    if (state.data) renderNotifPopoverList(state.data.review);
  });
});

// Filtros en la sección Notificaciones
$$('[data-nf-area]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.notifAreaFilter = btn.dataset.nfArea;
    $$('[data-nf-area]').forEach((b) => b.classList.toggle('active', b === btn));
    if (state.data) renderNotifSectionLevels(state.data.review);
  });
});

// Filtros de la tabla completa de Gastos
$$('[data-exp-filter]').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.expGroupFilter = btn.dataset.expFilter;
    $$('[data-exp-filter]').forEach((b) => b.classList.toggle('active', b === btn));
    renderAllExpensesTable();
  });
});
if ($('#exp-search')) {
  $('#exp-search').addEventListener('input', (ev) => {
    state.expSearch = ev.target.value || '';
    renderAllExpensesTable();
  });
}

// Formulario gastos externos y botones de sincronización
$('#ext-kind').addEventListener('change', syncFormKind);
$('#ext-form').addEventListener('submit', addExternal);
if ($('#btn-update-top')) $('#btn-update-top').addEventListener('click', forceUpdate);
if ($('#btn-sync-fudo')) $('#btn-sync-fudo').addEventListener('click', () => syncFudo());
if ($('#fudo-creds-form')) {
  $('#fudo-creds-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(ev.currentTarget).entries());
    syncFudo(data);
  });
}

setInterval(() => { if (!document.hidden && state.from) load(true); }, 300000);

syncFormKind();
applyPreset('week');
checkRemoteVersion();
