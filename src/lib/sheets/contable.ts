/**
 * Intérprete y Reconciliador de la Planilla Contable Mensual (`1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh`)
 * contra Gastos Fudo (Insumos / Materia Prima) y Movimientos de Caja (Principal y Caja Grande).
 *
 * Formato oficial de columnas de la hoja mensual ("NOVIEMBRE 26", "DICIEMBRE 26", etc.):
 * [0] Fecha | [1] Descripción (Proveedor) | [2] Cuenta | [3] Tipo | [4] Descripción (Detalle) |
 * [5] Entrada (D) | [6] Salida (H) | [7] Saldo | [8] Observaciones
 */

import { MESES, parseDate, todayAr } from "../dates";
import { norm, normKey, normProvider, parseNumber, round } from "../format";
import { loadConfig } from "../config";
import { parseCsv, sha1Hash } from "./sync";
import {
  executeSql,
  queryAll,
  queryOne,
  runTransaction,
} from "../db/local-db";
import { hasPostgresUrl, pgExecute, pgQueryAll } from "../db/pg-db";
import { isFixedCategory } from "../analytics/local-analytics";

export const CONTABLE_SHEET_ID = "1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh";
export const CONTABLE_DEFAULT_GID = 1313414032;

export type OrigenClasificado =
  | "proveedores_varios"
  | "caja_principal"
  | "caja_grande"
  | "caja_grande_fijo"
  | "caja_grande_variable"
  | "servicios_impuestos"
  | "otro_contable";

export type EstadoConciliacion =
  | "conciliado_fudo"
  | "faltante_en_fudo"
  | "discrepancia_monto"
  | "externo_directo"
  | "resuelto_manual";

export type PosicionGasto =
  | "gasto_fudo"
  | "fudo_insumo"
  | "gasto_externo"
  | "caja_principal"
  | "caja_grande_fijo"
  | "caja_grande_variable"
  | "ignorado";

export type FudoExpenseForCheck = Partial<FudoExpenseRecord> & {
  id: string;
  proveedor: string;
  monto: number;
  fecha: string;
};

export interface ContableLedgerItem {
  id?: number;
  hash: string;
  hoja_mes: string;
  mes_key: string;
  fila_origen: number;
  celda_ref: string;
  sheet_cell_url: string;
  fecha: string;
  proveedor: string;
  proveedor_key: string;
  cuenta: string;
  tipo: string;
  detalle: string;
  entrada_d: number;
  salida_h: number;
  monto_efectivo: number;
  saldo: number;
  observaciones: string;
  estado_pago: "pagado" | "a_pagar";
  origen_clasificado: OrigenClasificado;
  estado_conciliacion: EstadoConciliacion;
  posicion_actual: PosicionGasto;
  fudo_expense_id: string;
  diferencia_monto: number;
  resuelto: boolean;
  resolucion_accion: string;
  resolucion_nota: string;
}

/**
 * Construye el hipervínculo directo a la celda/fila de la Planilla Contable en Google Sheets
 * donde está pasado el gasto (ej. columna B = Descripción/Proveedor en la fila `filaOrigen`).
 */
export function buildContableCellUrl(
  filaOrigen: number,
  colLetter = "B",
  sheetId = CONTABLE_SHEET_ID,
  gid = CONTABLE_DEFAULT_GID
): string {
  const rowNum = Math.max(1, Number(filaOrigen || 1));
  return `https://docs.google.com/spreadsheets/d/${sheetId}/edit?gid=${gid}#gid=${gid}&range=${colLetter}${rowNum}`;
}

export interface FudoExpenseRecord {
  id: string;
  fecha: string;
  proveedor: string;
  proveedor_key: string;
  categoria: string;
  descripcion: string;
  monto: number;
  origen_fudo?: "insumo_receta" | "caja_principal" | "caja_grande";
}

/**
 * Convierte '2026-11' -> 'NOVIEMBRE 26', '2026-12' -> 'DICIEMBRE 26'
 */
export function contableTabNameForMonth(mesKey: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(norm(mesKey));
  if (!m) return "NOVIEMBRE 26";
  const yearShort = m[1].slice(2);
  const monthNum = Number(m[2]);
  const monthName = (MESES[monthNum] || "Noviembre").toUpperCase();
  return `${monthName} ${yearShort}`;
}

/**
 * Convierte 'NOVIEMBRE 26' -> '2026-11', 'DICIEMBRE 26' -> '2026-12'
 */
export function monthKeyFromContableTab(tabName: string): string {
  const cleaned = normKey(tabName);
  for (const [numStr, name] of Object.entries(MESES)) {
    const mKey = normKey(name);
    if (cleaned.includes(mKey)) {
      const yMatch = /(\d{2,4})\b/.exec(cleaned);
      let year = 2026;
      if (yMatch) {
        const yNum = Number(yMatch[1]);
        year = yNum < 100 ? 2000 + yNum : yNum;
      }
      return `${year}-${String(Number(numStr)).padStart(2, "0")}`;
    }
  }
  if (/^\d{4}-\d{2}$/.test(norm(tabName))) {
    return norm(tabName);
  }
  return todayAr().slice(0, 7);
}

/**
 * Parsea fechas cortas de la Planilla Contable como "03/11" o "02/11/2026"
 * completando el año/mes de la hoja ("NOVIEMBRE 26" -> 2026-11).
 */
export function parseContableDate(
  rawFecha: string,
  mesKey: string,
  fallbackDate: string
): string {
  const s = norm(rawFecha);
  if (!s) return fallbackDate || `${mesKey}-01`;

  // Si solo viene DD/MM (ej. "03/11" o "3/11")
  const shortMatch = /^(\d{1,2})[\/.-](\d{1,2})$/.exec(s);
  if (shortMatch) {
    const year = mesKey.slice(0, 4) || "2026";
    const dd = String(Number(shortMatch[1])).padStart(2, "0");
    const mm = String(Number(shortMatch[2])).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }

  const parsed = parseDate(s);
  if (parsed) return parsed;
  return fallbackDate || `${mesKey}-01`;
}

