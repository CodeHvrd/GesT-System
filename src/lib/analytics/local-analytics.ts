import {
  norm,
  normKey,
  normProvider,
  round,
  safeDiv,
  pctPoints,
  money,
  pct,
  signed,
  plural,
  parseNumber,
  parseIntSafe,
} from "../format";
import {
  currentWeek,
  monthLabel,
  prevMonth,
  prevWeek,
  sameWeekPrevMonth,
  weekBounds,
  weekIndex,
  weekKey,
  weekLabel,
  parseDate,
  todayAr,
} from "../dates";
import { loadConfig } from "../config";
import {
  queryAll,
  queryOne,
  executeSql,
  runTransaction,
  getSetting,
} from "../db/local-db";

export interface CategoryAggregate {
  categoria: string;
  key: string;
  ingreso: number;
  costo: number;
  ganancia: number;
  cmv_pct: number;
  pct_venta: number;
  cantidad: number;
  objetivo?: number | null;
  desvio_pp?: number | null;
  estado_cmv?: string;
  productos?: ProductItem[];
}

export interface ProductItem {
  producto: string;
  cantidad: number;
  ingreso: number;
  costo: number;
  ganancia: number;
  cmv_pct: number;
  precio_unit: number;
  costo_unit: number;
  margen_unit: number;
}

export interface DailySalesItem {
  fecha: string;
  ingreso: number;
  costo: number;
  ganancia: number;
  cmv_pct: number;
  lineas: number;
}

export interface AlertItem {
  nivel: "critico" | "atencion" | "info" | "ok";
  codigo: string;
  titulo: string;
  detalle: string;
  impacto?: number | null;
}

export function isFixedCategory(cat: string): boolean {
  const k = normKey(cat);
  if (!k) return false;
  if (
    ["fijo", "sueldo", "alquiler", "impuesto", "servicio", "luz", "gas", "internet", "contador", "monotributo", "seguro", "abl", "agua"].some(
      (w) => k.includes(w)
    )
  ) {
    return true;
  }
  const cfg = loadConfig();
  const fijos = (cfg.gastos_fijos_categorias || []).map((c) => normKey(c));
  return fijos.some((f) => f && (k === f || k.includes(f)));
}

export function weekStatus(wk: string) {
  const [start, end] = weekBounds(wk);
  const today = todayAr();
  const sRow = queryOne<{
    n: number;
    ing: number;
    cos: number;
    dias: number;
    d_min: string | null;
    d_max: string | null;
  }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(ingreso), 0) AS ing,
            COALESCE(SUM(costo), 0) AS cos,
            COUNT(DISTINCT CASE WHEN fecha != '' THEN fecha END) AS dias,
            MIN(CASE WHEN fecha != '' THEN fecha END) AS d_min,
            MAX(CASE WHEN fecha != '' THEN fecha END) AS d_max
     FROM sales WHERE semana_key = ?`,
    [wk]
  ) || { n: 0, ing: 0, cos: 0, dias: 0, d_min: null, d_max: null };

  const wh = queryOne<Record<string, unknown>>(
    "SELECT * FROM weekly_history WHERE semana_key = ?",
    [wk]
  );

  let expCount = 0;
  let expTotal = 0;
  let expDays = 0;
  if (start && end) {
    const eRow = queryOne<{ n: number; tot: number; dias: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS tot, COUNT(DISTINCT fecha) AS dias
       FROM expenses WHERE fecha BETWEEN ? AND ?`,
      [start, end]
    ) || { n: 0, tot: 0, dias: 0 };
    expCount = Number(eRow.n || 0);
    expTotal = Number(eRow.tot || 0);
    expDays = Number(eRow.dias || 0);
  }

  let totalDays = 7;
  let elapsedDays = 7;
  if (start && end) {
    const dStart = new Date(`${start}T00:00:00Z`);
    const dEnd = new Date(`${end}T00:00:00Z`);
    const dToday = new Date(`${today}T00:00:00Z`);
    totalDays = Math.round((dEnd.getTime() - dStart.getTime()) / 86400000) + 1;
    if (dToday < dStart) elapsedDays = 0;
    else if (dToday > dEnd) elapsedDays = totalDays;
    else elapsedDays = Math.round((dToday.getTime() - dStart.getTime()) / 86400000) + 1;
  }

  const hasDetail = Number(sRow.n || 0) > 0 && Number(sRow.ing || 0) > 0;
  const hasHistory = Boolean(
    wh && (Number(wh.ingreso || 0) > 0 || Number(wh.costo || 0) > 0)
  );
  const hasExpenses = expCount > 0;

  let estado: "vacia" | "futura" | "en_curso" | "parcial" | "completa" = "vacia";
  if (elapsedDays === 0 && !hasDetail && !hasHistory && !hasExpenses) {
    estado = "futura";
  } else if (!hasDetail && !hasHistory && !hasExpenses) {
    estado = "vacia";
  } else if (end && today <= end && today >= start) {
    estado = "en_curso";
  } else if (hasDetail || hasHistory) {
    estado = "completa";
  } else {
    estado = "parcial";
  }

  return {
    semana_key: wk,
    label: weekLabel(wk),
    inicio: start,
    fin: end,
    estado,
    dias_totales: totalDays,
    dias_transcurridos: elapsedDays,
    tiene_ventas_detalle: hasDetail,
    tiene_resumen_semanal: hasHistory,
    tiene_gastos: hasExpenses,
    lineas_venta: Number(sRow.n || 0),
    dias_con_venta: Number(sRow.dias || 0),
    venta_desde: sRow.d_min || "",
    venta_hasta: sRow.d_max || "",
    ingreso_ventas: round(Number(sRow.ing || (wh ? wh.ingreso : 0) || 0)),
    gastos_count: expCount,
    gastos_total: round(expTotal),
    dias_con_gasto: expDays,
  };
}

export function availableWeeks(): string[] {
  const keys = new Set<string>();
  keys.add(currentWeek());

  const sRows = queryAll<{ semana_key: string }>(
    "SELECT DISTINCT semana_key FROM sales WHERE semana_key != ''"
  );
  for (const r of sRows) keys.add(r.semana_key);

  const wRows = queryAll<{ semana_key: string }>(
    "SELECT DISTINCT semana_key FROM weekly_history WHERE semana_key != ''"
  );
  for (const r of wRows) keys.add(r.semana_key);

  const eRows = queryAll<{ fecha: string }>(
    "SELECT DISTINCT fecha FROM expenses WHERE fecha != ''"
  );
  for (const r of eRows) {
    const wk = weekKey(r.fecha);
    if (wk) keys.add(wk);
  }

  return Array.from(keys).filter(Boolean).sort().reverse();
}

export function defaultWeek(): string {
  const weeks = availableWeeks();
  const cur = currentWeek();
  const curSt = weekStatus(cur);
  if (
    curSt.tiene_ventas_detalle ||
    curSt.tiene_resumen_semanal ||
    curSt.tiene_gastos
  ) {
    return cur;
  }
  for (const wk of weeks) {
    const st = weekStatus(wk);
    if (st.tiene_ventas_detalle || st.tiene_resumen_semanal || st.tiene_gastos) {
      return wk;
    }
  }
  return cur;
}

