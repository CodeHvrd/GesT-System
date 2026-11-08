import {
  norm,
  normKey,
  normProvider,
  round,
  safeDiv,
  money,
  pct,
  parseNumber,
} from "../format";
import {
  labelPeriod,
  previousRange,
  resolveDateRange,
  todayAr,
  parseDate,
  monthLabel,
} from "../dates";
import { loadConfig } from "../config";
import { hasPostgresUrl, pgQueryAll, pgQueryOne, pgExecute } from "../db/pg-db";
import { queryAll, queryOne, executeSql } from "../db/local-db";
import { isFixedCategory } from "./local-analytics";
import { getContableReconciliation } from "../sheets/contable";

export type ChannelType = "todos" | "salon" | "takeaway" | "delivery";

export const VALID_CHANNELS: ChannelType[] = [
  "todos",
  "salon",
  "takeaway",
  "delivery",
];

const PAYMENT_LABELS: Record<string, string> = {
  cash: "Efectivo",
  efectivo: "Efectivo",
  "debit-card": "Débito",
  debito: "Débito",
  "credit-card": "Crédito",
  credito: "Crédito",
  transfer: "Transferencia",
  transferencia: "Transferencia",
  mercadopago: "MercadoPago",
  "mercado-pago": "MercadoPago",
  qr: "QR",
  pedidosya: "PedidosYa",
  rappi: "Rappi",
};

export function normalizeChannel(raw: string): "salon" | "takeaway" | "delivery" {
  const k = normKey(raw);
  if (
    k.includes("delivery") ||
    k.includes("envio") ||
    k.includes("pedidos") ||
    k.includes("rappi")
  ) {
    return "delivery";
  }
  if (
    k.includes("take") ||
    k.includes("mostrador") ||
    k.includes("retiro") ||
    k.includes("llevar")
  ) {
    return "takeaway";
  }
  return "salon";
}

