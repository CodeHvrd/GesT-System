import { queryAll, queryOne, executeSql } from "@/lib/db/local-db";
import { pgQueryAll, pgExecute, hasPostgresUrl } from "@/lib/db/pg-db";
import { todayAr, addDays, diffDays } from "@/lib/dates";
import { round } from "@/lib/format";

export interface InvoiceItem {
  id: string | number;
  external_id: string;
  fecha_emision: string;
  fecha_vencimiento: string;
  dias_desde_carga: number;
  proveedor: string;
  proveedor_key: string;
  categoria: string;
  numero_factura: string;
  descripcion: string;
  monto: number;
  estado_pago: "pendiente" | "pagado" | "anulado";
  medio_pago: string;
  fecha_pago: string | null;
  origen: string;
  proximo_dia_pago: "Martes" | "Viernes" | "Vencida" | "Al día";
  fecha_proximo_pago: string;
  prioridad_pago: "alta" | "media" | "baja";
}

export interface ProviderAccountSummary {
  proveedor: string;
  proveedor_key: string;
  total_deuda: number;
  facturas_pendientes: number;
  facturas_vencidas: number;
  proximo_vencimiento: string | null;
  monto_proximo_lote: number;
  facturas: InvoiceItem[];
}

/**
 * Calcula la próxima fecha de corte de tesorería (Martes o Viernes).
 */
export function getNextPaymentDay(fromDateStr: string = todayAr()): {
  dayName: "Martes" | "Viernes";
  date: string;
} {
  const parts = fromDateStr.split("-").map(Number);
  const cur = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  const dayOfWeek = cur.getUTCDay(); // 0 = Domingo, 1 = Lunes, 2 = Martes, 3 = Miércoles, 4 = Jueves, 5 = Viernes, 6 = Sábado

  let daysToAdd = 0;
  let targetDay: "Martes" | "Viernes" = "Martes";

  if (dayOfWeek === 0) {
    // Domingo -> Martes (2 días)
    daysToAdd = 2;
    targetDay = "Martes";
  } else if (dayOfWeek === 1) {
    // Lunes -> Martes (1 día)
    daysToAdd = 1;
    targetDay = "Martes";
  } else if (dayOfWeek === 2) {
    // Martes (hoy mismo es corte)
    daysToAdd = 0;
    targetDay = "Martes";
  } else if (dayOfWeek === 3) {
    // Miércoles -> Viernes (2 días)
    daysToAdd = 2;
    targetDay = "Viernes";
  } else if (dayOfWeek === 4) {
    // Jueves -> Viernes (1 día)
    daysToAdd = 1;
    targetDay = "Viernes";
  } else if (dayOfWeek === 5) {
    // Viernes (hoy mismo es corte)
    daysToAdd = 0;
    targetDay = "Viernes";
  } else if (dayOfWeek === 6) {
    // Sábado -> Martes (3 días)
    daysToAdd = 3;
    targetDay = "Martes";
  }

  const nextDateStr = addDays(fromDateStr, daysToAdd);
  return {
    dayName: targetDay,
    date: nextDateStr,
  };
}

/**
 * Obtiene todas las facturas y calcula el estatus de Cuentas Corrientes y planificación de pagos.
 */