export function weekCategories(wk: string): CategoryAggregate[] {
  const rows = queryAll<{
    categoria: string;
    categoria_key: string;
    ing: number;
    cos: number;
    gan: number;
    cant: number;
  }>(
    `SELECT categoria, categoria_key,
            SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan, SUM(cantidad) AS cant
     FROM sales
     WHERE semana_key = ?
     GROUP BY categoria_key
     ORDER BY ing DESC`,
    [wk]
  );

  const totalIng = rows.reduce((acc, r) => acc + Number(r.ing || 0), 0);
  return rows.map((r) => {
    const ing = Number(r.ing || 0);
    const cos = Number(r.cos || 0);
    const gan = Number(r.gan || ing - cos);
    return {
      categoria: r.categoria || "Sin categoría",
      key: r.categoria_key || normKey(r.categoria || "sin categoria"),
      ingreso: round(ing),
      costo: round(cos),
      ganancia: round(gan),
      cmv_pct: round(safeDiv(cos, ing), 4),
      pct_venta: round(safeDiv(ing, totalIng), 4),
      cantidad: round(Number(r.cant || 0), 1),
    };
  });
}

export function weekProducts(wk: string): Record<string, ProductItem[]> {
  const rows = queryAll<{
    categoria_key: string;
    producto: string;
    cant: number;
    ing: number;
    cos: number;
    gan: number;
  }>(
    `SELECT categoria_key, producto,
            SUM(cantidad) AS cant, SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan
     FROM sales
     WHERE semana_key = ?
     GROUP BY categoria_key, producto
     ORDER BY ing DESC`,
    [wk]
  );

  const byCat: Record<string, ProductItem[]> = {};
  for (const r of rows) {
    const ck = r.categoria_key || "sin categoria";
    if (!byCat[ck]) byCat[ck] = [];
    const cant = Number(r.cant || 0);
    const ing = Number(r.ing || 0);
    const cos = Number(r.cos || 0);
    const gan = Number(r.gan || ing - cos);
    const pu = cant > 0 ? ing / cant : 0;
    const cu = cant > 0 ? cos / cant : 0;
    byCat[ck].push({
      producto: r.producto || "(Sin nombre)",
      cantidad: round(cant, 1),
      ingreso: round(ing),
      costo: round(cos),
      ganancia: round(gan),
      cmv_pct: round(safeDiv(cos, ing), 4),
      precio_unit: round(pu),
      costo_unit: round(cu),
      margen_unit: round(pu - cu),
    });
  }
  return byCat;
}

export function weekDaily(wk: string): DailySalesItem[] {
  const rows = queryAll<{
    fecha: string;
    ing: number;
    cos: number;
    gan: number;
    n: number;
  }>(
    `SELECT fecha, SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan, COUNT(*) AS n
     FROM sales
     WHERE semana_key = ? AND fecha != ''
     GROUP BY fecha
     ORDER BY fecha ASC`,
    [wk]
  );

  return rows.map((r) => {
    const ing = Number(r.ing || 0);
    const cos = Number(r.cos || 0);
    const gan = Number(r.gan || ing - cos);
    return {
      fecha: r.fecha,
      ingreso: round(ing),
      costo: round(cos),
      ganancia: round(gan),
      cmv_pct: round(safeDiv(cos, ing), 4),
      lineas: Number(r.n || 0),
    };
  });
}

export function expensesRange(
  start: string,
  end: string,
  monthKeyFilter = ""
) {
  let rows: Array<Record<string, unknown>> = [];
  if (monthKeyFilter) {
    rows = queryAll<Record<string, unknown>>(
      `SELECT * FROM expenses
       WHERE mes_key = ? OR (mes_key = '' AND fecha BETWEEN ? AND ?)
       ORDER BY fecha DESC, id DESC`,
      [monthKeyFilter, start, end]
    );
  } else if (start && end) {
    rows = queryAll<Record<string, unknown>>(
      `SELECT * FROM expenses WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, id DESC`,
      [start, end]
    );
  }

  let total = 0;
  let fijos = 0;
  let reposicion = 0;
  const byCatMap = new Map<string, { categoria: string; monto: number; items: number; fijo: boolean }>();
  const byProvMap = new Map<string, { proveedor: string; monto: number; items: number }>();
  const byPayMap = new Map<string, { medio_pago: string; monto: number; items: number }>();

  for (const r of rows) {
    const monto = Number(r.monto || 0);
    const cat = String(r.categoria || "Sin categoría");
    const catK = String(r.categoria_key || normKey(cat));
    const prov = String(r.proveedor || "Sin proveedor");
    const provK = String(r.proveedor_key || normProvider(prov));
    const pay = String(r.medio_pago || "Sin especificar");
    const payK = normKey(pay);
    const fijo = isFixedCategory(cat);

    total += monto;
    if (fijo) fijos += monto;
    else reposicion += monto;

    const cEntry = byCatMap.get(catK) || { categoria: cat, monto: 0, items: 0, fijo };
    cEntry.monto += monto;
    cEntry.items += 1;
    byCatMap.set(catK, cEntry);

    const pEntry = byProvMap.get(provK) || { proveedor: prov, monto: 0, items: 0 };
    pEntry.monto += monto;
    pEntry.items += 1;
    byProvMap.set(provK, pEntry);

    const mEntry = byPayMap.get(payK) || { medio_pago: pay, monto: 0, items: 0 };
    mEntry.monto += monto;
    mEntry.items += 1;
    byPayMap.set(payK, mEntry);
  }

  const por_categoria = Array.from(byCatMap.values())
    .sort((a, b) => b.monto - a.monto)
    .map((x) => ({
      ...x,
      monto: round(x.monto),
      pct: round(safeDiv(x.monto, total), 4),
    }));

  const por_proveedor = Array.from(byProvMap.values())
    .sort((a, b) => b.monto - a.monto)
    .map((x) => ({
      ...x,
      monto: round(x.monto),
      pct: round(safeDiv(x.monto, total), 4),
    }));

  const por_medio_pago = Array.from(byPayMap.values())
    .sort((a, b) => b.monto - a.monto)
    .map((x) => ({
      ...x,
      monto: round(x.monto),
      pct: round(safeDiv(x.monto, total), 4),
    }));

  return {
    total: round(total),
    fijos: round(fijos),
    reposicion: round(reposicion),
    items: rows.length,
    por_categoria,
    por_proveedor,
    por_medio_pago,
    ultimos: rows.slice(0, 50),
  };
}

export function compare(actual: number, anterior: number) {
  const diff = actual - anterior;
  const pctChange = anterior !== 0 ? diff / Math.abs(anterior) : null;
  return {
    actual: round(actual),
    anterior: round(anterior),
    diff: round(diff),
    pct: pctChange !== null ? round(pctChange, 4) : null,
  };
}

