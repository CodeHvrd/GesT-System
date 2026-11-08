import crypto from "node:crypto";
import { loadConfig, tabUrl, type AppConfig } from "../config";
import { parseDate, parseMonthKey, weekKey } from "../dates";
import {
  norm,
  normKey,
  normProvider,
  parseNumber,
  round,
} from "../format";
import {
  executeSql,
  queryAll,
  queryOne,
  runTransaction,
  setSetting,
} from "../db/local-db";
import type { FudoSaleLine } from "../fudo/sync";

export function sha1Hash(...parts: unknown[]): string {
  const joined = parts
    .map((p) => (p === null || p === undefined ? "" : String(p)))
    .join("|");
  return crypto.createHash("sha1").update(joined, "utf-8").digest("hex");
}

export function parseCsv(text: string): string[][] {
  const cleaned = String(text || "").replace(/^\ufeff/, "");
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    const next = cleaned[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        currentRow.push(currentField.trim());
        currentField = "";
      } else if (ch === "\r" && next === "\n") {
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
        i++;
      } else if (ch === "\n" || ch === "\r") {
        currentRow.push(currentField.trim());
        rows.push(currentRow);
        currentRow = [];
        currentField = "";
      } else {
        currentField += ch;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField.trim());
    rows.push(currentRow);
  }

  return rows;
}

export interface NormalizedExpenseRow {
  hash: string;
  fila_origen: number;
  fecha: string;
  mes_key: string;
  categoria: string;
  categoria_key: string;
  proveedor: string;
  proveedor_key: string;
  descripcion: string;
  cantidad: number;
  monto: number;
  medio_pago: string;
  comprobante: string;
  fuente: string;
}

export interface NormalizedSaleRow {
  hash: string;
  semana_key: string;
  fecha: string;
  mes: string;
  categoria: string;
  categoria_key: string;
  producto: string;
  cantidad: number;
  ingreso: number;
  costo: number;
  ganancia: number;
  fuente: string;
}

export interface NormalizedWeeklyRow {
  hash: string;
  semana_key: string;
  mes_key: string;
  fecha_inicio: string;
  fecha_fin: string;
  ingreso: number;
  costo: number;
  ganancia: number;
  gastos: number;
  observaciones: string;
}

export interface NormalizedMonthlyRow {
  hash: string;
  mes_key: string;
  ingreso: number;
  costo: number;
  ganancia: number;
  gastos: number;
}

function findHeaderRow(rows: string[][], candidates: string[]): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const normed = rows[i].map((c) => normKey(c));
    if (candidates.some((cand) => normed.some((h) => h.includes(cand)))) {
      return i;
    }
  }
  return 0;
}

export function normalizeExpenses(rows: string[][]): NormalizedExpenseRow[] {
  if (!rows || rows.length === 0) return [];
  const hi = findHeaderRow(rows, ["fecha", "monto", "proveedor"]);
  const header = rows[hi].map((h) => normKey(h));

  const idxOf = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const iFecha = idxOf("fecha", "dia");
  const iMes = idxOf("mes");
  const iCat = idxOf("categoria", "rubro");
  const iProv = idxOf("proveedor");
  const iDesc = idxOf("descripcion", "detalle", "concepto");
  const iCant = idxOf("cantidad", "cant");
  const iMonto = idxOf("monto", "importe", "total");
  const iPago = idxOf("medio", "pago", "forma");
  const iComp = idxOf("comprobante", "factura");

  const out: NormalizedExpenseRow[] = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !norm(c))) continue;

    const fecha = iFecha >= 0 ? parseDate(row[iFecha]) : "";
    const monto = iMonto >= 0 ? parseNumber(row[iMonto]) : 0;
    if (!fecha && monto === 0) continue;

    const rawMes = iMes >= 0 ? row[iMes] : "";
    const mesKey = parseMonthKey(rawMes, fecha) || (fecha ? fecha.slice(0, 7) : "");
    const categoria = (iCat >= 0 ? norm(row[iCat]) : "") || "Sin categoría";
    const proveedor = iProv >= 0 ? norm(row[iProv]) : "";
    const descripcion = iDesc >= 0 ? norm(row[iDesc]) : "";
    const cantidad = iCant >= 0 ? parseNumber(row[iCant]) || 1 : 1;
    const medioPago = iPago >= 0 ? norm(row[iPago]) : "";
    const comprobante = iComp >= 0 ? norm(row[iComp]) : "";

    out.push({
      hash: sha1Hash(r + 1, fecha, categoria, proveedor, monto),
      fila_origen: r + 1,
      fecha,
      mes_key: mesKey,
      categoria,
      categoria_key: normKey(categoria),
      proveedor,
      proveedor_key: normProvider(proveedor),
      descripcion,
      cantidad,
      monto: round(monto, 2),
      medio_pago: medioPago,
      comprobante,
      fuente: "sheet",
    });
  }
  return out;
}

