import crypto from "node:crypto";
import { queryAll, executeSql } from "@/lib/db/local-db";
import { pgQueryAll, pgExecute, hasPostgresUrl, ensurePgSchema } from "@/lib/db/pg-db";
import { todayAr, addDays, diffDays, parseDate } from "@/lib/dates";
import { norm, normKey, normProvider, parseNumber, round } from "@/lib/format";

export interface InvoiceItem {
  id: string | number;
  external_id: string;
  fecha_emision: string;
  fecha_vencimiento: string;
  dias_desde_carga: number;
  dias_para_vencer: number;
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
  const dayOfWeek = cur.getUTCDay(); // 0 = Dom, 1 = Lun, 2 = Mar, 3 = Mié, 4 = Jue, 5 = Vie, 6 = Sáb

  let daysToAdd = 0;
  let targetDay: "Martes" | "Viernes" = "Martes";

  if (dayOfWeek === 0) {
    daysToAdd = 2;
    targetDay = "Martes";
  } else if (dayOfWeek === 1) {
    daysToAdd = 1;
    targetDay = "Martes";
  } else if (dayOfWeek === 2) {
    daysToAdd = 0;
    targetDay = "Martes";
  } else if (dayOfWeek === 3) {
    daysToAdd = 2;
    targetDay = "Viernes";
  } else if (dayOfWeek === 4) {
    daysToAdd = 1;
    targetDay = "Viernes";
  } else if (dayOfWeek === 5) {
    daysToAdd = 0;
    targetDay = "Viernes";
  } else if (dayOfWeek === 6) {
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
 * Por defecto el recordatorio de vencimiento es 7 días después de cargada la factura.
 */
export function defaultInvoiceDueDate(loadedDate: string = todayAr()): string {
  return addDays(loadedDate || todayAr(), 7);
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
      await ensurePgSchema();
      const sql = `
        SELECT id,
               external_id,
               to_char(fecha_emision, 'YYYY-MM-DD') AS fecha_emision,
               to_char(fecha_vencimiento, 'YYYY-MM-DD') AS fecha_vencimiento,
               proveedor,
               proveedor_key,
               categoria,
               numero_factura,
               descripcion,
               COALESCE(monto, 0)::float AS monto,
               estado_pago,
               medio_pago,
               to_char(fecha_pago, 'YYYY-MM-DD') AS fecha_pago,
               origen,
               to_char(creado_en, 'YYYY-MM-DD') AS fecha_carga
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
              monto, estado_pago, medio_pago, fecha_pago, origen,
              SUBSTR(creado_en, 1, 10) AS fecha_carga
       FROM supplier_invoices
       ORDER BY fecha_emision DESC, id DESC`
    );
  }

  // Si no hay aún en supplier_invoices, hidratar a partir de fudo_expenses
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
      fecha_vencimiento: addDays(r.fecha_emision || today, 7),
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
    const baseCarga = inv.fecha_carga && /^\d{4}-\d{2}-\d{2}$/.test(String(inv.fecha_carga))
      ? String(inv.fecha_carga)
      : emision;
    const diasDesdeCarga = Math.max(0, diffDays(emision, today));
    // Recordatorio de vencimiento: si no fue modificado, default 7 días después de cargada
    const venc = inv.fecha_vencimiento || addDays(baseCarga, 7);
    const diasParaVencer = diffDays(today, venc);
    const estado = (inv.estado_pago || "pendiente").toLowerCase() as
      | "pendiente"
      | "pagado"
      | "anulado";

    const isVencida = estado === "pendiente" && venc < today;
    const esMasDeUnaSemana = estado === "pendiente" && diasDesdeCarga >= 7;

    let proximoDiaPago: "Martes" | "Viernes" | "Vencida" | "Al día" = "Al día";
    let fechaProximoPago = nextPayment.date;
    let prioridad: "alta" | "media" | "baja" = "baja";

    if (estado === "pendiente") {
      totalDeuda += monto;
      totalFacturasPendientes += 1;
      if (esMasDeUnaSemana) totalMasDeUnaSemana += 1;
      if (isVencida) totalVencidas += 1;

      if (isVencida) {
        proximoDiaPago = "Vencida";
        prioridad = "alta";
      } else if (esMasDeUnaSemana || venc <= nextPayment.date) {
        proximoDiaPago = nextPayment.dayName;
        prioridad = "alta";
      } else {
        const targetNext = getNextPaymentDay(venc);
        proximoDiaPago = targetNext.dayName;
        fechaProximoPago = targetNext.date;
        prioridad = "media";
      }

      if (
        proximoDiaPago === "Martes" ||
        (nextPayment.dayName === "Martes" && isVencida)
      ) {
        totalLoteMartes += monto;
      } else if (
        proximoDiaPago === "Viernes" ||
        (nextPayment.dayName === "Viernes" && isVencida)
      ) {
        totalLoteViernes += monto;
      }
    }