export function attachTargets(cats: CategoryAggregate[]): CategoryAggregate[] {
  const cfg = loadConfig();
  const targets = cfg.cmv_objetivo_por_categoria || {};
  const defaultTarget = Number(cfg.cmv_objetivo_general || 0.35);

  return cats.map((c) => {
    let target: number | null = null;
    for (const [k, v] of Object.entries(targets)) {
      if (normKey(k) === c.key || c.key.includes(normKey(k))) {
        target = Number(v);
        break;
      }
    }
    if (target === null) target = defaultTarget;
    const desvio = (c.cmv_pct - target) * 100;
    let estado = "ok";
    if (desvio > 5) estado = "critico";
    else if (desvio > 2) estado = "atencion";
    else if (desvio < -10 && c.cmv_pct > 0) estado = "bajo";

    return {
      ...c,
      objetivo: round(target, 4),
      desvio_pp: round(desvio, 1),
      estado_cmv: estado,
    };
  });
}

export function weekSummaryMetrics(wk: string) {
  const [start, end] = weekBounds(wk);
  const cats = weekCategories(wk);
  const wh = queryOne<Record<string, unknown>>(
    "SELECT * FROM weekly_history WHERE semana_key = ?",
    [wk]
  );
  const exp = expensesRange(start, end);

  let ing = cats.reduce((a, c) => a + c.ingreso, 0);
  let cos = cats.reduce((a, c) => a + c.costo, 0);
  let gan = cats.reduce((a, c) => a + c.ganancia, 0);
  let fuente = "ventas_detalle";

  if (ing === 0 && wh && Number(wh.ingreso || 0) > 0) {
    ing = Number(wh.ingreso || 0);
    cos = Number(wh.costo || 0);
    gan = Number(wh.ganancia || ing - cos);
    fuente = "historial_semanal";
  }

  const gastosOp = exp.total > 0 ? exp.total : wh ? Number(wh.gastos || 0) : 0;
  const cmvPct = safeDiv(cos, ing);
  const margenBrutoPct = safeDiv(gan, ing);
  const gananciaNeta = gan - exp.fijos;
  const gananciaCaja = ing - exp.total;
  const ratioRepoCmv = safeDiv(exp.reposicion, cos);

  return {
    semana_key: wk,
    label: weekLabel(wk),
    inicio: start,
    fin: end,
    fuente,
    ingreso: round(ing),
    costo: round(cos),
    ganancia_bruta: round(gan),
    cmv_pct: round(cmvPct, 4),
    margen_bruto_pct: round(margenBrutoPct, 4),
    gastos_total: round(gastosOp),
    gastos_reposicion: round(exp.reposicion),
    gastos_fijos: round(exp.fijos),
    ganancia_neta: round(gananciaNeta),
    margen_neto_pct: round(safeDiv(gananciaNeta, ing), 4),
    ganancia_caja: round(gananciaCaja),
    margen_caja_pct: round(safeDiv(gananciaCaja, ing), 4),
    ratio_reposicion_cmv: round(ratioRepoCmv, 4),
    diferencia_reposicion_cmv: round(exp.reposicion - cos),
    observaciones: wh ? String(wh.observaciones || "") : "",
    historial: wh || null,
    expenses: exp,
    categorias: attachTargets(cats),
  };
}