export function normalizeSales(rows: string[][]): NormalizedSaleRow[] {
  if (!rows || rows.length === 0) return [];
  const hi = findHeaderRow(rows, ["fecha", "producto", "ingreso", "venta"]);
  const header = rows[hi].map((h) => normKey(h));
  const idxOf = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const iFecha = idxOf("fecha", "dia");
  const iCat = idxOf("categoria", "rubro");
  const iProd = idxOf("producto", "item", "articulo");
  const iCant = idxOf("cantidad", "cant", "unidades");
  const iIng = idxOf("ingreso", "venta", "total", "monto");
  const iCos = idxOf("costo", "cmv");

  const out: NormalizedSaleRow[] = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !norm(c))) continue;
    const fecha = iFecha >= 0 ? parseDate(row[iFecha]) : "";
    if (!fecha) continue;

    const categoria = (iCat >= 0 ? norm(row[iCat]) : "") || "Sin categoría";
    const producto = (iProd >= 0 ? norm(row[iProd]) : "") || "Producto";
    const cantidad = iCant >= 0 ? parseNumber(row[iCant]) : 1;
    const ingreso = iIng >= 0 ? parseNumber(row[iIng]) : 0;
    const costo = iCos >= 0 ? parseNumber(row[iCos]) : 0;
    const wk = weekKey(fecha);

    out.push({
      hash: sha1Hash(r + 1, fecha, categoria, producto, ingreso),
      semana_key: wk,
      fecha,
      mes: fecha.slice(0, 7),
      categoria,
      categoria_key: normKey(categoria),
      producto,
      cantidad: round(cantidad, 2),
      ingreso: round(ingreso, 2),
      costo: round(costo, 2),
      ganancia: round(ingreso - costo, 2),
      fuente: "sheet",
    });
  }
  return out;
}

export function normalizeWeekly(rows: string[][]): NormalizedWeeklyRow[] {
  if (!rows || rows.length === 0) return [];
  const hi = findHeaderRow(rows, ["semana", "inicio", "ventas", "ingreso"]);
  const header = rows[hi].map((h) => normKey(h));
  const idxOf = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const iSem = idxOf("semana");
  const iIni = idxOf("inicio", "desde");
  const iFin = idxOf("fin", "hasta");
  const iIng = idxOf("venta", "ingreso");
  const iCos = idxOf("costo", "cmv");
  const iGan = idxOf("ganancia", "bruto");
  const iGas = idxOf("gasto");
  const iObs = idxOf("observacion", "nota");

  const out: NormalizedWeeklyRow[] = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !norm(c))) continue;

    const fIni = iIni >= 0 ? parseDate(row[iIni]) : "";
    const fFin = iFin >= 0 ? parseDate(row[iFin]) : "";
    const rawSem = iSem >= 0 ? norm(row[iSem]) : "";

    let wk = "";
    if (/^\d{4}-\d{2}-S[1-5]$/i.test(rawSem)) {
      wk = rawSem.toUpperCase();
    } else if (fIni) {
      wk = weekKey(fIni);
    }
    if (!wk) continue;

    const ing = iIng >= 0 ? parseNumber(row[iIng]) : 0;
    const cos = iCos >= 0 ? parseNumber(row[iCos]) : 0;
    const gan = iGan >= 0 && norm(row[iGan]) ? parseNumber(row[iGan]) : ing - cos;
    const gas = iGas >= 0 ? parseNumber(row[iGas]) : 0;
    const obs = iObs >= 0 ? norm(row[iObs]) : "";

    out.push({
      hash: sha1Hash(wk, ing, cos),
      semana_key: wk,
      mes_key: wk.slice(0, 7),
      fecha_inicio: fIni,
      fecha_fin: fFin,
      ingreso: round(ing, 2),
      costo: round(cos, 2),
      ganancia: round(gan, 2),
      gastos: round(gas, 2),
      observaciones: obs,
    });
  }
  return out;
}