/**
 * Clasifica el origen del movimiento contable según Cuenta, Descripción y Detalle:
 * - "Proveedores Varios": debe estar en Gastos Fudo; si no está, va a Gasto Externo + alerta.
 * - "Movimientos de Caja > Principal": compras/retiros del día a día -> Gasto Externo discriminado.
 * - "Caja Grande": retiros de efectivo para gastos fijos y variables (expensas, sueldos, proveedores, alquiler).
 */
export function classifyContableOrigin(
  cuenta: string,
  proveedor: string,
  detalle: string,
  observaciones: string
): OrigenClasificado {
  const ck = normKey(cuenta);
  const pk = normKey(proveedor);
  const dk = normKey(detalle);
  const ok = normKey(observaciones);
  const combined = `${ck} ${pk} ${dk} ${ok}`;

  if (
    ck.includes("proveedores varios") ||
    ck === "proveedores" ||
    ck.startsWith("proveedores ")
  ) {
    return "proveedores_varios";
  }

  if (
    combined.includes("caja principal") ||
    combined.includes("movimientos de caja principal") ||
    (combined.includes("movimientos de caja") && combined.includes("principal")) ||
    ck === "principal" ||
    ck === "caja chica"
  ) {
    return "caja_principal";
  }

  if (combined.includes("caja grande")) {
    return "caja_grande";
  }

  if (
    ck.includes("servicios") ||
    ck.includes("impuestos") ||
    ck.includes("alquiler") ||
    ck.includes("sueldos") ||
    isFixedCategory(cuenta) ||
    isFixedCategory(proveedor)
  ) {
    return "servicios_impuestos";
  }

  return "otro_contable";
}

/**
 * Parsea las filas de una hoja de la Planilla Contable ("NOVIEMBRE 26", "DICIEMBRE 26", etc.)
 * con formato exacto:
 * Fecha | Descripción | Cuenta | Tipo | Descripción | Entrada (D) | Salida (H) | Saldo | Observaciones
 */
export function parseContableRows(
  rows: string[][],
  tabNameOrMonth = "NOVIEMBRE 26",
  explicitMesKey?: string
): ContableLedgerItem[] {
  if (!rows || rows.length === 0) return [];

  const mesKey = explicitMesKey || monthKeyFromContableTab(tabNameOrMonth);
  const hojaMes = contableTabNameForMonth(mesKey);

  // Localizar fila de encabezado buscando "Cuenta" y ("Entrada" o "Salida" o "Fecha")
  let headerIdx = 0;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const lineKeys = rows[i].map((c) => normKey(c));
    if (
      lineKeys.some((k) => k.includes("cuenta")) &&
      lineKeys.some((k) => k.includes("entrada") || k.includes("salida") || k.includes("fecha"))
    ) {
      headerIdx = i;
      break;
    }
  }

  const header = rows[headerIdx] || [];
  const normHeader = header.map((h) => normKey(h));

  // Detectar índices respetando que hay dos columnas "Descripción" (col 1 = Proveedor, col 4 = Detalle)
  const descIndices: number[] = [];
  normHeader.forEach((h, idx) => {
    if (h.includes("descripcion") || h.includes("proveedor")) {
      descIndices.push(idx);
    }
  });

  const findIdx = (pred: (h: string) => boolean, fallback: number): number => {
    const found = normHeader.findIndex(pred);
    return found >= 0 ? found : fallback;
  };

  const iFecha = findIdx((h) => h.includes("fecha"), 0);
  const iProv = descIndices.length > 0 ? descIndices[0] : 1;
  const iCuenta = findIdx((h) => h.includes("cuenta"), 2);
  const iTipo = findIdx((h) => h === "tipo" || h.startsWith("tipo"), 3);
  const iDetalle = descIndices.length > 1 ? descIndices[1] : 4;
  const iEntrada = findIdx((h) => h.includes("entrada"), 5);
  const iSalida = findIdx((h) => h.includes("salida"), 6);
  const iSaldo = findIdx((h) => h.includes("saldo"), 7);
  const iObs = findIdx((h) => h.includes("observacion"), 8);

  const items: ContableLedgerItem[] = [];
  let lastValidDate = `${mesKey}-01`;

  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !norm(c))) continue;

    const rawFecha = row[iFecha] || "";
    const proveedor = norm(row[iProv] || "");
    const cuenta = norm(row[iCuenta] || "");
    const tipo = norm(row[iTipo] || "");
    const detalle = iDetalle !== iProv ? norm(row[iDetalle] || "") : "";
    const entradaD = round(parseNumber(row[iEntrada]), 2);
    const salidaH = round(parseNumber(row[iSalida]), 2);
    const saldo = round(parseNumber(row[iSaldo]), 2);
    const observaciones = norm(row[iObs] || "");

    // Ignorar filas sin proveedor ni cuenta ni montos
    if (!proveedor && !cuenta && entradaD === 0 && salidaH === 0) continue;
    // Ignorar totales al pie
    if (normKey(proveedor) === "total" || normKey(cuenta) === "total") continue;

    const fecha = parseContableDate(rawFecha, mesKey, lastValidDate);
    if (fecha) lastValidDate = fecha;

    const montoEfectivo = salidaH > 0 ? salidaH : entradaD;
    if (montoEfectivo <= 0) continue;

    const obsKey = normKey(observaciones);
    const estadoPago: "pagado" | "a_pagar" =
      salidaH > 0 || obsKey.includes("pagad") ? "pagado" : "a_pagar";

    const origenClasificado = classifyContableOrigin(
      cuenta,
      proveedor,
      detalle,
      observaciones
    );

    let posicionInicial: PosicionGasto = "gasto_externo";
    if (origenClasificado === "caja_principal") {
      posicionInicial = "caja_principal";
    } else if (
      origenClasificado === "caja_grande" ||
      origenClasificado === "caja_grande_fijo" ||
      origenClasificado === "servicios_impuestos"
    ) {
      const combined = `${normKey(cuenta)} ${normKey(tipo)} ${normKey(proveedor)} ${normKey(detalle)} ${normKey(observaciones)}`;
      const isFijo =
        origenClasificado === "servicios_impuestos" ||
        isFixedCategory(proveedor) ||
        isFixedCategory(cuenta) ||
        isFixedCategory(tipo) ||
        isFixedCategory(detalle) ||
        [
          "expensa",
          "sueldo",
          "alquiler",
          "impuesto",
          "servicio",
          "luz",
          "gas",
          "agua",
          "obras sanitarias",
          "arba",
        ].some((w) => combined.includes(w));
      posicionInicial = isFijo ? "caja_grande_fijo" : "caja_grande_variable";
    } else if (origenClasificado === "caja_grande_variable") {
      posicionInicial = "caja_grande_variable";
    }

    const filaOrigen = r + 1;
    const celdaRef = `B${filaOrigen}`;
    const sheetCellUrl = buildContableCellUrl(filaOrigen, "B");
    const hash = sha1Hash(
      hojaMes,
      filaOrigen,
      fecha,
      normProvider(proveedor),
      normKey(cuenta),
      entradaD,
      salidaH
    );

    items.push({
      hash,
      hoja_mes: hojaMes,
      mes_key: mesKey,
      fila_origen: filaOrigen,
      celda_ref: celdaRef,
      sheet_cell_url: sheetCellUrl,
      fecha,
      proveedor: proveedor || detalle || "Sin especificar",
      proveedor_key: normProvider(proveedor || detalle),
      cuenta: cuenta || "General",
      tipo,
      detalle,
      entrada_d: entradaD,
      salida_h: salidaH,
      monto_efectivo: montoEfectivo,
      saldo,
      observaciones,
      estado_pago: estadoPago,
      origen_clasificado: origenClasificado,
      estado_conciliacion:
        origenClasificado === "proveedores_varios"
          ? "faltante_en_fudo"
          : "externo_directo",
      posicion_actual: posicionInicial,
      fudo_expense_id: "",
      diferencia_monto: 0,
      resuelto: false,
      resolucion_accion: "",
      resolucion_nota: "",
    });
  }

  return items;
}