export async function getInvoicesReport(options?: {
  estado?: string;
  proveedor?: string;
}) {
  const today = todayAr();
  const nextPayment = getNextPaymentDay(today);

  let rawInvoices: any[] = [];

  if (hasPostgresUrl()) {
    try {
      const sql = `
        SELECT id, external_id, to_char(fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
               to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
               proveedor, proveedor_key, categoria, numero_factura, descripcion,
               amount AS monto, estado_pago, medio_pago,
               to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago, origen
        FROM supplier_invoices
        ORDER BY fecha_emision DESC, id DESC
      `;
      rawInvoices = await pgQueryAll(sql);
    } catch {
      // Fallback a SQLite local
    }
  }

  if (rawInvoices.length === 0) {
    rawInvoices = queryAll<any>(
      `SELECT id, external_id, fecha_emision, fecha_vencimiento,
              proveedor, proveedor_key, categoria, numero_factura, descripcion,
              monto, estado_pago, medio_pago, fecha_pago, origen
       FROM supplier_invoices
       ORDER BY fecha_emision DESC, id DESC`
    );
  }

  // Si no hay aún en supplier_invoices, hidratar a partir de expenses y fudo_expenses
  if (rawInvoices.length === 0) {
    const fudoRows = queryAll<any>(
      `SELECT external_id, fecha AS fecha_emision, proveedor, proveedor_key,
              categoria, descripcion, monto, medio_pago
       FROM fudo_expenses
       ORDER BY fecha DESC LIMIT 100`
    );
    rawInvoices = fudoRows.map((r, i) => ({
      id: i + 1,
      external_id: r.external_id,
      fecha_emision: r.fecha_emision,
      fecha_vencimiento: addDays(r.fecha_emision, 14),
      proveedor: r.proveedor,
      proveedor_key: r.proveedor_key,
      categoria: r.categoria,
      numero_factura: "",
      descripcion: r.descripcion,
      monto: r.monto,
      estado_pago: "pendiente",
      medio_pago: "Cta. Corriente",
      fecha_pago: null,
      origen: "fudo",
    }));
  }

  let totalDeuda = 0;
  let totalFacturasPendientes = 0;
  let totalVencidas = 0;
  let totalLoteMartes = 0;
  let totalLoteViernes = 0;
  let totalMasDeUnaSemana = 0;

  const invoices: InvoiceItem[] = rawInvoices.map((inv) => {
    const monto = round(Number(inv.monto || 0));
    const emision = inv.fecha_emision || today;
    const diasDesdeCarga = Math.max(0, diffDays(emision, today));
    const venc = inv.fecha_vencimiento || addDays(emision, 14);
    const estado = (inv.estado_pago || "pendiente").toLowerCase() as
      | "pendiente"
      | "pagado"
      | "anulado";

    const isVencida = estado === "pendiente" && venc < today;
    const esMasDeUnaSemana = estado === "pendiente" && diasDesdeCarga >= 7;

    // Planificación de lote Martes vs Viernes
    let proximoDiaPago: "Martes" | "Viernes" | "Vencida" | "Al día" = "Al día";
    let fechaProximoPago = nextPayment.date;
    let prioridad: "alta" | "media" | "baja" = "baja";

    if (estado === "pendiente") {
      totalDeuda += monto;
      totalFacturasPendientes += 1;
      if (esMasDeUnaSemana) totalMasDeUnaSemana += 1;
      if (isVencida) totalVencidas += 1;

      // Si vence antes o dentro del corte próximo, o fue cargada hace >= 7 días
      if (isVencida) {
        proximoDiaPago = "Vencida";
        prioridad = "alta";
      } else if (esMasDeUnaSemana || venc <= nextPayment.date) {
        proximoDiaPago = nextPayment.dayName;
        prioridad = "alta";
      } else {
        // Asignar al martes o viernes previo a su vencimiento
        const targetNext = getNextPaymentDay(venc);
        proximoDiaPago = targetNext.dayName;
        fechaProximoPago = targetNext.date;
        prioridad = "media";
      }

      if (proximoDiaPago === "Martes" || (nextPayment.dayName === "Martes" && isVencida)) {
        totalLoteMartes += monto;
      } else if (proximoDiaPago === "Viernes" || (nextPayment.dayName === "Viernes" && isVencida)) {
        totalLoteViernes += monto;
      }
    }

    return {
      id: inv.id,
      external_id: inv.external_id || String(inv.id),
      fecha_emision: emision,
      fecha_vencimiento: venc,
      dias_desde_carga: diasDesdeCarga,
      proveedor: inv.proveedor || "Sin proveedor",
      proveedor_key: inv.proveedor_key || "",
      categoria: inv.categoria || "Materia Prima",
      numero_factura: inv.numero_factura || "",
      descripcion: inv.descripcion || "",
      monto,
      estado_pago: estado,
      medio_pago: inv.medio_pago || "Cta. Corriente",
      fecha_pago: inv.fecha_pago || null,
      origen: inv.origen || "fudo",
      proximo_dia_pago: proximoDiaPago,
      fecha_proximo_pago: fechaProximoPago,
      prioridad_pago: prioridad,
    };
  });

  // Agrupar por Proveedor para Cuenta Corriente
  const providerMap = new Map<string, ProviderAccountSummary>();
  for (const inv of invoices) {
    const pk = inv.proveedor_key || inv.proveedor;
    let prov = providerMap.get(pk);
    if (!prov) {
      prov = {
        proveedor: inv.proveedor,
        proveedor_key: pk,
        total_deuda: 0,
        facturas_pendientes: 0,
        facturas_vencidas: 0,
        proximo_vencimiento: null,
        monto_proximo_lote: 0,
        facturas: [],
      };
      providerMap.set(pk, prov);
    }
    prov.facturas.push(inv);
    if (inv.estado_pago === "pendiente") {
      prov.total_deuda += inv.monto;
      prov.facturas_pendientes += 1;
      if (inv.fecha_vencimiento < today) {
        prov.facturas_vencidas += 1;
      }
      if (!prov.proximo_vencimiento || inv.fecha_vencimiento < prov.proximo_vencimiento) {
        prov.proximo_vencimiento = inv.fecha_vencimiento;
      }
      if (inv.prioridad_pago === "alta") {
        prov.monto_proximo_lote += inv.monto;
      }
    }
  }

  const cuentasCorrientes = Array.from(providerMap.values())
    .map((p) => ({
      ...p,
      total_deuda: round(p.total_deuda),
      monto_proximo_lote: round(p.monto_proximo_lote),
    }))
    .sort((a, b) => b.total_deuda - a.total_deuda);

  // Filtrado si fue solicitado
  let filteredInvoices = invoices;
  if (options?.estado && options.estado !== "todos") {
    filteredInvoices = filteredInvoices.filter(
      (i) => i.estado_pago === options.estado
    );
  }
  if (options?.proveedor && options.proveedor !== "todos") {
    filteredInvoices = filteredInvoices.filter(
      (i) => i.proveedor_key === options.proveedor
    );
  }

  // Lote sugerido de pago para el próximo corte (Martes o Viernes)
  const facturasProximoLote = invoices
    .filter(
      (i) =>
        i.estado_pago === "pendiente" &&
        (i.prioridad_pago === "alta" || i.dias_desde_carga >= 7)
    )
    .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));

  return {
    kpis: {
      total_deuda: round(totalDeuda),
      total_facturas_pendientes: totalFacturasPendientes,
      total_vencidas: totalVencidas,
      total_mas_de_una_semana: totalMasDeUnaSemana,
      proximo_corte: nextPayment,
      monto_proximo_corte: round(
        nextPayment.dayName === "Martes" ? totalLoteMartes : totalLoteViernes
      ),
      total_martes: round(totalLoteMartes),
      total_viernes: round(totalLoteViernes),
    },
    proximo_corte: nextPayment,
    lote_sugerido: facturasProximoLote,
    cuentas_corrientes: cuentasCorrientes,
    facturas: filteredInvoices,
  };
}

/**
 * Registra el pago o cambio de estado de una factura
 */
export async function updateInvoiceStatus(
  invoiceId: string | number,
  estado: "pendiente" | "pagado" | "anulado",
  fechaPago: string = todayAr()
) {
  const pDate = estado === "pagado" ? fechaPago : null;

  if (hasPostgresUrl()) {
    try {
      await pgExecute(
        `UPDATE supplier_invoices
         SET estado_pago = $1, fecha_pago = $2::date, actualizado_en = now()
         WHERE id = $3 OR external_id = $3::text`,
        [estado, pDate, invoiceId]
      );
    } catch {
      // continuar a SQLite
    }
  }

  executeSql(
    `UPDATE supplier_invoices
     SET estado_pago = ?, fecha_pago = ?, actualizado_en = datetime('now')
     WHERE id = ? OR external_id = ?`,
    [estado, pDate || "", invoiceId, String(invoiceId)]
  );

  return { ok: true, invoice_id: invoiceId, estado, fecha_pago: pDate };
}