export function normalizeMonthly(rows: string[][]): NormalizedMonthlyRow[] {
  if (!rows || rows.length === 0) return [];
  const hi = findHeaderRow(rows, ["mes", "venta", "ingreso"]);
  const header = rows[hi].map((h) => normKey(h));
  const idxOf = (...names: string[]) =>
    header.findIndex((h) => names.some((n) => h === n || h.includes(n)));

  const iMes = idxOf("mes");
  const iIng = idxOf("venta", "ingreso");
  const iCos = idxOf("costo", "cmv");
  const iGan = idxOf("ganancia", "bruto");
  const iGas = idxOf("gasto");

  const out: NormalizedMonthlyRow[] = [];
  for (let r = hi + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => !norm(c))) continue;
    const mk = parseMonthKey(iMes >= 0 ? row[iMes] : row[0]);
    if (!mk) continue;

    const ing = iIng >= 0 ? parseNumber(row[iIng]) : 0;
    const cos = iCos >= 0 ? parseNumber(row[iCos]) : 0;
    const gan = iGan >= 0 && norm(row[iGan]) ? parseNumber(row[iGan]) : ing - cos;
    const gas = iGas >= 0 ? parseNumber(row[iGas]) : 0;

    out.push({
      hash: sha1Hash(mk, ing, cos),
      mes_key: mk,
      ingreso: round(ing, 2),
      costo: round(cos, 2),
      ganancia: round(gan, 2),
      gastos: round(gas, 2),
    });
  }
  return out;
}

export function replaceExpenses(items: NormalizedExpenseRow[]) {
  return runTransaction(() => {
    executeSql("DELETE FROM expenses WHERE fuente NOT LIKE 'entry:%'");
    for (const it of items) {
      executeSql(
        `INSERT INTO expenses (
          hash, fila_origen, fecha, mes, mes_key, categoria, categoria_key,
          proveedor, proveedor_key, descripcion, cantidad, monto, medio_pago, comprobante, fuente
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          it.hash,
          it.fila_origen,
          it.fecha,
          it.mes_key,
          it.mes_key,
          it.categoria,
          it.categoria_key,
          it.proveedor,
          it.proveedor_key,
          it.descripcion,
          it.cantidad,
          it.monto,
          it.medio_pago,
          it.comprobante,
          it.fuente,
        ]
      );
    }
    return { inserted: items.length };
  });
}

export function replaceSalesWeeks(
  items: Array<NormalizedSaleRow | FudoSaleLine>
) {
  const weeks = Array.from(
    new Set(items.map((i) => i.semana_key || (i as FudoSaleLine).semana))
  ).filter(Boolean);

  return runTransaction(() => {
    for (const wk of weeks) {
      executeSql("DELETE FROM sales WHERE semana_key = ?", [wk]);
    }
    for (const it of items) {
      const wk = it.semana_key || (it as FudoSaleLine).semana;
      executeSql(
        `INSERT INTO sales (
          hash, semana_key, semana, fecha, mes, categoria, categoria_key,
          producto, cantidad, ingreso, costo, ganancia, ventas, cmv, fuente
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          it.hash,
          wk,
          wk,
          it.fecha,
          it.mes || it.fecha.slice(0, 7),
          it.categoria,
          it.categoria_key || normKey(it.categoria),
          it.producto,
          it.cantidad,
          it.ingreso,
          it.costo,
          it.ganancia,
          it.ingreso,
          it.costo,
          it.fuente || "fudo:sync",
        ]
      );
    }
    return { inserted: items.length, weeks };
  });
}