/**
 * Cruza los movimientos de la Planilla Contable contra los Gastos de Fudo.
 * Regla crítica:
 * - Cada ítem donde Cuenta == "Proveedores Varios" debe estar también pasado en Gastos Fudo.
 * - Si está en Fudo: queda como `conciliado_fudo` (`posicion_actual = 'fudo_insumo'`).
 * - Si NO está en Fudo: se marca `faltante_en_fudo` (o `discrepancia_monto`), se notifica
 *   para revisión y se posiciona como `gasto_externo`.
 */
export function crossCheckContableWithFudo(
  contableItems: ContableLedgerItem[],
  fudoExpensesInput: Array<Partial<FudoExpenseRecord> & { id: string; proveedor: string; monto: number; fecha: string }>
) {
  const fudoExpenses: FudoExpenseRecord[] = fudoExpensesInput.map((f) => ({
    id: f.id,
    fecha: f.fecha,
    proveedor: f.proveedor,
    proveedor_key: f.proveedor_key || normProvider(f.proveedor),
    categoria: f.categoria || "Materia Prima / Insumos",
    descripcion: f.descripcion || "",
    monto: f.monto,
    origen_fudo: f.origen_fudo,
  }));
  const usedFudoIds = new Set<string>();

  const evaluated = contableItems.map((item) => {
    const copy = { ...item };

    if (copy.origen_clasificado !== "proveedores_varios") {
      copy.estado_conciliacion = "externo_directo";
      return copy;
    }

    // Buscar coincidencia en Fudo por proveedor_key
    const candidates = fudoExpenses.filter(
      (f) =>
        !usedFudoIds.has(f.id) &&
        f.proveedor_key &&
        (f.proveedor_key === copy.proveedor_key ||
          f.proveedor_key.includes(copy.proveedor_key) ||
          copy.proveedor_key.includes(f.proveedor_key))
    );

    // 1. Coincidencia exacta o con redondeo de efectivo (<= $200 o <= 1.5%)
    const exactOrClose = candidates.find((f) => {
      const diffEntrada = Math.abs(f.monto - copy.entrada_d);
      const diffSalida = copy.salida_h > 0 ? Math.abs(f.monto - copy.salida_h) : Infinity;
      const minDiff = Math.min(diffEntrada, diffSalida, Math.abs(f.monto - copy.monto_efectivo));
      const tol = Math.max(200, copy.monto_efectivo * 0.015);
      return minDiff <= tol;
    });

    if (exactOrClose) {
      usedFudoIds.add(exactOrClose.id);
      copy.estado_conciliacion = "conciliado_fudo";
      copy.posicion_actual = "gasto_fudo";
      copy.fudo_expense_id = exactOrClose.id;
      copy.diferencia_monto = round(copy.monto_efectivo - exactOrClose.monto, 2);
      return copy;
    }

    // 2. Coincidencia del mismo proveedor en la misma fecha pero con distinto monto
    const sameDateDiffAmount = candidates.find((f) => f.fecha === copy.fecha);
    if (sameDateDiffAmount) {
      usedFudoIds.add(sameDateDiffAmount.id);
      copy.estado_conciliacion = "discrepancia_monto";
      copy.posicion_actual = "gasto_externo";
      copy.fudo_expense_id = sameDateDiffAmount.id;
      copy.diferencia_monto = round(
        copy.monto_efectivo - sameDateDiffAmount.monto,
        2
      );
      return copy;
    }

    // 3. No está en Gastos Fudo -> Notificar para revisión y posicionar como Gasto Externo
    copy.estado_conciliacion = "faltante_en_fudo";
    copy.posicion_actual = "gasto_externo";
    copy.diferencia_monto = copy.monto_efectivo;
    return copy;
  });

  // Gastos en Fudo que no tienen respaldo en "Proveedores Varios" de la Planilla Contable
  const fudoSinContable = fudoExpenses.filter(
    (f) =>
      !usedFudoIds.has(f.id) &&
      f.origen_fudo !== "caja_principal" &&
      f.origen_fudo !== "caja_grande"
  );

  // Resumen analítico y financiero
  const provVarios = evaluated.filter(
    (i) => i.origen_clasificado === "proveedores_varios"
  );
  const conciliados = provVarios.filter(
    (i) => i.estado_conciliacion === "conciliado_fudo" || i.resuelto
  );
  const faltantesEnFudo = provVarios.filter(
    (i) => i.estado_conciliacion === "faltante_en_fudo" && !i.resuelto
  );
  const discrepanciasMonto = provVarios.filter(
    (i) => i.estado_conciliacion === "discrepancia_monto" && !i.resuelto
  );

  const cajaPrincipalItems = evaluated.filter(
    (i) => i.posicion_actual === "caja_principal"
  );
  const cajaGrandeFijos = evaluated.filter(
    (i) => i.posicion_actual === "caja_grande_fijo"
  );
  const cajaGrandeVariables = evaluated.filter(
    (i) => i.posicion_actual === "caja_grande_variable"
  );
  const posicionadosComoExternos = evaluated.filter(
    (i) =>
      i.posicion_actual === "gasto_externo" ||
      i.posicion_actual === "caja_principal"
  );

  const discrepanciasPendientes = provVarios.filter(
    (i) =>
      (i.estado_conciliacion === "faltante_en_fudo" ||
        i.estado_conciliacion === "discrepancia_monto") &&
      !i.resuelto
  );

  const resumen = {
    filas_procesadas: evaluated.length,
    total_filas_contable: evaluated.length,
    monto_total_contable: round(
      evaluated.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    proveedores_varios_count: provVarios.length,
    proveedores_varios_monto: round(
      provVarios.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    conciliados_fudo_count: conciliados.length,
    conciliados_fudo_monto: round(
      conciliados.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    proveedores_varios_conciliados_count: conciliados.length,
    proveedores_varios_conciliados_monto: round(
      conciliados.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    faltantes_en_fudo_count: faltantesEnFudo.length,
    faltantes_en_fudo_monto: round(
      faltantesEnFudo.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    proveedores_varios_faltantes_count: faltantesEnFudo.length,
    proveedores_varios_faltantes_monto: round(
      faltantesEnFudo.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    discrepancias_monto_count: discrepanciasMonto.length,
    discrepancias_monto_total: round(
      discrepanciasMonto.reduce((a, i) => a + Math.abs(i.diferencia_monto), 0)
    ),
    fudo_sin_contable_count: fudoSinContable.length,
    fudo_sin_contable_monto: round(
      fudoSinContable.reduce((a, f) => a + f.monto, 0)
    ),
    posicionados_gasto_externo_monto: round(
      posicionadosComoExternos.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    caja_principal_monto: round(
      cajaPrincipalItems.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    caja_grande_fijos_monto: round(
      cajaGrandeFijos.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    caja_grande_variables_monto: round(
      cajaGrandeVariables.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
  };

  return {
    items: evaluated,
    checkedRows: evaluated,
    fudo_sin_contable: fudoSinContable,
    fudoOnlyExpenses: fudoSinContable,
    discrepancias_pendientes: discrepanciasPendientes,
    resumen,
    totales: resumen,
  };
}

/**
 * Descarga el CSV de una hoja mensual ("NOVIEMBRE 26", "DICIEMBRE 26", etc.)
 * desde la Planilla Contable `1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh`.
 */
export async function fetchContableTabCsv(
  tabNameOrMonth: string,
  customSheetId?: string
): Promise<{ ok: boolean; tabName: string; mesKey: string; rows: string[][]; error?: string }> {
  const cfg = loadConfig();
  const sheetId =
    customSheetId || cfg.sheet_contable_id || CONTABLE_SHEET_ID;
  const mesKey = monthKeyFromContableTab(tabNameOrMonth);
  const tabName =
    /^\d{4}-\d{2}$/.test(norm(tabNameOrMonth))
      ? contableTabNameForMonth(mesKey)
      : norm(tabNameOrMonth) || contableTabNameForMonth(mesKey);

  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(
    tabName
  )}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return {
        ok: false,
        tabName,
        mesKey,
        rows: [],
        error: `Google Sheets respondió HTTP ${res.status} para la hoja "${tabName}".`,
      };
    }
    const text = await res.text();
    if (text.trim().startsWith("<!DOCTYPE html") || text.trim().startsWith("<html")) {
      return {
        ok: false,
        tabName,
        mesKey,
        rows: [],
        error: `La hoja "${tabName}" requiere permiso de lectura o aún no fue creada.`,
      };
    }
    return {
      ok: true,
      tabName,
      mesKey,
      rows: parseCsv(text),
    };
  } catch (err) {
    return {
      ok: false,
      tabName,
      mesKey,
      rows: [],
      error: (err as Error).message,
    };
  }
}

async function ensurePgContableTable() {
  if (!hasPostgresUrl()) return;
  await pgExecute(`
    CREATE TABLE IF NOT EXISTS contable_ledger (
      id                  BIGSERIAL PRIMARY KEY,
      hash                TEXT UNIQUE,
      hoja_mes            TEXT NOT NULL DEFAULT '',
      mes_key             TEXT NOT NULL DEFAULT '',
      fila_origen         INTEGER DEFAULT 0,
      fecha               TEXT NOT NULL DEFAULT '',
      proveedor           TEXT NOT NULL DEFAULT '',
      proveedor_key       TEXT NOT NULL DEFAULT '',
      cuenta              TEXT NOT NULL DEFAULT '',
      tipo                TEXT DEFAULT '',
      detalle             TEXT DEFAULT '',
      entrada_d           NUMERIC(14,2) DEFAULT 0,
      salida_h            NUMERIC(14,2) DEFAULT 0,
      monto_efectivo      NUMERIC(14,2) DEFAULT 0,
      saldo               NUMERIC(14,2) DEFAULT 0,
      observaciones       TEXT DEFAULT '',
      estado_pago         TEXT DEFAULT 'pagado',
      origen_clasificado  TEXT DEFAULT 'proveedores_varios',
      estado_conciliacion TEXT DEFAULT 'pendiente',
      posicion_actual     TEXT DEFAULT 'gasto_externo',
      fudo_expense_id     TEXT DEFAULT '',
      diferencia_monto    NUMERIC(14,2) DEFAULT 0,
      resuelto            BOOLEAN DEFAULT FALSE,
      resolucion_accion   TEXT DEFAULT '',
      resolucion_nota     TEXT DEFAULT '',
      updated_at          TIMESTAMPTZ DEFAULT now()
    )
  `);
}

export async function loadFudoExpensesForMonth(
  mesKey: string
): Promise<FudoExpenseRecord[]> {
  const dFrom = `${mesKey}-01`;
  const dTo = `${mesKey}-31`;

  if (hasPostgresUrl()) {
    try {
      const rows = await pgQueryAll<Record<string, unknown>>(
        `SELECT id::text AS id,
                COALESCE(fecha::text, expense_date::text) AS fecha,
                COALESCE(proveedor, provider_name, '') AS proveedor,
                COALESCE(categoria, category_name, '') AS categoria,
                COALESCE(descripcion, description, '') AS descripcion,
                 COALESCE(monto, amount, 0) AS monto
         FROM fudo_expenses
         WHERE COALESCE(fecha::text, expense_date::text) BETWEEN $1 AND $2`,
        [dFrom, dTo]
      );
      return rows.map((r) => ({
        id: String(r.id),
        fecha: String(r.fecha || "").slice(0, 10),
        proveedor: String(r.proveedor || ""),
        proveedor_key: normProvider(r.proveedor),
        categoria: String(r.categoria || ""),
        descripcion: String(r.descripcion || ""),
        monto: round(Number(r.monto || 0), 2),
      }));
    } catch {
      // fallback to local
    }
  }

  const localRows = queryAll<Record<string, unknown>>(
    `SELECT id, external_id, fecha, categoria, proveedor, proveedor_key, descripcion, monto
     FROM fudo_expenses
     WHERE fecha BETWEEN ? AND ? AND estado != 'canceled'`,
    [dFrom, dTo]
  );

  return localRows.map((r) => ({
    id: String(r.external_id || r.id),
    fecha: String(r.fecha || ""),
    proveedor: String(r.proveedor || ""),
    proveedor_key: String(r.proveedor_key || normProvider(r.proveedor)),
    categoria: String(r.categoria || ""),
    descripcion: String(r.descripcion || ""),
    monto: round(Number(r.monto || 0), 2),
  }));
}

/**
 * Sincroniza, interpreta y ejecuta el doble chequeo de una hoja mensual de la Planilla Contable
 * ("NOVIEMBRE 26", "DICIEMBRE 26", etc.) contra los Gastos Fudo, guardando el resultado en
 * Neon (PostgreSQL) y SQLite local, y respetando las resoluciones manuales ya aplicadas.
 */
export async function syncAndReconcileContableMonth(options: {
  tabOrMonth?: string;
  mesKey?: string;
  tabName?: string;
  customCsvText?: string;
  csvRows?: string[][];
  customFudoExpenses?: FudoExpenseForCheck[];
  fudoExpenses?: FudoExpenseForCheck[];
}) {
  const target = options.tabName || options.tabOrMonth || options.mesKey || "NOVIEMBRE 26";
  const mesKey = options.mesKey || monthKeyFromContableTab(target);
  const hojaMes = options.tabName || contableTabNameForMonth(mesKey);

  let rows: string[][] = [];
  if (Array.isArray(options.csvRows)) {
    rows = options.csvRows;
  } else if (options.customCsvText !== undefined) {
    rows = parseCsv(options.customCsvText);
  } else {
    const fetched = await fetchContableTabCsv(hojaMes);
    if (!fetched.ok) {
      return {
        ok: false,
        hoja_mes: hojaMes,
        mes_key: mesKey,
        error: fetched.error,
        items: [],
        discrepancias_pendientes: [],
        totales: {
          filas_procesadas: 0,
          proveedores_varios_conciliados_count: 0,
          proveedores_varios_conciliados_monto: 0,
          proveedores_varios_faltantes_count: 0,
          proveedores_varios_faltantes_monto: 0,
          caja_principal_monto: 0,
          caja_grande_fijos_monto: 0,
          caja_grande_variables_monto: 0,
        },
        resumen: {
          filas_procesadas: 0,
          proveedores_varios_conciliados_count: 0,
          proveedores_varios_conciliados_monto: 0,
          proveedores_varios_faltantes_count: 0,
          proveedores_varios_faltantes_monto: 0,
          caja_principal_monto: 0,
          caja_grande_fijos_monto: 0,
          caja_grande_variables_monto: 0,
        },
      };
    }
    rows = fetched.rows;
  }

  const parsedItems = parseContableRows(rows, hojaMes, mesKey);
  const fudoExpenses =
    options.fudoExpenses !== undefined
      ? options.fudoExpenses
      : options.customFudoExpenses !== undefined
        ? options.customFudoExpenses
        : await loadFudoExpensesForMonth(mesKey);

  // Recuperar resoluciones previas de la DB para no pisar cambios hechos por el usuario
  const existingMap = new Map<
    string,
    {
      resuelto: boolean;
      posicion_actual: PosicionGasto;
      resolucion_accion: string;
      resolucion_nota: string;
      monto_efectivo: number;
    }
  >();

  const existingLocal = queryAll<Record<string, unknown>>(
    "SELECT * FROM contable_ledger WHERE mes_key = ? AND resuelto = 1",
    [mesKey]
  );
  for (const row of existingLocal) {
    existingMap.set(String(row.hash), {
      resuelto: true,
      posicion_actual: String(row.posicion_actual) as PosicionGasto,
      resolucion_accion: String(row.resolucion_accion || ""),
      resolucion_nota: String(row.resolucion_nota || ""),
      monto_efectivo: Number(row.monto_efectivo || 0),
    });
  }

  const cross = crossCheckContableWithFudo(parsedItems, fudoExpenses);

  // Aplicar resoluciones manuales previas
  for (const it of cross.items) {
    const prev = existingMap.get(it.hash);
    if (prev) {
      it.resuelto = true;
      it.estado_conciliacion = "resuelto_manual";
      it.posicion_actual = prev.posicion_actual;
      it.resolucion_accion = prev.resolucion_accion;
      it.resolucion_nota = prev.resolucion_nota;
      if (prev.monto_efectivo > 0) it.monto_efectivo = prev.monto_efectivo;
    }
  }

  // Persistir en SQLite (tanto en contable_ledger como auto-guardar en external_expenses los que NO son "Proveedores Varios")
  runTransaction(() => {
    executeSql("DELETE FROM contable_ledger WHERE mes_key = ?", [mesKey]);
    executeSql(
      "DELETE FROM external_expenses WHERE mes_key = ? AND descripcion LIKE '[Contable Auto]%'",
      [mesKey]
    );
    for (const it of cross.items) {
      executeSql(
        `INSERT INTO contable_ledger (
          hash, hoja_mes, mes_key, fila_origen, fecha, proveedor, proveedor_key,
          cuenta, tipo, detalle, entrada_d, salida_h, monto_efectivo, saldo,
          observaciones, estado_pago, origen_clasificado, estado_conciliacion,
          posicion_actual, fudo_expense_id, diferencia_monto, resuelto,
          resolucion_accion, resolucion_nota
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          it.hash,
          it.hoja_mes,
          it.mes_key,
          it.fila_origen,
          it.fecha,
          it.proveedor,
          it.proveedor_key,
          it.cuenta,
          it.tipo,
          it.detalle,
          it.entrada_d,
          it.salida_h,
          it.monto_efectivo,
          it.saldo,
          it.observaciones,
          it.estado_pago,
          it.origen_clasificado,
          it.estado_conciliacion,
          it.posicion_actual,
          it.fudo_expense_id,
          it.diferencia_monto,
          it.resuelto ? 1 : 0,
          it.resolucion_accion,
          it.resolucion_nota,
        ]
      );

      // Regla: si NO es "Proveedores Varios", se guarda automáticamente como Gasto Externo en la DB
      if (it.origen_clasificado !== "proveedores_varios" && it.posicion_actual !== "ignorado") {
        const esFijo = it.posicion_actual === "caja_grande_fijo" ? 1 : 0;
        const autoDesc = `[Contable Auto] ${it.detalle || it.observaciones || it.tipo || it.cuenta} (Fila ${it.fila_origen})`;
        executeSql(
          `INSERT INTO external_expenses (
            creado_en, fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key, descripcion, monto, es_fijo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            new Date().toISOString(),
            it.fecha,
            it.mes_key,
            it.cuenta || "Gasto Externo Contable",
            normKey(it.cuenta || "gasto externo contable"),
            it.proveedor,
            it.proveedor_key,
            autoDesc,
            it.monto_efectivo,
            esFijo,
          ]
        );
      }
    }
  });

  // Persistir también en Neon PostgreSQL si está configurado
  if (hasPostgresUrl()) {
    try {
      await ensurePgContableTable();
      await pgExecute("DELETE FROM contable_ledger WHERE mes_key = $1", [mesKey]);
      await pgExecute(
        "DELETE FROM external_expenses WHERE mes_key = $1 AND descripcion LIKE '[Contable Auto]%'",
        [mesKey]
      );
      for (const it of cross.items) {
        await pgExecute(
          `INSERT INTO contable_ledger (
            hash, hoja_mes, mes_key, fila_origen, fecha, proveedor, proveedor_key,
            cuenta, tipo, detalle, entrada_d, salida_h, monto_efectivo, saldo,
            observaciones, estado_pago, origen_clasificado, estado_conciliacion,
            posicion_actual, fudo_expense_id, diferencia_monto, resuelto,
            resolucion_accion, resolucion_nota
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
          ON CONFLICT (hash) DO UPDATE SET
            estado_conciliacion = EXCLUDED.estado_conciliacion,
            posicion_actual = EXCLUDED.posicion_actual,
            monto_efectivo = EXCLUDED.monto_efectivo,
            resuelto = EXCLUDED.resuelto,
            resolucion_accion = EXCLUDED.resolucion_accion,
            resolucion_nota = EXCLUDED.resolucion_nota,
            updated_at = now()`,
          [
            it.hash,
            it.hoja_mes,
            it.mes_key,
            it.fila_origen,
            it.fecha,
            it.proveedor,
            it.proveedor_key,
            it.cuenta,
            it.tipo,
            it.detalle,
            it.entrada_d,
            it.salida_h,
            it.monto_efectivo,
            it.saldo,
            it.observaciones,
            it.estado_pago,
            it.origen_clasificado,
            it.estado_conciliacion,
            it.posicion_actual,
            it.fudo_expense_id,
            it.diferencia_monto,
            it.resuelto,
            it.resolucion_accion,
            it.resolucion_nota,
          ]
        );

        if (it.origen_clasificado !== "proveedores_varios" && it.posicion_actual !== "ignorado") {
          const esFijo = it.posicion_actual === "caja_grande_fijo";
          const autoDesc = `[Contable Auto] ${it.detalle || it.observaciones || it.tipo || it.cuenta} (Fila ${it.fila_origen})`;
          await pgExecute(
            `INSERT INTO external_expenses (
              fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key, descripcion, monto, es_fijo
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              it.fecha,
              it.mes_key,
              it.cuenta || "Gasto Externo Contable",
              normKey(it.cuenta || "gasto externo contable"),
              it.proveedor,
              it.proveedor_key,
              autoDesc,
              it.monto_efectivo,
              esFijo,
            ]
          );
        }
      }
    } catch {
      // ignore if PG is offline
    }
  }

  return {
    ok: true,
    hoja_mes: hojaMes,
    mes_key: mesKey,
    ...cross,
  };
}

/**
 * Obtiene el estado actual del libro contable y discrepancias para un mes dado.
 */
export async function getContableReconciliation(mesKeyOrTab = "NOVIEMBRE 26") {
  const mesKey = monthKeyFromContableTab(mesKeyOrTab);
  const hojaMes = contableTabNameForMonth(mesKey);

  let rows = queryAll<Record<string, unknown>>(
    "SELECT * FROM contable_ledger WHERE mes_key = ? ORDER BY fecha ASC, fila_origen ASC",
    [mesKey]
  );

  if (rows.length === 0 && hasPostgresUrl()) {
    try {
      await ensurePgContableTable();
      rows = await pgQueryAll<Record<string, unknown>>(
        "SELECT * FROM contable_ledger WHERE mes_key = $1 ORDER BY fecha ASC, fila_origen ASC",
        [mesKey]
      );
    } catch {
      rows = [];
    }
  }

  const items: ContableLedgerItem[] = rows.map((r) => {
    const filaOrigen = Number(r.fila_origen || 1);
    return {
      id: Number(r.id),
      hash: String(r.hash || ""),
      hoja_mes: String(r.hoja_mes || hojaMes),
      mes_key: String(r.mes_key || mesKey),
      fila_origen: filaOrigen,
      celda_ref: `B${filaOrigen}`,
      sheet_cell_url: buildContableCellUrl(filaOrigen, "B"),
      fecha: String(r.fecha || ""),
      proveedor: String(r.proveedor || ""),
      proveedor_key: String(r.proveedor_key || ""),
      cuenta: String(r.cuenta || ""),
      tipo: String(r.tipo || ""),
      detalle: String(r.detalle || ""),
      entrada_d: Number(r.entrada_d || 0),
      salida_h: Number(r.salida_h || 0),
      monto_efectivo: Number(r.monto_efectivo || 0),
      saldo: Number(r.saldo || 0),
      observaciones: String(r.observaciones || ""),
      estado_pago: (r.estado_pago === "a_pagar" ? "a_pagar" : "pagado") as
        | "pagado"
        | "a_pagar",
      origen_clasificado: String(
        r.origen_clasificado || "proveedores_varios"
      ) as OrigenClasificado,
      estado_conciliacion: String(
        r.estado_conciliacion || "faltante_en_fudo"
      ) as EstadoConciliacion,
      posicion_actual: String(
        r.posicion_actual || "gasto_externo"
      ) as PosicionGasto,
      fudo_expense_id: String(r.fudo_expense_id || ""),
      diferencia_monto: Number(r.diferencia_monto || 0),
      resuelto: Boolean(r.resuelto === 1 || r.resuelto === true),
      resolucion_accion: String(r.resolucion_accion || ""),
      resolucion_nota: String(r.resolucion_nota || ""),
    };
  });

  const fudoExpenses = await loadFudoExpensesForMonth(mesKey);
  const matchedFudoIds = new Set(
    items.map((i) => i.fudo_expense_id).filter(Boolean)
  );
  const fudoSinContable = fudoExpenses.filter((f) => !matchedFudoIds.has(f.id));

  const provVarios = items.filter(
    (i) => i.origen_clasificado === "proveedores_varios"
  );
  const conciliados = provVarios.filter(
    (i) => i.estado_conciliacion === "conciliado_fudo" || i.resuelto
  );
  const faltantesEnFudo = provVarios.filter(
    (i) => i.estado_conciliacion === "faltante_en_fudo" && !i.resuelto
  );
  const discrepanciasMonto = provVarios.filter(
    (i) => i.estado_conciliacion === "discrepancia_monto" && !i.resuelto
  );
  const posicionadosGastoExterno = items.filter(
    (i) =>
      i.posicion_actual === "gasto_externo" ||
      i.posicion_actual === "caja_principal"
  );
  const discrepanciasPendientes = provVarios.filter(
    (i) =>
      (i.estado_conciliacion === "faltante_en_fudo" ||
        i.estado_conciliacion === "discrepancia_monto") &&
      !i.resuelto
  );

  const resumen = {
    filas_procesadas: items.length,
    total_filas_contable: items.length,
    monto_total_contable: round(
      items.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    proveedores_varios_count: provVarios.length,
    proveedores_varios_monto: round(
      provVarios.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    conciliados_fudo_count: conciliados.length,
    conciliados_fudo_monto: round(
      conciliados.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    proveedores_varios_conciliados_count: conciliados.length,
    proveedores_varios_conciliados_monto: round(
      conciliados.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    faltantes_en_fudo_count: faltantesEnFudo.length,
    faltantes_en_fudo_monto: round(
      faltantesEnFudo.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    proveedores_varios_faltantes_count: faltantesEnFudo.length,
    proveedores_varios_faltantes_monto: round(
      faltantesEnFudo.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    discrepancias_monto_count: discrepanciasMonto.length,
    discrepancias_monto_total: round(
      discrepanciasMonto.reduce((a, i) => a + Math.abs(i.diferencia_monto), 0)
    ),
    fudo_sin_contable_count: fudoSinContable.length,
    fudo_sin_contable_monto: round(
      fudoSinContable.reduce((a, f) => a + f.monto, 0)
    ),
    posicionados_gasto_externo_monto: round(
      posicionadosGastoExterno.reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    caja_principal_monto: round(
      items
        .filter((i) => i.posicion_actual === "caja_principal")
        .reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    caja_grande_fijos_monto: round(
      items
        .filter((i) => i.posicion_actual === "caja_grande_fijo")
        .reduce((a, i) => a + i.monto_efectivo, 0)
    ),
    caja_grande_variables_monto: round(
      items
        .filter((i) => i.posicion_actual === "caja_grande_variable")
        .reduce((a, i) => a + i.monto_efectivo, 0)
    ),
  };

  return {
    ok: true,
    hoja_mes: hojaMes,
    mes_key: mesKey,
    sheet_id: CONTABLE_SHEET_ID,
    items,
    fudo_sin_contable: fudoSinContable,
    discrepancias_pendientes: discrepanciasPendientes,
    resumen,
    totales: resumen,
  };
}

/**
 * Permite editar un registro de la Planilla Contable / Discrepancia en Neon DB y SQLite
 * y resolver la discrepancia (ej. posicionarlo como Gasto Externo, confirmar que está en Fudo,
 * asignarlo a Caja Principal / Caja Grande, ajustar el monto o sincronizarlo a Fudo/Neon).
 */
export async function resolveContableDiscrepancy(input: {
  hash: string;
  posicion_actual?: PosicionGasto;
  accion?: string;
  nota?: string;
  monto_efectivo?: number;
  nuevoMonto?: number;
  proveedor?: string;
  nuevoProveedor?: string;
  cuenta?: string;
  fudoExpenseId?: string;
}) {
  const hash = norm(input.hash);
  if (!hash) {
    return null;
  }

  const existing = queryOne<Record<string, unknown>>(
    "SELECT * FROM contable_ledger WHERE hash = ?",
    [hash]
  );
  if (!existing) {
    return null;
  }

  let mappedPosicion: PosicionGasto | undefined = input.posicion_actual;
  if (!mappedPosicion && input.accion) {
    if (input.accion === "confirmar_en_fudo" || input.accion === "registrar_en_fudo") {
      mappedPosicion = "gasto_fudo";
    } else if (input.accion === "mantener_gasto_externo") {
      mappedPosicion = "gasto_externo";
    } else if (input.accion === "mover_a_caja_principal") {
      mappedPosicion = "caja_principal";
    } else if (input.accion === "mover_a_caja_grande_fijo") {
      mappedPosicion = "caja_grande_fijo";
    } else if (input.accion === "mover_a_caja_grande_variable") {
      mappedPosicion = "caja_grande_variable";
    } else if (input.accion === "ignorar") {
      mappedPosicion = "ignorado";
    }
  }

  const nextPosicion: PosicionGasto =
    mappedPosicion ||
    (String(existing.posicion_actual || "gasto_externo") as PosicionGasto);
  const nextAccion = norm(input.accion) || `reclasificado:${nextPosicion}`;
  const nextNota =
    input.nota !== undefined
      ? norm(input.nota)
      : String(existing.resolucion_nota || "");
  const rawMonto = input.nuevoMonto ?? input.monto_efectivo;
  const nextMonto =
    rawMonto !== undefined && rawMonto > 0
      ? round(rawMonto, 2)
      : Number(existing.monto_efectivo || 0);
  const rawProv = input.nuevoProveedor ?? input.proveedor;
  const nextProveedor =
    rawProv !== undefined
      ? norm(rawProv)
      : String(existing.proveedor || "");
  const nextCuenta =
    input.cuenta !== undefined
      ? norm(input.cuenta)
      : String(existing.cuenta || "");

  // Si la acción es "registrar_en_fudo" o "confirmar_en_fudo", también lo insertamos en fudo_expenses en nuestra DB
  if (
    nextAccion === "registrar_en_fudo" ||
    nextAccion === "confirmar_en_fudo" ||
    nextPosicion === "fudo_insumo" ||
    nextPosicion === "gasto_fudo"
  ) {
    const extId = input.fudoExpenseId || `manual-contable-${hash.slice(0, 12)}`;
    executeSql(
      `INSERT INTO fudo_expenses (
        external_id, fecha, categoria, proveedor, proveedor_key, descripcion, monto, medio_pago, estado
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Contable', 'confirmed')
      ON CONFLICT(external_id) DO UPDATE SET
        monto = excluded.monto,
        proveedor = excluded.proveedor,
        proveedor_key = excluded.proveedor_key`,
      [
        extId,
        String(existing.fecha || ""),
        nextCuenta || "Materia Prima / Insumos",
        nextProveedor,
        normProvider(nextProveedor),
        nextNota || String(existing.detalle || "Confirmado desde Planilla Contable"),
        nextMonto,
      ]
    );
  }

  executeSql(
    `UPDATE contable_ledger
     SET posicion_actual = ?,
         estado_conciliacion = 'resuelto_manual',
         resuelto = 1,
         resolucion_accion = ?,
         resolucion_nota = ?,
         monto_efectivo = ?,
         proveedor = ?,
         proveedor_key = ?,
         cuenta = ?,
         updated_at = datetime('now')
     WHERE hash = ?`,
    [
      nextPosicion,
      nextAccion,
      nextNota,
      nextMonto,
      nextProveedor,
      normProvider(nextProveedor),
      nextCuenta,
      hash,
    ]
  );

  if (hasPostgresUrl()) {
    try {
      await ensurePgContableTable();
      await pgExecute(
        `UPDATE contable_ledger
         SET posicion_actual = $1,
             estado_conciliacion = 'resuelto_manual',
             resuelto = TRUE,
             resolucion_accion = $2,
             resolucion_nota = $3,
             monto_efectivo = $4,
             proveedor = $5,
             proveedor_key = $6,
             cuenta = $7,
             updated_at = now()
         WHERE hash = $8`,
        [
          nextPosicion,
          nextAccion,
          nextNota,
          nextMonto,
          nextProveedor,
          normProvider(nextProveedor),
          nextCuenta,
          hash,
        ]
      );
    } catch {
      // ignore if PG offline
    }
  }

  return {
    ok: true,
    hash,
    mes_key: String(existing.mes_key || ""),
    hoja_mes: String(existing.hoja_mes || ""),
    resuelto: true,
    posicion_actual: nextPosicion,
    resolucion_accion: nextAccion,
    resolucion_nota: nextNota,
    monto_efectivo: nextMonto,
    proveedor: nextProveedor,
  };
}