export function buildAlerts(wk: string): AlertItem[] {
  const alerts: AlertItem[] = [];
  const cfg = loadConfig();
  const st = weekStatus(wk);
  const cur = weekSummaryMetrics(wk);
  const prevWk = prevWeek(wk);
  const prev = weekSummaryMetrics(prevWk);
  const prodsByCat = weekProducts(wk);
  const daily = weekDaily(wk);

  // 1. Sin datos
  if (!st.tiene_ventas_detalle && !st.tiene_resumen_semanal && !st.tiene_gastos) {
    alerts.push({
      nivel: "atencion",
      codigo: "sin-datos",
      titulo: `Sin datos cargados en ${st.label}`,
      detalle: "No se encontraron ventas ni gastos registrados para esta semana.",
    });
    return alerts;
  }

  // 2. Ventas días faltantes
  if (st.tiene_ventas_detalle && st.dias_con_venta > 0 && st.dias_con_venta < 5 && st.estado === "completa") {
    alerts.push({
      nivel: "atencion",
      codigo: "ventas-dias",
      titulo: `Solo ${st.dias_con_venta} ${plural(st.dias_con_venta, "día", "días")} con ventas en ${st.label}`,
      detalle: `Se registraron ventas entre ${st.venta_desde} y ${st.venta_hasta}. Verificá si faltan cierres por exportar desde Fudo.`,
    });
  }

  // 3. Variación de ventas semana vs semana anterior (normalizada por días para evitar distorsiones entre semanas completas y fracciones como S5)
  if (cur.ingreso > 0 && prev.ingreso > 0) {
    const curDays = Math.max(1, Math.round((new Date(`${cur.fin}T00:00:00Z`).getTime() - new Date(`${cur.inicio}T00:00:00Z`).getTime()) / 86400000) + 1);
    const prevDays = Math.max(1, Math.round((new Date(`${prev.fin}T00:00:00Z`).getTime() - new Date(`${prev.inicio}T00:00:00Z`).getTime()) / 86400000) + 1);
    const curDailyAvg = cur.ingreso / curDays;
    const prevDailyAvg = prev.ingreso / prevDays;
    const isMismatch = curDays !== prevDays;
    const chg = isMismatch
      ? (curDailyAvg - prevDailyAvg) / prevDailyAvg
      : (cur.ingreso - prev.ingreso) / prev.ingreso;

    if (chg <= -Number(cfg.alerta_caida_ventas_pct || 0.15)) {
      alerts.push({
        nivel: "critico",
        codigo: "ventas-semana",
        titulo: `Caída de ventas de ${pct(Math.abs(chg))} vs ${prev.label}${isMismatch ? " (promedio diario)" : ""}`,
        detalle: isMismatch
          ? `Promedio diario pasó de ${money(prevDailyAvg)} (${prevDays} d) a ${money(curDailyAvg)} (${curDays} d). Facturación total: ${money(prev.ingreso)} vs ${money(cur.ingreso)}.`
          : `Ingresos pasaron de ${money(prev.ingreso)} a ${money(cur.ingreso)} (${signed(cur.ingreso - prev.ingreso, money)}).`,
        impacto: round(cur.ingreso - prev.ingreso),
      });
    } else if (chg >= 0.15) {
      alerts.push({
        nivel: "ok",
        codigo: "ventas-semana",
        titulo: `Suba de ventas de ${pct(chg)} vs ${prev.label}${isMismatch ? " (promedio diario)" : ""}`,
        detalle: isMismatch
          ? `Promedio diario creció de ${money(prevDailyAvg)} (${prevDays} d) a ${money(curDailyAvg)} (${curDays} d). Facturación total: ${money(prev.ingreso)} vs ${money(cur.ingreso)}.`
          : `Ingresos crecieron de ${money(prev.ingreso)} a ${money(cur.ingreso)} (+${money(cur.ingreso - prev.ingreso)}).`,
        impacto: round(cur.ingreso - prev.ingreso),
      });
    }
  }

  // 4. Productos sin costear
  const uncosted: ProductItem[] = [];
  for (const list of Object.values(prodsByCat)) {
    for (const p of list) {
      if (p.ingreso > 0 && p.costo === 0) uncosted.push(p);
    }
  }
  if (uncosted.length > 0) {
    const totalUncostedIng = uncosted.reduce((a, p) => a + p.ingreso, 0);
    const names = uncosted.slice(0, 4).map((p) => p.producto).join(", ");
    alerts.push({
      nivel: totalUncostedIng > cur.ingreso * 0.05 ? "critico" : "atencion",
      codigo: "sin-costear",
      titulo: `${uncosted.length} ${plural(uncosted.length, "producto vendido", "productos vendidos")} con costo $0`,
      detalle: `Representan ${money(totalUncostedIng)} (${pct(safeDiv(totalUncostedIng, cur.ingreso))} de la venta): ${names}${uncosted.length > 4 ? "..." : ""}. distorsionan el CMV real.`,
      impacto: round(totalUncostedIng),
    });
  }

  // 5. CMV general vs objetivo y suba vs semana previa
  const targetGral = Number(cfg.cmv_objetivo_general || 0.35);
  if (cur.ingreso > 0) {
    if (cur.cmv_pct > targetGral + 0.03) {
      const sobrecosto = (cur.cmv_pct - targetGral) * cur.ingreso;
      alerts.push({
        nivel: "critico",
        codigo: "cmv-objetivo",
        titulo: `CMV general en ${pct(cur.cmv_pct)} (objetivo ${pct(targetGral)})`,
        detalle: `El costo de mercadería supera la meta por ${pctPoints(cur.cmv_pct - targetGral)}, equivalente a ${money(sobrecosto)} de sobrecosto en la semana.`,
        impacto: round(-sobrecosto),
      });
    }
    if (prev.ingreso > 0) {
      const diffPts = (cur.cmv_pct - prev.cmv_pct) * 100;
      if (diffPts >= Number(cfg.alerta_suba_cmv_puntos || 3)) {
        alerts.push({
          nivel: "atencion",
          codigo: "cmv-alza",
          titulo: `Suba de CMV de +${round(diffPts, 1)} pp vs semana anterior`,
          detalle: `Pasó de ${pct(prev.cmv_pct)} en ${prev.label} a ${pct(cur.cmv_pct)} en ${cur.label}.`,
        });
      }
    }
  }

  // 6. Categorías por encima del objetivo CMV
  for (const c of cur.categorias) {
    if (c.estado_cmv === "critico" && c.ingreso > cur.ingreso * 0.03) {
      const obj = c.objetivo || targetGral;
      const impacto = (c.cmv_pct - obj) * c.ingreso;
      alerts.push({
        nivel: "atencion",
        codigo: "cmv-categoria",
        titulo: `CMV elevado en ${c.categoria}: ${pct(c.cmv_pct)} (meta ${pct(obj)})`,
        detalle: `Desvío de +${c.desvio_pp} pp sobre ventas de ${money(c.ingreso)} (sobrecosto aprox. ${money(impacto)}).`,
        impacto: round(-impacto),
      });
    }
  }

  // 7. Categorías desaparecidas o con caída fuerte
  if (prev.categorias.length > 0 && cur.categorias.length > 0) {
    const curMap = new Map(cur.categorias.map((c) => [c.key, c]));
    for (const pc of prev.categorias) {
      if (pc.ingreso < prev.ingreso * 0.03) continue;
      const cc = curMap.get(pc.key);
      if (!cc || cc.ingreso === 0) {
        alerts.push({
          nivel: "atencion",
          codigo: "cats-desaparecidas",
          titulo: `Categoría sin ventas: ${pc.categoria}`,
          detalle: `En ${prev.label} facturó ${money(pc.ingreso)} y esta semana no registra movimientos.`,
          impacto: round(-pc.ingreso),
        });
      } else {
        const drop = (cc.ingreso - pc.ingreso) / pc.ingreso;
        if (drop <= -0.35) {
          alerts.push({
            nivel: "info",
            codigo: "cats-caida",
            titulo: `Caída en ${cc.categoria}: ${pct(Math.abs(drop))}`,
            detalle: `Pasó de ${money(pc.ingreso)} a ${money(cc.ingreso)} (${signed(cc.ingreso - pc.ingreso, money)}).`,
          });
        }
      }
    }
  }

  // 8. Desvío entre compras de reposición y CMV teórico
  if (cur.costo > 0 && cur.gastos_reposicion > 0) {
    const ratio = cur.ratio_reposicion_cmv;
    if (ratio > 1.35) {
      alerts.push({
        nivel: "atencion",
        codigo: "cierres-desvio",
        titulo: `Compras de reposición superan en ${pct(ratio - 1)} al CMV teórico`,
        detalle: `Se compró mercadería por ${money(cur.gastos_reposicion)} frente a un CMV por recetas de ${money(cur.costo)} (+${money(cur.diferencia_reposicion_cmv)}). Puede indicar acopio de stock, merma o sub-costeo en recetas.`,
        impacto: round(-cur.diferencia_reposicion_cmv),
      });
    }
  }

  // 9. Posibles gastos duplicados en la semana
  if (cur.inicio && cur.fin) {
    const dups = queryAll<{
      fecha: string;
      proveedor: string;
      monto: number;
      n: number;
    }>(
      `SELECT fecha, proveedor, monto, COUNT(*) AS n
       FROM expenses
       WHERE fecha BETWEEN ? AND ? AND monto > 0
       GROUP BY fecha, proveedor_key, ROUND(monto, 0)
       HAVING COUNT(*) > 1`,
      [cur.inicio, cur.fin]
    );
    if (dups.length > 0) {
      const totDup = dups.reduce((a, d) => a + Number(d.monto || 0) * (Number(d.n) - 1), 0);
      alerts.push({
        nivel: "atencion",
        codigo: "duplicados",
        titulo: `${dups.length} ${plural(dups.length, "posible gasto duplicado", "posibles gastos duplicados")}`,
        detalle: `Misma fecha, proveedor y monto (ej. ${dups[0].proveedor} por ${money(dups[0].monto)} el ${dups[0].fecha}). Revisar pestaña Calidad de datos.`,
        impacto: round(-totDup),
      });
    }
  }

  // 10. Sin observaciones en el cierre semanal
  if ((st.tiene_ventas_detalle || st.tiene_resumen_semanal) && !cur.observaciones && daily.length > 0) {
    alerts.push({
      nivel: "info",
      codigo: "sin-observaciones",
      titulo: "Semana sin notas u observaciones en el historial",
      detalle: "Agregar comentarios semanales ayuda a recordar feriados, eventos o aumentos de proveedores.",
    });
  }

  return alerts;
}