export function replaceWeekly(items: NormalizedWeeklyRow[]) {
  return runTransaction(() => {
    executeSql("DELETE FROM weekly_history");
    for (const it of items) {
      executeSql(
        `INSERT INTO weekly_history (
          hash, semana_key, semana, mes_key, mes, fecha_inicio, fecha_fin,
          ingreso, costo, ganancia, gastos, observaciones
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          it.hash,
          it.semana_key,
          it.semana_key,
          it.mes_key,
          it.mes_key,
          it.fecha_inicio,
          it.fecha_fin,
          it.ingreso,
          it.costo,
          it.ganancia,
          it.gastos,
          it.observaciones,
        ]
      );
    }
    return { inserted: items.length };
  });
}

export function replaceMonthly(items: NormalizedMonthlyRow[]) {
  return runTransaction(() => {
    executeSql("DELETE FROM monthly_history");
    for (const it of items) {
      executeSql(
        `INSERT INTO monthly_history (
          hash, mes_key, mes, ingreso, costo, ganancia, gastos
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          it.hash,
          it.mes_key,
          it.mes_key,
          it.ingreso,
          it.costo,
          it.ganancia,
          it.gastos,
        ]
      );
    }
    return { inserted: items.length };
  });
}

export function confirmEntries(sheetExpenses?: NormalizedExpenseRow[]): number {
  const pending = queryAll<{
    id: number;
    fecha: string;
    proveedor: string;
    monto: number;
  }>("SELECT id, fecha, proveedor, monto FROM entries WHERE estado = 'pendiente'");

  let confirmed = 0;
  for (const p of pending) {
    const pk = normProvider(p.proveedor);
    let matched = false;
    if (sheetExpenses) {
      matched = sheetExpenses.some(
        (e) =>
          e.fecha === p.fecha &&
          Math.abs(e.monto - Number(p.monto)) < 1 &&
          (!pk || e.proveedor_key === pk)
      );
    } else {
      const hit = queryOne(
        "SELECT 1 FROM expenses WHERE fecha = ? AND ABS(monto - ?) < 1 AND fuente = 'sheet' LIMIT 1",
        [p.fecha, p.monto]
      );
      matched = Boolean(hit);
    }
    if (matched) {
      executeSql("UPDATE entries SET estado = 'confirmado' WHERE id = ?", [
        p.id,
      ]);
      executeSql("DELETE FROM expenses WHERE fuente = ?", [`entry:${p.id}`]);
      confirmed += 1;
    }
  }
  return confirmed;
}

export async function discoverTabs(sheetId?: string, apiKey?: string) {
  if (!sheetId) {
    return { ok: false, error: "Falta configurar el Sheet ID." };
  }
  return {
    ok: true,
    sheet_id: sheetId,
    has_api_key: Boolean(apiKey),
    tabs: ["GASTOS", "VENTAS", "SEMANAL", "MENSUAL"],
  };
}

export async function fetchTabCsv(sheetId: string, tabName: string): Promise<string[][]> {
  const url = tabUrl(sheetId, tabName);
  if (!url) return [];
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} al leer ${tabName}`);
  const text = await res.text();
  return parseCsv(text);
}

export async function syncAllSheets(customCfg?: AppConfig) {
  const cfg = customCfg || loadConfig();
  if (!cfg.sheet_id) {
    return {
      ok: false,
      skipped: true,
      message: "Sin Sheet ID configurado.",
    };
  }

  const now = new Date().toISOString();
  setSetting("last_sync", now);
  return {
    ok: true,
    synced_at: now,
  };
}