export function daysBetween(dFrom: string, dTo: string): number {
  if (!dFrom || !dTo) return 1;
  const a = new Date(`${dFrom}T00:00:00Z`).getTime();
  const b = new Date(`${dTo}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
}

export async function externalTotals(dFrom: string, dTo: string) {
  const days = daysBetween(dFrom, dTo);
  const mFrom = dFrom.slice(0, 7);
  const mTo = dTo.slice(0, 7);

  let rows: Array<Record<string, unknown>> = [];
  if (hasPostgresUrl()) {
    try {
      rows = await pgQueryAll(
        `SELECT * FROM external_expenses
         WHERE (fecha IS NOT NULL AND fecha::text BETWEEN $1 AND $2)
            OR (es_fijo = TRUE AND (mes_key = '' OR mes_key BETWEEN $3 AND $4))`,
        [dFrom, dTo, mFrom, mTo]
      );
    } catch {
      rows = [];
    }
  } else {
    rows = queryAll(
      `SELECT * FROM external_expenses
       WHERE (fecha != '' AND fecha BETWEEN ? AND ?)
          OR (es_fijo = 1 AND (mes_key = '' OR mes_key BETWEEN ? AND ?))`,
      [dFrom, dTo, mFrom, mTo]
    );
  }

  let fijosProrrateados = 0;
  let puntuales = 0;
  const items: Array<Record<string, unknown>> = [];

  for (const r of rows) {
    const monto = Number(r.monto || 0);
    const esFijo = Boolean(r.es_fijo === true || r.es_fijo === 1);
    if (esFijo) {
      const prorrateado = (monto / 30) * days;
      fijosProrrateados += prorrateado;
      items.push({
        ...r,
        es_fijo: true,
        monto_original: round(monto),
        monto_aplicado: round(prorrateado),
      });
    } else {
      puntuales += monto;
      items.push({
        ...r,
        es_fijo: false,
        monto_original: round(monto),
        monto_aplicado: round(monto),
      });
    }
  }

  return {
    fijos: round(fijosProrrateados),
    puntuales: round(puntuales),
    total: round(fijosProrrateados + puntuales),
    items,
  };
}

export async function externalList(dFrom?: string, dTo?: string) {
  let rows: Array<Record<string, unknown>> = [];
  if (hasPostgresUrl()) {
    try {
      if (dFrom && dTo) {
        rows = await pgQueryAll(
          `SELECT * FROM external_expenses
           WHERE (fecha IS NOT NULL AND fecha::text BETWEEN $1 AND $2)
              OR es_fijo = TRUE
           ORDER BY id DESC`,
          [dFrom, dTo]
        );
      } else {
        rows = await pgQueryAll(
          "SELECT * FROM external_expenses ORDER BY id DESC LIMIT 200"
        );
      }
    } catch {
      rows = [];
    }
  } else {
    if (dFrom && dTo) {
      rows = queryAll(
        `SELECT * FROM external_expenses
         WHERE (fecha != '' AND fecha BETWEEN ? AND ?)
            OR es_fijo = 1
         ORDER BY id DESC`,
        [dFrom, dTo]
      );
    } else {
      rows = queryAll(
        "SELECT * FROM external_expenses ORDER BY id DESC LIMIT 200"
      );
    }
  }

  return rows.map((r) => ({
    id: Number(r.id),
    fecha: String(r.fecha || ""),
    mes_key: String(r.mes_key || ""),
    categoria: String(r.categoria || "Otros"),
    proveedor: String(r.proveedor || ""),
    descripcion: String(r.descripcion || ""),
    monto: round(Number(r.monto || 0)),
    es_fijo: Boolean(r.es_fijo === true || r.es_fijo === 1),
    creado_en: String(r.creado_en || ""),
  }));
}

export async function externalAdd(payload: Record<string, unknown>) {
  const fecha = parseDate(payload.fecha) || todayAr();
  const mesKey = norm(payload.mes_key) || fecha.slice(0, 7);
  const categoria = norm(payload.categoria) || "Gasto Externo";
  const proveedor = norm(payload.proveedor);
  const descripcion = norm(payload.descripcion);
  const monto = parseNumber(payload.monto);
  const esFijo = Boolean(payload.es_fijo);

  if (monto <= 0) {
    return { ok: false, error: "El monto debe ser mayor a 0." };
  }

  if (hasPostgresUrl()) {
    const row = await pgQueryOne<{ id: number }>(
      `INSERT INTO external_expenses (
        fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key, descripcion, monto, es_fijo
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        fecha,
        mesKey,
        categoria,
        normKey(categoria),
        proveedor,
        normProvider(proveedor),
        descripcion,
        monto,
        esFijo,
      ]
    );
    return { ok: true, id: row?.id || 0 };
  }

  const res = executeSql(
    `INSERT INTO external_expenses (
      creado_en, fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key, descripcion, monto, es_fijo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      new Date().toISOString(),
      fecha,
      mesKey,
      categoria,
      normKey(categoria),
      proveedor,
      normProvider(proveedor),
      descripcion,
      monto,
      esFijo ? 1 : 0,
    ]
  );
  return { ok: true, id: Number(res.lastInsertRowid) };
}

export async function externalRemove(id: number) {
  if (!id || id <= 0) return { ok: false, error: "ID inválido" };
  if (hasPostgresUrl()) {
    await pgExecute("DELETE FROM external_expenses WHERE id = $1", [id]);
    return { ok: true, id };
  }
  executeSql("DELETE FROM external_expenses WHERE id = ?", [id]);
  return { ok: true, id };
}

async function queryPeriodMetrics(
  dFrom: string,
  dTo: string,
  channel: ChannelType = "todos"
) {
  let ventasBrutas = 0;
  let descuentos = 0;
  let ventasNetas = 0;
  let cmv = 0;
  let gananciaBruta = 0;
  let comisiones = 0;
  let propinas = 0;
  let tickets = 0;
  let itemsVendidos = 0;
  let sinCostearCount = 0;
  let sinCostearMonto = 0;
  let gastosFudo = 0;
  let gastosPlanillaTotal = 0;
  let gastosPlanillaRepo = 0;
  let gastosPlanillaFijos = 0;
  const porCanal: Record<string, { ventas: number; tickets: number; cmv: number; comisiones: number }> = {
    salon: { ventas: 0, tickets: 0, cmv: 0, comisiones: 0 },
    takeaway: { ventas: 0, tickets: 0, cmv: 0, comisiones: 0 },
    delivery: { ventas: 0, tickets: 0, cmv: 0, comisiones: 0 },
  };
  const mediosMap = new Map<string, number>();

  if (hasPostgresUrl()) {
    try {
      const chRows = await pgQueryAll<Record<string, unknown>>(
        `SELECT canal,
                SUM(ventas_brutas) AS vb,
                SUM(descuentos) AS desc,
                SUM(ventas_netas) AS vn,
                SUM(cmv) AS cmv,
                SUM(ganancia_bruta) AS gb,
                SUM(comisiones) AS com,
                SUM(propinas) AS prop,
                SUM(tickets) AS tkt,
                SUM(items_vendidos) AS itm,
                SUM(items_sin_costo) AS sc_n,
                SUM(monto_sin_costo) AS sc_m
         FROM agg_daily_channel
         WHERE fecha BETWEEN $1 AND $2
         GROUP BY canal`,
        [dFrom, dTo]
      );
      for (const r of chRows) {
        const c = normalizeChannel(String(r.canal || "salon"));
        const vn = Number(r.vn || 0);
        const cCmv = Number(r.cmv || 0);
        const cCom = Number(r.com || 0);
        const cTkt = Number(r.tkt || 0);
        porCanal[c].ventas += vn;
        porCanal[c].tickets += cTkt;
        porCanal[c].cmv += cCmv;
        porCanal[c].comisiones += cCom;

        if (channel === "todos" || channel === c) {
          ventasBrutas += Number(r.vb || 0);
          descuentos += Number(r.desc || 0);
          ventasNetas += vn;
          cmv += cCmv;
          gananciaBruta += Number(r.gb || vn - cCmv);
          comisiones += cCom;
          propinas += Number(r.prop || 0);
          tickets += cTkt;
          itemsVendidos += Number(r.itm || 0);
          sinCostearCount += Number(r.sc_n || 0);
          sinCostearMonto += Number(r.sc_m || 0);
        }
      }

      const dRows = await pgQueryAll<Record<string, unknown>>(
        `SELECT gastos_fudo, medios_pago FROM agg_daily WHERE fecha BETWEEN $1 AND $2`,
        [dFrom, dTo]
      );
      for (const r of dRows) {
        gastosFudo += Number(r.gastos_fudo || 0);
        const mp = (r.medios_pago || {}) as Record<string, number>;
        for (const [k, v] of Object.entries(mp)) {
          mediosMap.set(k, (mediosMap.get(k) || 0) + Number(v || 0));
        }
      }

      const eRows = await pgQueryAll<Record<string, unknown>>(
        `SELECT categoria, monto FROM sheet_expenses WHERE fecha BETWEEN $1 AND $2`,
        [dFrom, dTo]
      );
      for (const e of eRows) {
        const m = Number(e.monto || 0);
        gastosPlanillaTotal += m;
        if (isFixedCategory(String(e.categoria || ""))) gastosPlanillaFijos += m;
        else gastosPlanillaRepo += m;
      }
    } catch {
      // Fallback to empty if PG tables not initialized yet
    }
  } else {
    // Local SQLite fallback
    const sRows = queryAll<Record<string, unknown>>(
      `SELECT * FROM sales WHERE fecha BETWEEN ? AND ?`,
      [dFrom, dTo]
    );
    const datesWithSales = new Set<string>();
    for (const r of sRows) {
      const ing = Number(r.ingreso || 0);
      const cos = Number(r.costo || 0);
      const cant = Number(r.cantidad || 0);
      const c: "salon" | "takeaway" | "delivery" = "salon";

      porCanal[c].ventas += ing;
      porCanal[c].cmv += cos;
      porCanal[c].tickets += 1;

      if (channel === "todos" || channel === c) {
        ventasBrutas += ing;
        ventasNetas += ing;
        cmv += cos;
        gananciaBruta += ing - cos;
        itemsVendidos += cant;
        if (ing > 0 && cos === 0) {
          sinCostearCount += 1;
          sinCostearMonto += ing;
        }
        if (r.fecha) datesWithSales.add(String(r.fecha));
      }
    }
    tickets = sRows.length > 0 ? Math.max(datesWithSales.size * 25, Math.round(sRows.length / 2)) : 0;
    porCanal.salon.tickets = tickets;

    // Check weekly_history if sales table has no rows in date range
    if (ventasNetas === 0) {
      const wRows = queryAll<Record<string, unknown>>(
        `SELECT * FROM weekly_history WHERE fecha_inicio <= ? AND fecha_fin >= ?`,
        [dTo, dFrom]
      );
      for (const w of wRows) {
        const ing = Number(w.ingreso || 0);
        const cos = Number(w.costo || 0);
        ventasBrutas += ing;
        ventasNetas += ing;
        cmv += cos;
        gananciaBruta += Number(w.ganancia || ing - cos);
        porCanal.salon.ventas += ing;
        porCanal.salon.cmv += cos;
      }
    }

    const fRows = queryAll<Record<string, unknown>>(
      `SELECT monto, medio_pago FROM fudo_expenses WHERE fecha BETWEEN ? AND ?`,
      [dFrom, dTo]
    );
    for (const f of fRows) {
      gastosFudo += Number(f.monto || 0);
    }

    const eRows = queryAll<Record<string, unknown>>(
      `SELECT categoria, monto, medio_pago FROM expenses WHERE fecha BETWEEN ? AND ?`,
      [dFrom, dTo]
    );
    for (const e of eRows) {
      const m = Number(e.monto || 0);
      gastosPlanillaTotal += m;
      if (isFixedCategory(String(e.categoria || ""))) gastosPlanillaFijos += m;
      else gastosPlanillaRepo += m;
    }

    if (ventasNetas > 0 && mediosMap.size === 0) {
      mediosMap.set("efectivo", round(ventasNetas * 0.45));
      mediosMap.set("debito", round(ventasNetas * 0.3));
      mediosMap.set("transferencia", round(ventasNetas * 0.25));
    }
  }

  const ext = await externalTotals(dFrom, dTo);
  const fijosTotales = gastosPlanillaFijos + ext.fijos;
  const gastosCajaTotales =
    (gastosPlanillaTotal > 0 ? gastosPlanillaTotal : gastosFudo) + ext.total;

  // Ecuación de Ganancias:
  // Ganancia Bruta = Ventas Netas - CMV - Comisiones
  const gananciaBrutaReal = ventasNetas - cmv - comisiones;
  // Resultado Operativo (Neta) = Ganancia Bruta - Gastos Externos Puntuales - Gastos Fijos
  const gananciaNeta = gananciaBrutaReal - ext.puntuales - fijosTotales;
  // Resultado de Caja = Ventas Netas - Comisiones - Reposición/Proveedores - Externos - Fijos
  const repoEfectiva = gastosPlanillaRepo > 0 ? gastosPlanillaRepo : gastosFudo;
  const gananciaCaja = ventasNetas - comisiones - repoEfectiva - ext.puntuales - fijosTotales;

  const ticketPromedio = tickets > 0 ? ventasNetas / tickets : 0;
  const cmvPct = safeDiv(cmv, ventasNetas);
  const margenBrutoPct = safeDiv(gananciaBrutaReal, ventasNetas);
  const margenNetoPct = safeDiv(gananciaNeta, ventasNetas);

  const mediosPago = Array.from(mediosMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, monto]) => ({
      key: k,
      label: PAYMENT_LABELS[normKey(k)] || k,
      monto: round(monto),
      pct: round(safeDiv(monto, ventasNetas), 4),
    }));

  const canalesList = (["salon", "takeaway", "delivery"] as const).map((ck) => {
    const cd = porCanal[ck];
    const totalAllChannels =
      porCanal.salon.ventas + porCanal.takeaway.ventas + porCanal.delivery.ventas;
    return {
      canal: ck,
      label:
        ck === "salon" ? "Salón / Mesas" : ck === "takeaway" ? "Mostrador / Take Away" : "Delivery",
      ventas: round(cd.ventas),
      tickets: cd.tickets,
      ticket_promedio: round(safeDiv(cd.ventas, cd.tickets)),
      cmv: round(cd.cmv),
      cmv_pct: round(safeDiv(cd.cmv, cd.ventas), 4),
      comisiones: round(cd.comisiones),
      ganancia: round(cd.ventas - cd.cmv - cd.comisiones),
      pct_venta: round(safeDiv(cd.ventas, totalAllChannels), 4),
    };
  });

  return {
    ventas_brutas: round(ventasBrutas),
    descuentos: round(descuentos),
    ventas_netas: round(ventasNetas),
    cmv: round(cmv),
    cmv_pct: round(cmvPct, 4),
    comisiones: round(comisiones),
    propinas: round(propinas),
    ganancia_bruta: round(gananciaBrutaReal),
    margen_bruto_pct: round(margenBrutoPct, 4),
    gastos_fudo: round(gastosFudo),
    gastos_planilla_total: round(gastosPlanillaTotal),
    gastos_reposicion: round(repoEfectiva),
    gastos_fijos_planilla: round(gastosPlanillaFijos),
    gastos_externos_puntuales: ext.puntuales,
    gastos_externos_fijos: ext.fijos,
    gastos_fijos_totales: round(fijosTotales),
    gastos_totales: round(gastosCajaTotales),
    ganancia_neta: round(gananciaNeta),
    margen_neto_pct: round(margenNetoPct, 4),
    ganancia_caja: round(gananciaCaja),
    margen_caja_pct: round(safeDiv(gananciaCaja, ventasNetas), 4),
    tickets,
    ticket_promedio: round(ticketPromedio),
    items_vendidos: round(itemsVendidos, 1),
    sin_costear_count: sinCostearCount,
    sin_costear_monto: round(sinCostearMonto),
    medios_pago: mediosPago,
    canales: canalesList,
  };
}

function diffMetric(cur: number, prev: number) {
  const diff = cur - prev;
  const pctChange = prev !== 0 ? diff / Math.abs(prev) : null;
  return {
    actual: round(cur),
    anterior: round(prev),
    diff: round(diff),
    pct: pctChange !== null ? round(pctChange, 4) : null,
  };
}

export async function summary(
  dFrom: string,
  dTo: string,
  channel: ChannelType = "todos"
) {
  const cur = await queryPeriodMetrics(dFrom, dTo, channel);
  const [pFrom, pTo] = previousRange(dFrom, dTo);
  const prev = await queryPeriodMetrics(pFrom, pTo, channel);
  const cfg = loadConfig();

  return {
    periodo: {
      desde: dFrom,
      hasta: dTo,
      label: labelPeriod(dFrom, dTo),
      dias: daysBetween(dFrom, dTo),
      canal: channel,
    },
    periodo_anterior: {
      desde: pFrom,
      hasta: pTo,
      label: labelPeriod(pFrom, pTo),
    },
    kpis: {
      ...cur,
      cmv_objetivo_general: Number(cfg.cmv_objetivo_general || 0.35),
    },
    ecuacion_ganancia: {
      ventas_netas: cur.ventas_netas,
      menos_cmv: cur.cmv,
      menos_comisiones: cur.comisiones,
      igual_ganancia_bruta: cur.ganancia_bruta,
      menos_reposicion: cur.gastos_reposicion,
      menos_gastos_externos: cur.gastos_externos_puntuales,
      menos_gastos_fijos: cur.gastos_fijos_totales,
      igual_ganancia_neta: cur.ganancia_neta,
      igual_ganancia_caja: cur.ganancia_caja,
    },
    comparacion: {
      ventas_netas: diffMetric(cur.ventas_netas, prev.ventas_netas),
      cmv: diffMetric(cur.cmv, prev.cmv),
      cmv_pct: diffMetric(cur.cmv_pct, prev.cmv_pct),
      ganancia_bruta: diffMetric(cur.ganancia_bruta, prev.ganancia_bruta),
      gastos_totales: diffMetric(cur.gastos_totales, prev.gastos_totales),
      ganancia_neta: diffMetric(cur.ganancia_neta, prev.ganancia_neta),
      ganancia_caja: diffMetric(cur.ganancia_caja, prev.ganancia_caja),
      tickets: diffMetric(cur.tickets, prev.tickets),
      ticket_promedio: diffMetric(cur.ticket_promedio, prev.ticket_promedio),
    },
    canales: cur.canales,
    medios_pago: cur.medios_pago,
  };
}

export async function progress(
  dFrom: string,
  dTo: string,
  channel: ChannelType = "todos"
) {
  const cur = await queryPeriodMetrics(dFrom, dTo, channel);
  const [pFrom, pTo] = previousRange(dFrom, dTo);
  const prev = await queryPeriodMetrics(pFrom, pTo, channel);
  const metaVentas = prev.ventas_netas > 0 ? prev.ventas_netas * 1.05 : cur.ventas_netas || 1000000;
  const avanceVentasPct = safeDiv(cur.ventas_netas, metaVentas);

  return {
    ventas_actual: cur.ventas_netas,
    ventas_anterior: prev.ventas_netas,
    meta_ventas: round(metaVentas),
    avance_pct: round(avanceVentasPct, 4),
    punto_equilibrio_fijos: cur.margen_bruto_pct > 0
      ? round(cur.gastos_fijos_totales / cur.margen_bruto_pct)
      : 0,
    cobertura_fijos_pct: cur.gastos_fijos_totales > 0
      ? round(safeDiv(cur.ganancia_bruta, cur.gastos_fijos_totales), 4)
      : 1,
  };
}

export async function categories(
  dFrom: string,
  dTo: string,
  channel: ChannelType = "todos"
) {
  const cfg = loadConfig();
  const targets = cfg.cmv_objetivo_por_categoria || {};
  const defaultTarget = Number(cfg.cmv_objetivo_general || 0.35);

  let catRows: Array<{
    categoria: string;
    categoria_key: string;
    ing: number;
    cos: number;
    gan: number;
    cant: number;
  }> = [];

  let prodRows: Array<{
    categoria_key: string;
    producto: string;
    cant: number;
    ing: number;
    cos: number;
    gan: number;
  }> = [];

  if (hasPostgresUrl()) {
    try {
      const chFilter = channel !== "todos" ? "AND canal = $3" : "";
      const params = channel !== "todos" ? [dFrom, dTo, channel] : [dFrom, dTo];
      catRows = await pgQueryAll(
        `SELECT categoria, categoria_key,
                SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan, SUM(cantidad) AS cant
         FROM agg_daily_category
         WHERE fecha BETWEEN $1 AND $2 ${chFilter}
         GROUP BY categoria, categoria_key
         ORDER BY ing DESC`,
        params
      );
      prodRows = await pgQueryAll(
        `SELECT categoria_key, producto,
                SUM(cantidad) AS cant, SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan
         FROM agg_daily_product
         WHERE fecha BETWEEN $1 AND $2 ${chFilter}
         GROUP BY categoria_key, producto
         ORDER BY ing DESC`,
        params
      );
    } catch {
      catRows = [];
    }
  } else {
    catRows = queryAll(
      `SELECT categoria, categoria_key,
              SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan, SUM(cantidad) AS cant
       FROM sales
       WHERE fecha BETWEEN ? AND ?
       GROUP BY categoria_key
       ORDER BY ing DESC`,
      [dFrom, dTo]
    );
    prodRows = queryAll(
      `SELECT categoria_key, producto,
              SUM(cantidad) AS cant, SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan
       FROM sales
       WHERE fecha BETWEEN ? AND ?
       GROUP BY categoria_key, producto
       ORDER BY ing DESC`,
      [dFrom, dTo]
    );
  }

  const prodsByCat = new Map<string, Array<Record<string, unknown>>>();
  const allProducts: Array<Record<string, unknown>> = [];
  for (const p of prodRows) {
    const ck = p.categoria_key || normKey(p.categoria_key || "sin categoria");
    const cant = Number(p.cant || 0);
    const ing = Number(p.ing || 0);
    const cos = Number(p.cos || 0);
    const gan = Number(p.gan || ing - cos);
    const item = {
      producto: p.producto || "(Sin nombre)",
      categoria_key: ck,
      cantidad: round(cant, 1),
      ingreso: round(ing),
      costo: round(cos),
      ganancia: round(gan),
      cmv_pct: round(safeDiv(cos, ing), 4),
      precio_unit: cant > 0 ? round(ing / cant) : 0,
      costo_unit: cant > 0 ? round(cos / cant) : 0,
    };
    const arr = prodsByCat.get(ck) || [];
    arr.push(item);
    prodsByCat.set(ck, arr);
    allProducts.push(item);
  }

  const totalIng = catRows.reduce((a, r) => a + Number(r.ing || 0), 0);
  const items = catRows.map((r) => {
    const ck = r.categoria_key || normKey(r.categoria || "sin categoria");
    const ing = Number(r.ing || 0);
    const cos = Number(r.cos || 0);
    const gan = Number(r.gan || ing - cos);
    const cmvPct = safeDiv(cos, ing);

    let obj = defaultTarget;
    for (const [k, v] of Object.entries(targets)) {
      if (normKey(k) === ck || ck.includes(normKey(k))) {
        obj = Number(v);
        break;
      }
    }
    const desvioPp = (cmvPct - obj) * 100;
    let estado = "ok";
    if (desvioPp > 5) estado = "critico";
    else if (desvioPp > 2) estado = "atencion";

    return {
      categoria: r.categoria || "Sin categoría",
      key: ck,
      ingreso: round(ing),
      costo: round(cos),
      ganancia: round(gan),
      cmv_pct: round(cmvPct, 4),
      pct_venta: round(safeDiv(ing, totalIng), 4),
      cantidad: round(Number(r.cant || 0), 1),
      objetivo: round(obj, 4),
      desvio_pp: round(desvioPp, 1),
      estado_cmv: estado,
      productos: (prodsByCat.get(ck) || []).slice(0, 20),
    };
  });

  return {
    items,
    top_productos: allProducts.slice(0, 20),
    sin_costear: allProducts.filter((p) => Number(p.ingreso) > 0 && Number(p.costo) === 0),
  };
}

export async function daily(
  dFrom: string,
  dTo: string,
  channel: ChannelType = "todos"
) {
  if (hasPostgresUrl()) {
    try {
      if (channel !== "todos") {
        const rows = await pgQueryAll<Record<string, unknown>>(
          `SELECT fecha::text AS fecha,
                  SUM(ventas_netas) AS ventas,
                  SUM(cmv) AS cmv,
                  SUM(ganancia_bruta) AS ganancia,
                  SUM(tickets) AS tickets
           FROM agg_daily_channel
           WHERE fecha BETWEEN $1 AND $2 AND canal = $3
           GROUP BY fecha
           ORDER BY fecha ASC`,
          [dFrom, dTo, channel]
        );
        return rows.map((r) => ({
          fecha: String(r.fecha),
          ventas: round(Number(r.ventas || 0)),
          cmv: round(Number(r.cmv || 0)),
          ganancia: round(Number(r.ganancia || 0)),
          gastos: 0,
          tickets: Number(r.tickets || 0),
        }));
      }

      const rows = await pgQueryAll<Record<string, unknown>>(
        `SELECT fecha::text AS fecha,
                ventas_netas AS ventas,
                cmv,
                ganancia_bruta AS ganancia,
                gastos_planilla + gastos_fudo AS gastos,
                tickets
         FROM agg_daily
         WHERE fecha BETWEEN $1 AND $2
         ORDER BY fecha ASC`,
        [dFrom, dTo]
      );
      return rows.map((r) => ({
        fecha: String(r.fecha),
        ventas: round(Number(r.ventas || 0)),
        cmv: round(Number(r.cmv || 0)),
        ganancia: round(Number(r.ganancia || 0)),
        gastos: round(Number(r.gastos || 0)),
        tickets: Number(r.tickets || 0),
      }));
    } catch {
      return [];
    }
  }

  const sRows = queryAll<{
    fecha: string;
    ing: number;
    cos: number;
    gan: number;
    n: number;
  }>(
    `SELECT fecha, SUM(ingreso) AS ing, SUM(costo) AS cos, SUM(ganancia) AS gan, COUNT(*) AS n
     FROM sales
     WHERE fecha BETWEEN ? AND ? AND fecha != ''
     GROUP BY fecha
     ORDER BY fecha ASC`,
    [dFrom, dTo]
  );

  const eRows = queryAll<{ fecha: string; tot: number }>(
    `SELECT fecha, SUM(monto) AS tot
     FROM expenses
     WHERE fecha BETWEEN ? AND ? AND fecha != ''
     GROUP BY fecha`,
    [dFrom, dTo]
  );
  const expByDate = new Map(eRows.map((e) => [e.fecha, Number(e.tot || 0)]));

  const allDates = new Set<string>([
    ...sRows.map((s) => s.fecha),
    ...eRows.map((e) => e.fecha),
  ]);
  const sByDate = new Map(sRows.map((s) => [s.fecha, s]));

  return Array.from(allDates)
    .sort()
    .map((fecha) => {
      const s = sByDate.get(fecha);
      const ventas = Number(s?.ing || 0);
      const cmv = Number(s?.cos || 0);
      const ganancia = Number(s?.gan || ventas - cmv);
      const gastos = expByDate.get(fecha) || 0;
      return {
        fecha,
        ventas: round(ventas),
        cmv: round(cmv),
        ganancia: round(ganancia),
        gastos: round(gastos),
        tickets: Number(s?.n || 0),
      };
    });
}

export async function reconcileProviders(dFrom: string, dTo: string) {
  let fudoRows: Array<{ proveedor: string; proveedor_key: string; tot: number; n: number }> = [];
  let sheetRows: Array<{ proveedor: string; proveedor_key: string; tot: number; n: number }> = [];

  if (hasPostgresUrl()) {
    try {
      fudoRows = await pgQueryAll(
        `SELECT COALESCE(proveedor, 'Sin proveedor') AS proveedor,
                COALESCE(proveedor_key, 'sin proveedor') AS proveedor_key,
                SUM(monto) AS tot, COUNT(*) AS n
         FROM fudo_expenses
         WHERE fecha BETWEEN $1 AND $2 AND estado != 'canceled'
         GROUP BY proveedor, proveedor_key`,
        [dFrom, dTo]
      );
      sheetRows = await pgQueryAll(
        `SELECT COALESCE(proveedor, 'Sin proveedor') AS proveedor,
                COALESCE(proveedor_key, 'sin proveedor') AS proveedor_key,
                SUM(monto) AS tot, COUNT(*) AS n
         FROM sheet_expenses
         WHERE fecha BETWEEN $1 AND $2
         GROUP BY proveedor, proveedor_key`,
        [dFrom, dTo]
      );
    } catch {
      fudoRows = [];
      sheetRows = [];
    }
  } else {
    fudoRows = queryAll(
      `SELECT CASE WHEN proveedor = '' THEN 'Sin proveedor' ELSE proveedor END AS proveedor,
              CASE WHEN proveedor_key = '' THEN 'sin proveedor' ELSE proveedor_key END AS proveedor_key,
              SUM(monto) AS tot, COUNT(*) AS n
       FROM fudo_expenses
       WHERE fecha BETWEEN ? AND ? AND estado != 'canceled'
       GROUP BY proveedor_key`,
      [dFrom, dTo]
    );
    sheetRows = queryAll(
      `SELECT CASE WHEN proveedor = '' THEN 'Sin proveedor' ELSE proveedor END AS proveedor,
              CASE WHEN proveedor_key = '' THEN 'sin proveedor' ELSE proveedor_key END AS proveedor_key,
              SUM(monto) AS tot, COUNT(*) AS n
       FROM expenses
       WHERE fecha BETWEEN ? AND ?
       GROUP BY proveedor_key`,
      [dFrom, dTo]
    );
  }

  const map = new Map<
    string,
    {
      proveedor: string;
      proveedor_key: string;
      fudo_monto: number;
      fudo_items: number;
      planilla_monto: number;
      planilla_items: number;
    }
  >();

  for (const r of fudoRows) {
    const pk = r.proveedor_key || normProvider(r.proveedor);
    const entry = map.get(pk) || {
      proveedor: r.proveedor,
      proveedor_key: pk,
      fudo_monto: 0,
      fudo_items: 0,
      planilla_monto: 0,
      planilla_items: 0,
    };
    entry.fudo_monto += Number(r.tot || 0);
    entry.fudo_items += Number(r.n || 0);
    map.set(pk, entry);
  }

  for (const r of sheetRows) {
    const pk = r.proveedor_key || normProvider(r.proveedor);
    const entry = map.get(pk) || {
      proveedor: r.proveedor,
      proveedor_key: pk,
      fudo_monto: 0,
      fudo_items: 0,
      planilla_monto: 0,
      planilla_items: 0,
    };
    if (!entry.proveedor || entry.proveedor === "Sin proveedor") {
      entry.proveedor = r.proveedor;
    }
    entry.planilla_monto += Number(r.tot || 0);
    entry.planilla_items += Number(r.n || 0);
    map.set(pk, entry);
  }

  return Array.from(map.values())
    .map((x) => {
      const diff = x.planilla_monto - x.fudo_monto;
      let estado: "conciliado" | "solo_fudo" | "solo_planilla" | "diferencia" = "conciliado";
      if (x.fudo_monto > 0 && x.planilla_monto === 0) estado = "solo_fudo";
      else if (x.planilla_monto > 0 && x.fudo_monto === 0) estado = "solo_planilla";
      else if (Math.abs(diff) > 100) estado = "diferencia";

      return {
        ...x,
        fudo_monto: round(x.fudo_monto),
        planilla_monto: round(x.planilla_monto),
        diferencia: round(diff),
        estado,
      };
    })
    .sort(
      (a, b) =>
        Math.max(b.fudo_monto, b.planilla_monto) -
        Math.max(a.fudo_monto, a.planilla_monto)
    );
}

export async function expensesDetail(dFrom: string, dTo: string) {
  let fudoMovs: Array<Record<string, unknown>> = [];
  let sheetMovs: Array<Record<string, unknown>> = [];

  if (hasPostgresUrl()) {
    try {
      fudoMovs = await pgQueryAll(
        `SELECT id, fecha::text AS fecha, categoria, proveedor, descripcion, monto, medio_pago, 'fudo' AS origen
         FROM fudo_expenses
         WHERE fecha BETWEEN $1 AND $2 AND estado != 'canceled'
         ORDER BY fecha DESC LIMIT 250`,
        [dFrom, dTo]
      );
      sheetMovs = await pgQueryAll(
        `SELECT id, fecha::text AS fecha, categoria, proveedor, descripcion, monto, medio_pago, 'planilla' AS origen
         FROM sheet_expenses
         WHERE fecha BETWEEN $1 AND $2
         ORDER BY fecha DESC LIMIT 250`,
        [dFrom, dTo]
      );
    } catch {
      fudoMovs = [];
      sheetMovs = [];
    }
  } else {
    fudoMovs = queryAll(
      `SELECT id, fecha, categoria, proveedor, descripcion, monto, medio_pago, 'fudo' AS origen
       FROM fudo_expenses
       WHERE fecha BETWEEN ? AND ? AND estado != 'canceled'
       ORDER BY fecha DESC LIMIT 250`,
      [dFrom, dTo]
    );
    sheetMovs = queryAll(
      `SELECT id, fecha, categoria, proveedor, descripcion, monto, medio_pago, 'planilla' AS origen
       FROM expenses
       WHERE fecha BETWEEN ? AND ?
       ORDER BY fecha DESC LIMIT 250`,
      [dFrom, dTo]
    );
  }

  const ext = await externalTotals(dFrom, dTo);
  const reconciliacion = await reconcileProviders(dFrom, dTo);
  const activeMesKey = dTo ? dTo.slice(0, 7) : todayAr().slice(0, 7);
  const contableResumen = await getContableReconciliation(activeMesKey);

  const totalFudo = fudoMovs.reduce((a, r) => a + Number(r.monto || 0), 0);
  let totalPlanillaRepo = 0;
  let totalPlanillaFijos = 0;

  const byCatMap = new Map<string, { categoria: string; monto: number; items: number; fijo: boolean }>();
  const sourceForCats = sheetMovs.length > 0 ? sheetMovs : fudoMovs;

  for (const r of sheetMovs) {
    const m = Number(r.monto || 0);
    const cat = String(r.categoria || "Sin categoría");
    if (isFixedCategory(cat)) totalPlanillaFijos += m;
    else totalPlanillaRepo += m;
  }

  for (const r of sourceForCats) {
    const m = Number(r.monto || 0);
    const cat = String(r.categoria || "Sin categoría");
    const ck = normKey(cat);
    const fijo = isFixedCategory(cat);
    const entry = byCatMap.get(ck) || { categoria: cat, monto: 0, items: 0, fijo };
    entry.monto += m;
    entry.items += 1;
    byCatMap.set(ck, entry);
  }

  // Sumar partidas de la Planilla Contable posicionadas como Gasto Externo, Caja Principal y Caja Grande
  const contableExternos = contableResumen.totales.proveedores_varios_faltantes_monto;
  const cajaPrincipalTotal = contableResumen.totales.caja_principal_monto;
  const cajaGrandeFijos = contableResumen.totales.caja_grande_fijos_monto;
  const cajaGrandeVariables = contableResumen.totales.caja_grande_variables_monto;

  const totalBase = Array.from(byCatMap.values()).reduce((a, c) => a + c.monto, 0);
  const porCategoria = Array.from(byCatMap.values())
    .sort((a, b) => b.monto - a.monto)
    .map((c) => ({
      ...c,
      monto: round(c.monto),
      pct: round(safeDiv(c.monto, totalBase), 4),
    }));

  const contableMovs = contableResumen.items
    .filter((item) => item.posicion_actual !== "ignorado")
    .map((item) => ({
      id: `cont-${item.hash}`,
      hash: item.hash,
      fecha: item.fecha,
      categoria:
        item.posicion_actual === "caja_principal"
          ? "Caja Principal (Día a Día)"
          : item.posicion_actual === "caja_grande_fijo"
            ? `Caja Grande (Fijo) · ${item.cuenta}`
            : item.posicion_actual === "caja_grande_variable"
              ? `Caja Grande (Variable) · ${item.cuenta}`
              : item.posicion_actual === "gasto_externo"
                ? `Gasto Externo (${item.cuenta})`
                : item.cuenta,
      proveedor: item.proveedor,
      descripcion: item.detalle || item.observaciones,
      monto: round(item.monto_efectivo),
      medio_pago: item.estado_pago === "pagado" ? "Efectivo / Salida (H)" : "Cuenta Corriente (D)",
      origen:
        item.posicion_actual === "gasto_fudo"
          ? "contable_conciliado"
          : item.posicion_actual,
      es_fijo: item.posicion_actual === "caja_grande_fijo",
      estado_conciliacion: item.estado_conciliacion,
      resuelto: item.resuelto,
    }));

  const movimientos = [
    ...contableMovs,
    ...sheetMovs.map((m) => ({
      ...m,
      fecha: String(m.fecha || ""),
      monto: round(Number(m.monto || 0)),
      es_fijo: isFixedCategory(String(m.categoria || "")),
    })),
    ...fudoMovs.map((m) => ({
      ...m,
      fecha: String(m.fecha || ""),
      monto: round(Number(m.monto || 0)),
      es_fijo: false,
    })),
    ...ext.items.map((e) => ({
      id: `ext-${e.id}`,
      fecha: String(e.fecha || dFrom),
      categoria: String(e.categoria || "Gasto Externo"),
      proveedor: String(e.proveedor || ""),
      descripcion: String(e.descripcion || ""),
      monto: Number(e.monto_aplicado || e.monto || 0),
      medio_pago: "Externo",
      origen: "externo",
      es_fijo: Boolean(e.es_fijo),
    })),
  ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  const externosPuntualesConsolidados = round(
    ext.puntuales + contableExternos + cajaPrincipalTotal + cajaGrandeVariables
  );
  const externosFijosConsolidados = round(ext.fijos + cajaGrandeFijos);

  return {
    totales: {
      fudo: round(totalFudo),
      planilla_total: round(totalPlanillaRepo + totalPlanillaFijos),
      planilla_reposicion: round(totalPlanillaRepo),
      planilla_fijos: round(totalPlanillaFijos),
      externos_puntuales: externosPuntualesConsolidados,
      externos_fijos: externosFijosConsolidados,
      externos_total: round(externosPuntualesConsolidados + externosFijosConsolidados),
      fijos_consolidados: round(totalPlanillaFijos + externosFijosConsolidados),
      diferencia_fudo_planilla: round(totalPlanillaRepo + totalPlanillaFijos - totalFudo),
      contable_proveedores_conciliados: round(contableResumen.totales.proveedores_varios_conciliados_monto),
      contable_proveedores_externos: round(contableExternos),
      caja_principal_total: round(cajaPrincipalTotal),
      caja_grande_fijos: round(cajaGrandeFijos),
      caja_grande_variables: round(cajaGrandeVariables),
    },
    contable_reconciliation: contableResumen,
    por_categoria: porCategoria,
    reconciliacion_proveedores: reconciliacion,
    movimientos: movimientos.slice(0, 300),
  };
}

export async function expensesCross(monthsCount = 6) {
  const today = todayAr();
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const months: string[] = [];
  for (let i = monthsCount - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1 - i, 1));
    const mk = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push(mk);
  }

  const series = [];
  for (const mk of months) {
    const [yr, mo] = mk.split("-").map(Number);
    const lastDay = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
    const dFrom = `${mk}-01`;
    const dTo = `${mk}-${String(lastDay).padStart(2, "0")}`;
    const mMetrics = await queryPeriodMetrics(dFrom, dTo, "todos");
    series.push({
      mes_key: mk,
      label: monthLabel(mk),
      ventas: mMetrics.ventas_netas,
      cmv: mMetrics.cmv,
      gastos_fudo: mMetrics.gastos_fudo,
      gastos_planilla: mMetrics.gastos_planilla_total,
      gastos_externos: round(
        mMetrics.gastos_externos_puntuales + mMetrics.gastos_externos_fijos
      ),
      ganancia_neta: mMetrics.ganancia_neta,
    });
  }
  return series;
}

export async function review(
  dFrom: string,
  dTo: string,
  channel: ChannelType = "todos"
) {
  const sum = await summary(dFrom, dTo, channel);
  const cats = await categories(dFrom, dTo, channel);
  const expDet = await expensesDetail(dFrom, dTo);
  const k = sum.kpis;
  const cfg = loadConfig();
  const targetGral = Number(cfg.cmv_objetivo_general || 0.35);

  const items: Array<{
    id: string;
    nivel: "critico" | "atencion" | "info";
    categoria: string;
    titulo: string;
    detalle: string;
    accion: string;
    impacto?: number;
  }> = [];

  // 1. Productos vendidos sin costo cargado
  if (cats.sin_costear.length > 0) {
    const totSc = cats.sin_costear.reduce((a, p) => a + Number(p.ingreso || 0), 0);
    const ejemplos = cats.sin_costear
      .slice(0, 4)
      .map((p) => String(p.producto))
      .join(", ");
    items.push({
      id: "prod-sin-costo",
      nivel: totSc > k.ventas_netas * 0.05 ? "critico" : "atencion",
      categoria: "Costeo / Recetas",
      titulo: `${cats.sin_costear.length} productos vendidos tienen costo $0`,
      detalle: `Suman ${money(totSc)} en ventas (${pct(safeDiv(totSc, k.ventas_netas))}): ${ejemplos}. Subestiman el CMV real.`,
      accion: "Completar las recetas o el costo unitario en Fudo.",
      impacto: round(-totSc * targetGral),
    });
  }

  // 2. CMV general sobre objetivo
  if (k.ventas_netas > 0 && k.cmv_pct > targetGral + 0.025) {
    const exceso = (k.cmv_pct - targetGral) * k.ventas_netas;
    items.push({
      id: "cmv-general-alto",
      nivel: k.cmv_pct > targetGral + 0.05 ? "critico" : "atencion",
      categoria: "Margen / CMV",
      titulo: `CMV General en ${pct(k.cmv_pct)} vs objetivo de ${pct(targetGral)}`,
      detalle: `El costo de mercadería supera la meta en ${round((k.cmv_pct - targetGral) * 100, 1)} pp, representando ${money(exceso)} de menor margen bruto.`,
      accion: "Revisar precios de venta o actualizar costos de insumos en las categorías críticas.",
      impacto: round(-exceso),
    });
  }

  // 3. Categorías con desvío crítico de CMV
  for (const c of cats.items) {
    if (c.estado_cmv === "critico" && c.ingreso > k.ventas_netas * 0.03) {
      const obj = c.objetivo || targetGral;
      const impacto = (c.cmv_pct - obj) * c.ingreso;
      items.push({
        id: `cmv-cat-${c.key}`,
        nivel: "atencion",
        categoria: "Categorías",
        titulo: `CMV de ${c.categoria} en ${pct(c.cmv_pct)} (meta ${pct(obj)})`,
        detalle: `Generó ventas por ${money(c.ingreso)} con un desvío de +${c.desvio_pp} pp.`,
        accion: `Auditar porciones y precios de carta en ${c.categoria}.`,
        impacto: round(-impacto),
      });
    }
  }

  // 4. Caída de ventas respecto al período anterior
  const chgVentas = sum.comparacion.ventas_netas.pct;
  if (chgVentas !== null && chgVentas <= -0.15) {
    items.push({
      id: "caida-ventas-periodo",
      nivel: "critico",
      categoria: "Ventas",
      titulo: `Facturación cayó ${pct(Math.abs(chgVentas))} frente al período anterior`,
      detalle: `Pasó de ${money(sum.comparacion.ventas_netas.anterior)} a ${money(sum.comparacion.ventas_netas.actual)}.`,
      accion: "Revisar desglose por canal (Salón, Take Away, Delivery) y días con menor flujo.",
      impacto: sum.comparacion.ventas_netas.diff,
    });
  }

  // 5. Doble checkeo Planilla Contable ("Proveedores Varios") vs Gastos Fudo
  const contableRev = expDet.contable_reconciliation;
  if (contableRev && contableRev.discrepancias_pendientes.length > 0) {
    const faltantes = contableRev.discrepancias_pendientes;
    const totalFaltante = faltantes.reduce((acc, item) => acc + item.monto_efectivo, 0);
    const ejemplosProv = Array.from(new Set(faltantes.slice(0, 4).map((f) => f.proveedor))).join(", ");
    items.push({
      id: "contable-proveedores-varios-sin-fudo",
      nivel: faltantes.length > 3 || totalFaltante > 100000 ? "critico" : "atencion",
      categoria: "Auditoría Contable / Fudo",
      titulo: `${faltantes.length} ítems de "Proveedores Varios" (${contableRev.hoja_mes}) no figuran en Gastos Fudo`,
      detalle: `Suman ${money(totalFaltante)} (${ejemplosProv}). Fueron posicionados automáticamente como Gasto Externo hasta verificar si son insumos de receta o compras externas.`,
      accion: "Revisar y resolver cada discrepancia en Gastos > Auditoría Planilla Contable & Fudo.",
      impacto: round(-totalFaltante),
    });
  }

  // 6. Diferencias de conciliación entre Fudo y Planilla Contable
  const desconciliados = expDet.reconciliacion_proveedores.filter(
    (r) => r.estado !== "conciliado" && Math.abs(r.diferencia) > 5000
  );
  if (desconciliados.length > 0 && expDet.totales.fudo > 0 && expDet.totales.planilla_total > 0) {
    const topDes = desconciliados.slice(0, 3).map((d) => d.proveedor).join(", ");
    items.push({
      id: "conciliacion-gastos",
      nivel: "atencion",
      categoria: "Gastos / Conciliación",
      titulo: `${desconciliados.length} proveedores con diferencias entre Fudo y Planilla`,
      detalle: `Diferencia neta de ${money(expDet.totales.diferencia_fudo_planilla)}. Principales: ${topDes}.`,
      accion: "Verificar comprobantes faltantes en la sección Gastos > Reconciliación.",
    });
  }

  // 6. Estado saludable o resumen informativo
  if (items.length === 0 && k.ventas_netas > 0) {
    items.push({
      id: "todo-en-orden",
      nivel: "info",
      categoria: "General",
      titulo: "Indicadores dentro de los parámetros esperados",
      detalle: `CMV en ${pct(k.cmv_pct)} y margen bruto de ${pct(k.margen_bruto_pct)} sobre ${money(k.ventas_netas)} de venta.`,
      accion: "Continuar con el seguimiento habitual.",
    });
  } else if (k.ventas_netas === 0 && expDet.totales.planilla_total === 0) {
    items.push({
      id: "sin-movimientos",
      nivel: "info",
      categoria: "Datos",
      titulo: "Sin movimientos registrados en este rango de fechas",
      detalle: `No se encontraron ventas ni gastos entre ${dFrom} y ${dTo}.`,
      accion: "Seleccioná otro período o sincronizá datos desde Fudo / Google Sheets.",
    });
  }

  const criticos = items.filter((i) => i.nivel === "critico").length;
  const atencion = items.filter((i) => i.nivel === "atencion").length;
  const info = items.filter((i) => i.nivel === "info").length;

  return {
    resumen: {
      total: items.length,
      criticos,
      atencion,
      info,
    },
    items,
  };
}

export async function meta() {
  const cfg = loadConfig();
  let lastSync: string | null = null;
  let minDate = "";
  let maxDate = todayAr();

  if (hasPostgresUrl()) {
    try {
      const r = await pgQueryOne<{ min_d: string; max_d: string }>(
        "SELECT MIN(fecha)::text AS min_d, MAX(fecha)::text AS max_d FROM agg_daily"
      );
      if (r?.min_d) minDate = r.min_d;
      if (r?.max_d) maxDate = r.max_d;
      const sr = await pgQueryOne<{ finished_at: string }>(
        "SELECT finished_at::text AS finished_at FROM sync_state ORDER BY finished_at DESC LIMIT 1"
      );
      if (sr?.finished_at) lastSync = sr.finished_at;
    } catch {
      // ignore
    }
  } else {
    const r = queryOne<{ min_d: string; max_d: string }>(
      "SELECT MIN(fecha) AS min_d, MAX(fecha) AS max_d FROM sales WHERE fecha != ''"
    );
    if (r?.min_d) minDate = r.min_d;
    if (r?.max_d) maxDate = r.max_d;
    const sr = queryOne<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'last_sync'"
    );
    if (sr?.value) lastSync = sr.value;
  }

  return {
    negocio: cfg.nombre_negocio || "GesT — Gestión Gastronómica",
    moneda: cfg.moneda || "ARS",
    modo_db: hasPostgresUrl() ? "postgres" : "sqlite",
    min_fecha: minDate || "2025-01-01",
    max_fecha: maxDate || todayAr(),
    last_sync: lastSync,
    canales: VALID_CHANNELS,
  };
}

export async function dashboard(params: {
  preset?: string | null;
  desde?: string | null;
  hasta?: string | null;
  canal?: string | null;
}) {
  const [dFrom, dTo] = resolveDateRange(
    params.preset,
    params.desde,
    params.hasta
  );
  const rawCh = normKey(params.canal || "todos") as ChannelType;
  const channel: ChannelType = VALID_CHANNELS.includes(rawCh) ? rawCh : "todos";

  const [sumData, progData, catData, dailyData, expDetail, expCross, extList, revData, metaData] =
    await Promise.all([
      summary(dFrom, dTo, channel),
      progress(dFrom, dTo, channel),
      categories(dFrom, dTo, channel),
      daily(dFrom, dTo, channel),
      expensesDetail(dFrom, dTo),
      expensesCross(6),
      externalList(dFrom, dTo),
      review(dFrom, dTo, channel),
      meta(),
    ]);

  return {
    meta: metaData,
    periodo: sumData.periodo,
    periodo_anterior: sumData.periodo_anterior,
    summary: sumData,
    progress: progData,
    categories: catData,
    daily: dailyData,
    expenses: {
      ...expDetail,
      cross_mensual: expCross,
      externos_lista: extList,
    },
    review: revData,
  };
}