export function weekNarrative(
  cur: ReturnType<typeof weekSummaryMetrics>,
  prev: ReturnType<typeof weekSummaryMetrics>,
  alerts: AlertItem[]
): string[] {
  const lines: string[] = [];
  if (cur.ingreso === 0 && cur.gastos_total === 0) {
    return [`No hay ventas ni gastos registrados todavía para ${cur.label}.`];
  }

  if (cur.ingreso > 0) {
    let l1 = `En **${cur.label}** las ventas sumaron **${money(cur.ingreso)}** con un CMV teórico de **${money(cur.costo)}** (**${pct(cur.cmv_pct)}**) y una ganancia bruta de **${money(cur.ganancia_bruta)}** (**${pct(cur.margen_bruto_pct)}**).`;
    if (prev.ingreso > 0) {
      const curDays = Math.max(1, Math.round((new Date(`${cur.fin}T00:00:00Z`).getTime() - new Date(`${cur.inicio}T00:00:00Z`).getTime()) / 86400000) + 1);
      const prevDays = Math.max(1, Math.round((new Date(`${prev.fin}T00:00:00Z`).getTime() - new Date(`${prev.inicio}T00:00:00Z`).getTime()) / 86400000) + 1);

      if (curDays !== prevDays) {
        const curAvg = cur.ingreso / curDays;
        const prevAvg = prev.ingreso / prevDays;
        const diffAvgPct = (curAvg - prevAvg) / prevAvg;
        l1 += ` Respecto a ${prev.label} (${money(prev.ingreso)} en ${prevDays} días, promedio ${money(prevAvg)}/día), el promedio diario (${money(curAvg)}/día en ${curDays} días) varió **${signed(diffAvgPct, pct)}** (comparación normalizada por días).`;
      } else {
        const diffPct = (cur.ingreso - prev.ingreso) / prev.ingreso;
        l1 += ` Respecto a ${prev.label} (${money(prev.ingreso)}), la facturación varió **${signed(diffPct, pct)}**.`;
      }
    }
    lines.push(l1);
  }

  if (cur.categorias.length > 0) {
    const top = cur.categorias.slice(0, 3);
    const topStr = top
      .map((c) => `${c.categoria} (${pct(c.pct_venta)} de la venta, CMV ${pct(c.cmv_pct)})`)
      .join(", ");
    lines.push(`Las principales categorías fueron: ${topStr}.`);
  }

  if (cur.gastos_total > 0) {
    lines.push(
      `Los gastos registrados en caja totalizaron **${money(cur.gastos_total)}** (${money(cur.gastos_reposicion)} de reposición/proveedores y ${money(cur.gastos_fijos)} de gastos fijos), dejando un flujo de caja neto de **${money(cur.ganancia_caja)}**.`
    );
  }

  const crit = alerts.filter((a) => a.nivel === "critico");
  if (crit.length > 0) {
    lines.push(`Atención prioritaria: ${crit.map((c) => c.titulo).join(" · ")}.`);
  }

  return lines;
}

export function buildWeekReport(wk?: string) {
  const targetWk = wk || defaultWeek();
  const status = weekStatus(targetWk);
  const cur = weekSummaryMetrics(targetWk);
  const prevWk = prevWeek(targetWk);
  const prev = weekSummaryMetrics(prevWk);
  const samePrevM = sameWeekPrevMonth(targetWk);
  const prevMonthSameWk = samePrevM ? weekSummaryMetrics(samePrevM) : null;

  const curDays = Math.max(1, Math.round((new Date(`${cur.fin}T00:00:00Z`).getTime() - new Date(`${cur.inicio}T00:00:00Z`).getTime()) / 86400000) + 1);
  const prevDays = Math.max(1, Math.round((new Date(`${prev.fin}T00:00:00Z`).getTime() - new Date(`${prev.inicio}T00:00:00Z`).getTime()) / 86400000) + 1);
  const curDailyAvg = cur.ingreso / curDays;
  const prevDailyAvg = prev.ingreso / prevDays;

  const productsByCat = weekProducts(targetWk);
  const categorias = cur.categorias.map((c) => {
    const prods = (productsByCat[c.key] || []).sort((a, b) => b.ingreso - a.ingreso);
    return {
      ...c,
      productos: prods,
      productos_estrella: prods.slice(0, 5),
    };
  });

  // Categoría con mayor CMV % (con ventas representativas > 0)
  const catsWithCmv = [...categorias].filter((c) => c.ingreso > 0 && c.cmv_pct > 0);
  catsWithCmv.sort((a, b) => b.cmv_pct - a.cmv_pct);
  const maxCmvCategoria = catsWithCmv.length > 0 ? catsWithCmv[0] : null;

  // Gastos Fudo específicos de la semana (insumos y materia prima)
  const fudoExpenses = (cur.expenses?.por_categoria || [])
    .filter((c) => !c.fijo)
    .sort((a, b) => b.monto - a.monto);

  const allProds: ProductItem[] = [];
  for (const list of Object.values(productsByCat)) {
    allProds.push(...list);
  }
  const topProductos = [...allProds].sort((a, b) => b.ingreso - a.ingreso).slice(0, 15);
  const topRentables = [...allProds].sort((a, b) => b.ganancia - a.ganancia).slice(0, 15);

  const daily = weekDaily(targetWk);
  const alerts = buildAlerts(targetWk);
  const narrativa = weekNarrative(cur, prev, alerts);

  return {
    semana_key: targetWk,
    label: cur.label,
    inicio: cur.inicio,
    fin: cur.fin,
    dias_totales: curDays,
    status,
    resumen: {
      ingreso: cur.ingreso,
      ingreso_promedio_diario: round(curDailyAvg),
      dias_totales: curDays,
      costo: cur.costo,
      ganancia_bruta: cur.ganancia_bruta,
      cmv_pct: cur.cmv_pct,
      margen_bruto_pct: cur.margen_bruto_pct,
      gastos_total: cur.gastos_total,
      gastos_reposicion: cur.gastos_reposicion,
      gastos_fijos: cur.gastos_fijos,
      ganancia_neta: cur.ganancia_neta,
      margen_neto_pct: cur.margen_neto_pct,
      ganancia_caja: cur.ganancia_caja,
      margen_caja_pct: cur.margen_caja_pct,
      ratio_reposicion_cmv: cur.ratio_reposicion_cmv,
      diferencia_reposicion_cmv: cur.diferencia_reposicion_cmv,
      observaciones: cur.observaciones,
      fuente: cur.fuente,
    },
    comparacion: {
      semana_anterior: {
        semana_key: prevWk,
        label: prev.label,
        dias_actual: curDays,
        dias_anterior: prevDays,
        mismatch_dias: curDays !== prevDays,
        ingreso: compare(cur.ingreso, prev.ingreso),
        promedio_diario: compare(curDailyAvg, prevDailyAvg),
        costo: compare(cur.costo, prev.costo),
        ganancia_bruta: compare(cur.ganancia_bruta, prev.ganancia_bruta),
        cmv_pct: compare(cur.cmv_pct, prev.cmv_pct),
        gastos_total: compare(cur.gastos_total, prev.gastos_total),
        ganancia_caja: compare(cur.ganancia_caja, prev.ganancia_caja),
      },
      misma_semana_mes_anterior: prevMonthSameWk
        ? {
            semana_key: samePrevM,
            label: prevMonthSameWk.label,
            ingreso: compare(cur.ingreso, prevMonthSameWk.ingreso),
            ganancia_bruta: compare(cur.ganancia_bruta, prevMonthSameWk.ganancia_bruta),
            cmv_pct: compare(cur.cmv_pct, prevMonthSameWk.cmv_pct),
          }
        : null,
    },
    categorias,
    max_cmv_categoria: maxCmvCategoria,
    gastos_fudo: {
      total: round(cur.gastos_reposicion),
      items: fudoExpenses,
    },
    top_productos: topProductos,
    top_rentables: topRentables,
    diario: daily,
    gastos: cur.expenses,
    alertas: alerts,
    narrativa,
    semanas_disponibles: availableWeeks().map((k) => ({
      key: k,
      label: weekLabel(k),
    })),
  };
}