    return {
      id: inv.id,
      external_id: inv.external_id || String(inv.id),
      fecha_emision: emision,
      fecha_vencimiento: venc,
      dias_desde_carga: diasDesdeCarga,
      dias_para_vencer: diasParaVencer,
      proveedor: inv.proveedor || "Sin proveedor",
      proveedor_key: inv.proveedor_key || normProvider(inv.proveedor || ""),
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
      if (
        !prov.proximo_vencimiento ||
        inv.fecha_vencimiento < prov.proximo_vencimiento
      ) {
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

  const facturasProximoLote = invoices
    .filter(
      (i) =>
        i.estado_pago === "pendiente" &&
        (i.prioridad_pago === "alta" || i.dias_desde_carga >= 7)
    )
    .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento));

  return {
    default_due_date: defaultInvoiceDueDate(today),
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
 * Crea una nueva factura (manual o desde escaneo por foto) con recordatorio de vencimiento
 * por defecto a 7 días después de la fecha de carga, pero 100% editable por el usuario.
 */
export async function createInvoice(input: Record<string, unknown>) {
  const today = todayAr();
  const fechaEmision = parseDate(input.fecha_emision || input.fecha) || today;
  // Default: 7 días después de cargada la factura (o la fecha modificada por el usuario)
  const fechaVencimiento =
    parseDate(input.fecha_vencimiento) || defaultInvoiceDueDate(today);
  const proveedor = norm(input.proveedor) || "Proveedor a confirmar";
  const proveedorKey = normProvider(proveedor);
  const categoria = norm(input.categoria) || "Materia Prima / Insumos";
  const numeroFactura = norm(input.numero_factura || input.comprobante);
  const descripcion = norm(input.descripcion);
  const monto = round(parseNumber(input.monto), 2);
  const estadoPago = (
    norm(input.estado_pago).toLowerCase() === "pagado" ? "pagado" : "pendiente"
  ) as "pendiente" | "pagado";
  const medioPago = norm(input.medio_pago) || "Cta. Corriente";
  const origen = norm(input.origen) || "foto_app";

  if (monto <= 0) {
    return { ok: false, error: "El monto de la factura debe ser mayor a $0." };
  }

  const extId = `inv-${Date.now()}-${crypto
    .createHash("sha1")
    .update(`${fechaEmision}|${proveedorKey}|${numeroFactura}|${monto}`)
    .digest("hex")
    .slice(0, 8)}`;

  if (hasPostgresUrl()) {
    try {
      await ensurePgSchema();
      await pgExecute(
        `INSERT INTO supplier_invoices (
           external_id, fecha_emision, fecha_vencimiento, proveedor, proveedor_key,
           categoria, numero_factura, descripcion, monto, estado_pago, medio_pago,
           fecha_pago, origen, payload, actualizado_en
         ) VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14::jsonb, now())
         ON CONFLICT (external_id) DO UPDATE
           SET fecha_vencimiento = EXCLUDED.fecha_vencimiento,
               monto = EXCLUDED.monto,
               numero_factura = EXCLUDED.numero_factura,
               descripcion = EXCLUDED.descripcion,
               estado_pago = EXCLUDED.estado_pago,
               actualizado_en = now()`,
        [
          extId,
          fechaEmision,
          fechaVencimiento,
          proveedor,
          proveedorKey,
          categoria,
          numeroFactura,
          descripcion,
          monto,
          estadoPago,
          medioPago,
          estadoPago === "pagado" ? today : null,
          origen,
          JSON.stringify({
            loaded_at: today,
            due_days: diffDays(today, fechaVencimiento),
          }),
        ]
      );
    } catch {
      // continuar a SQLite local
    }
  }

  const localRes = executeSql(
    `INSERT INTO supplier_invoices (
       external_id, fecha_emision, fecha_vencimiento, proveedor, proveedor_key,
       categoria, numero_factura, descripcion, monto, estado_pago, medio_pago,
       fecha_pago, origen, actualizado_en
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [
      extId,
      fechaEmision,
      fechaVencimiento,
      proveedor,
      proveedorKey,
      categoria,
      numeroFactura,
      descripcion,
      monto,
      estadoPago,
      medioPago,
      estadoPago === "pagado" ? today : "",
      origen,
    ]
  );

  // Guardar también en expenses locales para que impacte en reportes y autocompletado de proveedores
  executeSql(
    `INSERT INTO expenses (
       hash, fecha, mes, mes_key, categoria, categoria_key,
       proveedor, proveedor_key, descripcion, cantidad, monto, medio_pago, comprobante, fuente
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      extId,
      fechaEmision,
      fechaEmision.slice(0, 7),
      fechaEmision.slice(0, 7),
      categoria,
      normKey(categoria),
      proveedor,
      proveedorKey,
      descripcion || `Factura ${numeroFactura}`,
      monto,
      medioPago,
      numeroFactura,
      `invoice:${extId}`,
    ]
  );

  return {
    ok: true,
    id: localRes.lastInsertRowid || extId,
    external_id: extId,
    fecha_emision: fechaEmision,
    fecha_vencimiento: fechaVencimiento,
  };
}

/**
 * Registra el pago, edición de recordatorio de vencimiento o actualización de campos de una factura.
 */
export async function updateInvoiceStatus(
  invoiceId: string | number,
  estado?: "pendiente" | "pagado" | "anulado",
  fechaPago: string = todayAr(),
  extra?: {
    fecha_vencimiento?: string;
    fecha_emision?: string;
    proveedor?: string;
    numero_factura?: string;
    descripcion?: string;
    categoria?: string;
    monto?: number;
    medio_pago?: string;
  }
) {
  const today = todayAr();
  const nextVenc = extra?.fecha_vencimiento
    ? parseDate(extra.fecha_vencimiento)
    : undefined;
  const nextEmision = extra?.fecha_emision
    ? parseDate(extra.fecha_emision)
    : undefined;
  const nextProv =
    extra?.proveedor !== undefined ? norm(extra.proveedor) : undefined;
  const nextNum =
    extra?.numero_factura !== undefined
      ? norm(extra.numero_factura)
      : undefined;
  const nextDesc =
    extra?.descripcion !== undefined ? norm(extra.descripcion) : undefined;
  const nextCat =
    extra?.categoria !== undefined ? norm(extra.categoria) : undefined;
  const nextMonto =
    extra?.monto !== undefined && Number(extra.monto) > 0
      ? round(parseNumber(extra.monto), 2)
      : undefined;
  const nextMedio =
    extra?.medio_pago !== undefined ? norm(extra.medio_pago) : undefined;

  const pDate = estado === "pagado" ? fechaPago || today : null;

  if (hasPostgresUrl()) {
    try {
      await pgExecute(
        `UPDATE supplier_invoices
         SET estado_pago = COALESCE($1, estado_pago),
             fecha_pago = CASE WHEN $1 = 'pagado' THEN $2::date WHEN $1 = 'pendiente' THEN NULL ELSE fecha_pago END,
             fecha_vencimiento = COALESCE($3::date, fecha_vencimiento),
             fecha_emision = COALESCE($4::date, fecha_emision),
             proveedor = COALESCE($5, proveedor),
             proveedor_key = COALESCE($6, proveedor_key),
             numero_factura = COALESCE($7, numero_factura),
             descripcion = COALESCE($8, descripcion),
             categoria = COALESCE($9, categoria),
             monto = COALESCE($10, monto),
             medio_pago = COALESCE($11, medio_pago),
             actualizado_en = now()
         WHERE id::text = $12::text OR external_id = $12::text`,
        [
          estado || null,
          pDate,
          nextVenc || null,
          nextEmision || null,
          nextProv || null,
          nextProv ? normProvider(nextProv) : null,
          nextNum !== undefined ? nextNum : null,
          nextDesc !== undefined ? nextDesc : null,
          nextCat || null,
          nextMonto || null,
          nextMedio || null,
          String(invoiceId),
        ]
      );
    } catch {
      // continuar a SQLite
    }
  }

  executeSql(
    `UPDATE supplier_invoices
     SET estado_pago = COALESCE(NULLIF(?, ''), estado_pago),
         fecha_pago = CASE WHEN ? = 'pagado' THEN ? WHEN ? = 'pendiente' THEN '' ELSE fecha_pago END,
         fecha_vencimiento = COALESCE(NULLIF(?, ''), fecha_vencimiento),
         fecha_emision = COALESCE(NULLIF(?, ''), fecha_emision),
         proveedor = COALESCE(NULLIF(?, ''), proveedor),
         proveedor_key = COALESCE(NULLIF(?, ''), proveedor_key),
         numero_factura = CASE WHEN ? != '__KEEP__' THEN ? ELSE numero_factura END,
         descripcion = CASE WHEN ? != '__KEEP__' THEN ? ELSE descripcion END,
         categoria = COALESCE(NULLIF(?, ''), categoria),
         monto = CASE WHEN ? > 0 THEN ? ELSE monto END,
         medio_pago = COALESCE(NULLIF(?, ''), medio_pago),
         actualizado_en = datetime('now')
     WHERE id = ? OR external_id = ?`,
    [
      estado || "",
      estado || "",
      pDate || "",
      estado || "",
      nextVenc || "",
      nextEmision || "",
      nextProv || "",
      nextProv ? normProvider(nextProv) : "",
      nextNum !== undefined ? nextNum : "__KEEP__",
      nextNum !== undefined ? nextNum : "",
      nextDesc !== undefined ? nextDesc : "__KEEP__",
      nextDesc !== undefined ? nextDesc : "",
      nextCat || "",
      nextMonto || 0,
      nextMonto || 0,
      nextMedio || "",
      invoiceId,
      String(invoiceId),
    ]
  );

  return {
    ok: true,
    invoice_id: invoiceId,
    estado: estado || "actualizado",
    fecha_pago: pDate,
    fecha_vencimiento: nextVenc,
  };
}