export function monthKeys(): string[] {
  const keys = new Set<string>();
  keys.add(todayAr().slice(0, 7));

  for (const r of queryAll<{ m: string }>(
    "SELECT DISTINCT SUBSTR(semana_key, 1, 7) AS m FROM sales WHERE LENGTH(semana_key) >= 7"
  )) {
    if (r.m) keys.add(r.m);
  }
  for (const r of queryAll<{ mes_key: string }>(
    "SELECT DISTINCT mes_key FROM weekly_history WHERE mes_key != ''"
  )) {
    if (r.mes_key) keys.add(r.mes_key);
  }
  for (const r of queryAll<{ mes_key: string }>(
    "SELECT DISTINCT mes_key FROM monthly_history WHERE mes_key != ''"
  )) {
    if (r.mes_key) keys.add(r.mes_key);
  }
  for (const r of queryAll<{ mes_key: string }>(
    "SELECT DISTINCT mes_key FROM expenses WHERE mes_key != ''"
  )) {
    if (r.mes_key) keys.add(r.mes_key);
  }

  return Array.from(keys).filter(Boolean).sort().reverse();
}

export function monthWeekKeys(mk: string): string[] {
  return [1, 2, 3, 4, 5].map((i) => `${mk}-S${i}`);
}

export function monthCategories(mk: string): CategoryAggregate[] {
  const rows = queryAll<{
    categoria: string;
    categoria_key: string;
    ing: number;
    cos: number;
    gan: number;
    cant: number;
  }>(
    `SELECT categoria, categoria_key,
            SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan, SUM(cantidad) AS cant
     FROM sales
     WHERE semana_key LIKE ?
     GROUP BY categoria_key
     ORDER BY ing DESC`,
    [`${mk}-%`]
  );

  const totalIng = rows.reduce((a, r) => a + Number(r.ing || 0), 0);
  const rawCats: CategoryAggregate[] = rows.map((r) => {
    const ing = Number(r.ing || 0);
    const cos = Number(r.cos || 0);
    const gan = Number(r.gan || ing - cos);
    return {
      categoria: r.categoria || "Sin categoría",
      key: r.categoria_key || normKey(r.categoria || "sin categoria"),
      ingreso: round(ing),
      costo: round(cos),
      ganancia: round(gan),
      cmv_pct: round(safeDiv(cos, ing), 4),
      pct_venta: round(safeDiv(ing, totalIng), 4),
      cantidad: round(Number(r.cant || 0), 1),
    };
  });

  return attachTargets(rawCats);
}

export function monthTotals(mk: string) {
  const [y, m] = mk.split("-").map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const start = `${mk}-01`;
  const end = `${mk}-${String(lastDay).padStart(2, "0")}`;

  const weeks = monthWeekKeys(mk).map((wk) => weekSummaryMetrics(wk));
  const activeWeeks = weeks.filter(
    (w) => w.ingreso > 0 || w.costo > 0 || w.gastos_total > 0
  );

  const mh = queryOne<Record<string, unknown>>(
    "SELECT * FROM monthly_history WHERE mes_key = ?",
    [mk]
  );
  const exp = expensesRange(start, end, mk);
  const cats = monthCategories(mk);

  let ing = activeWeeks.reduce((a, w) => a + w.ingreso, 0);
  let cos = activeWeeks.reduce((a, w) => a + w.costo, 0);
  let gan = activeWeeks.reduce((a, w) => a + w.ganancia_bruta, 0);
  let fuente = "semanas";

  if (ing === 0 && mh && Number(mh.ingreso || 0) > 0) {
    ing = Number(mh.ingreso || 0);
    cos = Number(mh.costo || 0);
    gan = Number(mh.ganancia || ing - cos);
    fuente = "historial_mensual";
  }

  const gastosTotal =
    exp.total > 0 ? exp.total : mh ? Number(mh.gastos || 0) : activeWeeks.reduce((a, w) => a + w.gastos_total, 0);
  const gananciaNeta = gan - exp.fijos;
  const gananciaCaja = ing - gastosTotal;

  return {
    mes_key: mk,
    label: monthLabel(mk),
    inicio: start,
    fin: end,
    fuente,
    ingreso: round(ing),
    costo: round(cos),
    ganancia_bruta: round(gan),
    cmv_pct: round(safeDiv(cos, ing), 4),
    margen_bruto_pct: round(safeDiv(gan, ing), 4),
    gastos_total: round(gastosTotal),
    gastos_reposicion: round(exp.reposicion),
    gastos_fijos: round(exp.fijos),
    ganancia_neta: round(gananciaNeta),
    margen_neto_pct: round(safeDiv(gananciaNeta, ing), 4),
    ganancia_caja: round(gananciaCaja),
    margen_caja_pct: round(safeDiv(gananciaCaja, ing), 4),
    semanas: weeks,
    categorias: cats,
    gastos: exp,
    historial_mensual: mh || null,
  };
}

export function buildMonthReport(mk?: string) {
  const avail = monthKeys();
  const targetMk = mk || avail[0] || todayAr().slice(0, 7);
  const cur = monthTotals(targetMk);
  const prevMk = prevMonth(targetMk);
  const prev = monthTotals(prevMk);

  const narrativa: string[] = [];
  if (cur.ingreso > 0) {
    narrativa.push(
      `En **${cur.label}** la facturación acumulada es de **${money(cur.ingreso)}** con un CMV de **${money(cur.costo)}** (**${pct(cur.cmv_pct)}**) y ganancia bruta de **${money(cur.ganancia_bruta)}**.`
    );
  }
  if (cur.gastos_total > 0) {
    narrativa.push(
      `Los gastos del mes suman **${money(cur.gastos_total)}** (${money(cur.gastos_reposicion)} en mercadería/proveedores y ${money(cur.gastos_fijos)} en estructura fija), resultando en un resultado neto operativo de **${money(cur.ganancia_neta)}** y caja neta de **${money(cur.ganancia_caja)}**.`
    );
  }

  return {
    ...cur,
    comparacion: {
      mes_anterior: {
        mes_key: prevMk,
        label: prev.label,
        ingreso: compare(cur.ingreso, prev.ingreso),
        costo: compare(cur.costo, prev.costo),
        ganancia_bruta: compare(cur.ganancia_bruta, prev.ganancia_bruta),
        cmv_pct: compare(cur.cmv_pct, prev.cmv_pct),
        gastos_total: compare(cur.gastos_total, prev.gastos_total),
        ganancia_neta: compare(cur.ganancia_neta, prev.ganancia_neta),
        ganancia_caja: compare(cur.ganancia_caja, prev.ganancia_caja),
      },
    },
    narrativa,
    meses_disponibles: avail.map((k) => ({ key: k, label: monthLabel(k) })),
  };
}

export function weeklySeries(limit = 16) {
  const weeks = availableWeeks().slice(0, limit).reverse();
  return weeks.map((wk) => {
    const m = weekSummaryMetrics(wk);
    return {
      semana_key: wk,
      label: m.label,
      ingreso: m.ingreso,
      costo: m.costo,
      ganancia_bruta: m.ganancia_bruta,
      cmv_pct: m.cmv_pct,
      gastos_total: m.gastos_total,
      ganancia_caja: m.ganancia_caja,
    };
  });
}

export function monthlySeries(limit = 12) {
  const months = monthKeys().slice(0, limit).reverse();
  return months.map((mk) => {
    const m = monthTotals(mk);
    return {
      mes_key: mk,
      label: m.label,
      ingreso: m.ingreso,
      costo: m.costo,
      ganancia_bruta: m.ganancia_bruta,
      cmv_pct: m.cmv_pct,
      gastos_total: m.gastos_total,
      ganancia_neta: m.ganancia_neta,
      ganancia_caja: m.ganancia_caja,
    };
  });
}

export function buildOverview(wk?: string) {
  const targetWk = wk || defaultWeek();
  const weekRep = buildWeekReport(targetWk);
  const mk = targetWk.slice(0, 7);
  const monthRep = buildMonthReport(mk);
  const counts = {
    sales: Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sales")?.n || 0),
    expenses: Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM expenses")?.n || 0),
    weekly: Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM weekly_history")?.n || 0),
    monthly: Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM monthly_history")?.n || 0),
    entries_pending: Number(
      queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM entries WHERE estado = 'pendiente'")?.n || 0
    ),
  };

  return {
    semana_actual: weekRep,
    mes_actual: monthRep,
    serie_semanal: weeklySeries(12),
    serie_mensual: monthlySeries(12),
    counts,
    last_sync: getSetting("last_sync") || null,
  };
}

export function listExpenses(params: {
  mes?: string;
  semana?: string;
  categoria?: string;
  proveedor?: string;
  medio_pago?: string;
  q?: string;
  limit?: number;
}) {
  const where: string[] = [];
  const args: Array<string | number> = [];

  if (params.mes) {
    where.push("mes_key = ?");
    args.push(params.mes);
  }
  if (params.semana) {
    const [s, e] = weekBounds(params.semana);
    if (s && e) {
      where.push("fecha BETWEEN ? AND ?");
      args.push(s, e);
    }
  }
  if (params.categoria) {
    where.push("categoria_key = ?");
    args.push(normKey(params.categoria));
  }
  if (params.proveedor) {
    where.push("proveedor_key = ?");
    args.push(normProvider(params.proveedor));
  }
  if (params.medio_pago) {
    where.push("LOWER(medio_pago) = ?");
    args.push(norm(params.medio_pago).toLowerCase());
  }
  if (params.q) {
    const qLike = `%${norm(params.q).toLowerCase()}%`;
    where.push(
      "(LOWER(descripcion) LIKE ? OR LOWER(proveedor) LIKE ? OR LOWER(categoria) LIKE ? OR LOWER(comprobante) LIKE ?)"
    );
    args.push(qLike, qLike, qLike, qLike);
  }

  const limit = Math.min(Math.max(Number(params.limit || 300), 1), 2000);
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

  const rows = queryAll<Record<string, unknown>>(
    `SELECT * FROM expenses ${whereClause} ORDER BY fecha DESC, id DESC LIMIT ?`,
    [...args, limit]
  );

  const totRow = queryOne<{ n: number; tot: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(monto), 0) AS tot FROM expenses ${whereClause}`,
    args
  ) || { n: 0, tot: 0 };

  const cats = queryAll<{ categoria: string }>(
    "SELECT DISTINCT categoria FROM expenses WHERE categoria != '' ORDER BY categoria"
  ).map((r) => r.categoria);

  const provs = queryAll<{ proveedor: string }>(
    "SELECT DISTINCT proveedor FROM expenses WHERE proveedor != '' ORDER BY proveedor"
  ).map((r) => r.proveedor);

  const medios = queryAll<{ medio_pago: string }>(
    "SELECT DISTINCT medio_pago FROM expenses WHERE medio_pago != '' ORDER BY medio_pago"
  ).map((r) => r.medio_pago);

  return {
    items: rows,
    total_count: Number(totRow.n || 0),
    total_monto: round(Number(totRow.tot || 0)),
    filtros: {
      categorias: cats,
      proveedores: provs,
      medios_pago: medios,
      meses: monthKeys(),
      semanas: availableWeeks(),
    },
  };
}

export function dataIssues() {
  const sinFecha = queryAll<Record<string, unknown>>(
    "SELECT * FROM expenses WHERE fecha = '' ORDER BY fila_origen ASC LIMIT 100"
  );
  const sinMonto = queryAll<Record<string, unknown>>(
    "SELECT * FROM expenses WHERE monto <= 0 ORDER BY fila_origen ASC LIMIT 100"
  );
  const sinCategoria = queryAll<Record<string, unknown>>(
    "SELECT * FROM expenses WHERE categoria = '' OR categoria_key = 'sin categoria' ORDER BY fecha DESC LIMIT 100"
  );
  const duplicados = queryAll<Record<string, unknown>>(
    `SELECT fecha, proveedor, categoria, monto, COUNT(*) AS repeticiones, GROUP_CONCAT(fila_origen) AS filas
     FROM expenses
     WHERE fecha != '' AND monto > 0
     GROUP BY fecha, proveedor_key, categoria_key, ROUND(monto, 0)
     HAVING COUNT(*) > 1
     ORDER BY fecha DESC
     LIMIT 100`
  );
  const desajusteMes = queryAll<Record<string, unknown>>(
    `SELECT * FROM expenses
     WHERE fecha != '' AND mes_key != '' AND SUBSTR(fecha, 1, 7) != mes_key
     ORDER BY fecha DESC LIMIT 100`
  );

  return {
    resumen: {
      sin_fecha: sinFecha.length,
      sin_monto: sinMonto.length,
      sin_categoria: sinCategoria.length,
      duplicados: duplicados.length,
      desajuste_mes: desajusteMes.length,
      total_alertas:
        sinFecha.length +
        sinMonto.length +
        sinCategoria.length +
        duplicados.length +
        desajusteMes.length,
    },
    sin_fecha: sinFecha,
    sin_monto: sinMonto,
    sin_categoria: sinCategoria,
    duplicados,
    desajuste_mes: desajusteMes,
  };
}

export function suggest(providerQuery = "") {
  const provs = queryAll<{
    proveedor: string;
    proveedor_key: string;
    categoria: string;
    medio_pago: string;
    n: number;
    ult_monto: number;
  }>(
    `SELECT proveedor, proveedor_key, categoria, medio_pago, COUNT(*) AS n, MAX(monto) AS ult_monto
     FROM expenses
     WHERE proveedor != ''
     GROUP BY proveedor_key
     ORDER BY n DESC
     LIMIT 150`
  );

  const cats = queryAll<{ categoria: string }>(
    "SELECT DISTINCT categoria FROM expenses WHERE categoria != '' ORDER BY categoria"
  ).map((r) => r.categoria);

  const medios = queryAll<{ medio_pago: string }>(
    "SELECT DISTINCT medio_pago FROM expenses WHERE medio_pago != '' ORDER BY medio_pago"
  ).map((r) => r.medio_pago);

  let match: Record<string, unknown> | null = null;
  if (providerQuery) {
    const pk = normProvider(providerQuery);
    const found = provs.find(
      (p) => p.proveedor_key === pk || p.proveedor_key.includes(pk)
    );
    if (found) match = found;
  }

  return {
    proveedores: provs,
    categorias: cats,
    medios_pago: medios.length > 0 ? medios : ["Efectivo", "Transferencia", "Tarjeta", "MercadoPago"],
    sugerencia: match,
  };
}

export function createEntry(input: Record<string, unknown>) {
  const rawFecha = norm(input.fecha) || todayAr();
  const fecha = parseDate(rawFecha) || todayAr();
  const mesKey = norm(input.mes) || fecha.slice(0, 7);
  const proveedor = norm(input.proveedor);
  const categoria = norm(input.categoria) || "Mercadería";
  const descripcion = norm(input.descripcion);
  const monto = parseNumber(input.monto);
  const cantidad = parseNumber(input.cantidad || 1) || 1;
  const medioPago = norm(input.medio_pago) || "Efectivo";
  const comprobante = norm(input.comprobante);
  const creadoEn = new Date().toISOString();

  if (monto <= 0) {
    return { ok: false, error: "El monto debe ser mayor a 0." };
  }

  return runTransaction(() => {
    const res = executeSql(
      `INSERT INTO entries (
        creado_en, fecha, mes, proveedor, categoria, descripcion, monto, cantidad, medio_pago, comprobante, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
      [creadoEn, fecha, mesKey, proveedor, categoria, descripcion, monto, cantidad, medioPago, comprobante]
    );
    const entryId = Number(res.lastInsertRowid);

    executeSql(
      `INSERT INTO expenses (
        fila_origen, fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key,
        descripcion, cantidad, monto, medio_pago, comprobante, fuente
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entryId,
        fecha,
        mesKey,
        categoria,
        normKey(categoria),
        proveedor,
        normProvider(proveedor),
        descripcion,
        cantidad,
        monto,
        medioPago,
        comprobante,
        `entry:${entryId}`,
      ]
    );

    return {
      ok: true,
      id: entryId,
      entry: queryOne("SELECT * FROM entries WHERE id = ?", [entryId]),
    };
  });
}

export function entriesPayload() {
  const pending = queryAll<Record<string, unknown>>(
    "SELECT * FROM entries WHERE estado = 'pendiente' ORDER BY id DESC"
  );
  const history = queryAll<Record<string, unknown>>(
    "SELECT * FROM entries WHERE estado != 'pendiente' ORDER BY id DESC LIMIT 50"
  );
  const tsvLines = pending.map((e) =>
    [
      e.fecha,
      e.mes,
      e.categoria,
      e.proveedor,
      e.descripcion,
      e.cantidad,
      e.monto,
      e.medio_pago,
      e.comprobante,
    ].join("\t")
  );
  return {
    pendientes: pending,
    historial: history,
    tsv: tsvLines.join("\n"),
  };
}

export function discardEntry(entryId: number) {
  return runTransaction(() => {
    executeSql("UPDATE entries SET estado = 'descartado' WHERE id = ?", [entryId]);
    executeSql("DELETE FROM expenses WHERE fuente = ?", [`entry:${entryId}`]);
    return { ok: true, id: entryId };
  });
}

export async function pushEntries() {
  const cfg = loadConfig();
  const webhook = norm(cfg.apps_script_webhook_url);
  const pending = queryAll<Record<string, unknown>>(
    "SELECT * FROM entries WHERE estado = 'pendiente' ORDER BY id ASC"
  );

  if (pending.length === 0) {
    return { ok: true, pushed: 0, message: "No hay gastos pendientes por enviar." };
  }
  if (!webhook) {
    return {
      ok: false,
      error: "No hay URL de Apps Script Webhook configurada en Enlaces y Configuración.",
    };
  }

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: pending }),
    });
    if (!res.ok) {
      return { ok: false, error: `Webhook respondió HTTP ${res.status}` };
    }
    const now = new Date().toISOString();
    runTransaction(() => {
      for (const e of pending) {
        executeSql(
          "UPDATE entries SET estado = 'enviado', enviado_en = ? WHERE id = ?",
          [now, Number(e.id)]
        );
      }
    });
    return { ok: true, pushed: pending.length };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function weekPaste(wk: string) {
  const rep = buildWeekReport(wk);
  const r = rep.resumen;
  const idx = weekIndex(wk);
  const tsvResumen = [
    `Semana ${idx}`,
    r.ingreso,
    r.costo,
    r.ganancia_bruta,
    round(r.cmv_pct * 100, 2),
    r.gastos_total,
    r.observaciones || "",
  ].join("\t");

  const tsvCategorias = rep.categorias
    .map((c) =>
      [
        c.categoria,
        c.cantidad,
        c.ingreso,
        c.costo,
        c.ganancia,
        round(c.cmv_pct * 100, 2),
      ].join("\t")
    )
    .join("\n");

  return {
    semana_key: wk,
    label: rep.label,
    tsv_resumen: tsvResumen,
    tsv_categorias: tsvCategorias,
  };
}

export function generateWeekCsv(wk?: string): string {
  const rep = buildWeekReport(wk);
  const lines: string[] = [
    "Categoria,Cantidad,Ingreso,Costo,Ganancia,CMV_Pct,Participacion_Pct",
  ];
  for (const c of rep.categorias) {
    lines.push(
      `"${c.categoria.replace(/"/g, '""')}",${c.cantidad},${c.ingreso},${c.costo},${c.ganancia},${round(c.cmv_pct * 100, 2)},${round(c.pct_venta * 100, 2)}`
    );
  }
  return lines.join("\n");
}

export function generateMonthCsv(mk?: string): string {
  const rep = buildMonthReport(mk);
  const lines: string[] = [
    "Semana,Label,Ingreso,Costo,Ganancia_Bruta,CMV_Pct,Gastos_Total,Ganancia_Caja",
  ];
  for (const w of rep.semanas) {
    lines.push(
      `${w.semana_key},"${w.label}",${w.ingreso},${w.costo},${w.ganancia_bruta},${round(w.cmv_pct * 100, 2)},${w.gastos_total},${w.ganancia_caja}`
    );
  }
  return lines.join("\n");
}

export function generateExpensesCsv(params: { mes?: string; semana?: string } = {}): string {
  const list = listExpenses({ ...params, limit: 2000 });
  const lines: string[] = [
    "Fecha,Mes,Categoria,Proveedor,Descripcion,Cantidad,Monto,Medio_Pago,Comprobante",
  ];
  for (const item of list.items) {
    const desc = String(item.descripcion || "").replace(/"/g, '""');
    const prov = String(item.proveedor || "").replace(/"/g, '""');
    const cat = String(item.categoria || "").replace(/"/g, '""');
    lines.push(
      `${item.fecha},${item.mes_key},"${cat}","${prov}","${desc}",${item.cantidad},${item.monto},"${item.medio_pago || ""}","${item.comprobante || ""}"`
    );
  }
  return lines.join("\n");
}

