import crypto from "node:crypto";
import { addDays, localDateFromUtc, weekKey } from "../dates";
import { norm, normKey, normProvider, round, safeDiv } from "../format";
import { executeSql, runTransaction } from "../db/local-db";
import { FudoClient, type JsonApiResource } from "./client";

export interface CatalogProduct {
  id: string;
  name: string;
  categoryId: string;
  categoryName: string;
  price: number;
  cost: number;
  hasRecipe: boolean;
}

export interface FudoSaleLine {
  hash: string;
  semana_key: string;
  semana: string;
  fecha: string;
  mes: string;
  categoria: string;
  categoria_key: string;
  subcategoria: string;
  producto: string;
  cantidad: number;
  ingreso: number;
  costo: number;
  ganancia: number;
  ventas: number;
  cmv: number;
  cmv_pct: number;
  costo_unit: number | null;
  fuente: string;
  source: string;
  channel: string;
}

export function indexIncluded(
  rows?: JsonApiResource[] | null
): Map<string, JsonApiResource> {
  const idx = new Map<string, JsonApiResource>();
  for (const r of rows || []) {
    if (r.type) idx.set(`${String(r.type)}|${String(r.id)}`, r);
    idx.set(String(r.id), r);
  }
  return idx;
}

export async function fetchProductCatalog(client: FudoClient): Promise<{
  products: Record<string, CatalogProduct>;
  categories: Record<string, string>;
}> {
  const categories: Record<string, string> = {};
  const products: Record<string, CatalogProduct> = {};

  try {
    const catResp = await client.get("/product-categories", { "page[size]": 500 });
    for (const c of catResp.data || []) {
      categories[String(c.id)] = String(c.attributes?.name || "Sin categoría");
    }
  } catch {
    // optional
  }

  const data = await client.get("/products", {
    "page[size]": 500,
    include: "proportions.ingredient,productCategory",
  });
  const inc = indexIncluded(data.included);

  for (const p of data.data || []) {
    const a = p.attributes || {};
    const direct = a.cost !== null && a.cost !== undefined ? Number(a.cost) : 0;
    let computed = 0;
    let hasRecipe = false;
    const refs = p.relationships?.proportions?.data;
    if (Array.isArray(refs) && refs.length > 0) {
      for (const ref of refs) {
        const pr = inc.get(`Proportion|${String(ref.id)}`) || inc.get(String(ref.id));
        if (!pr) continue;
        const pa = pr.attributes || {};
        const ingRef = pr.relationships?.ingredient?.data;
        const ingId =
          ingRef && !Array.isArray(ingRef) ? String(ingRef.id) : null;
        const ing = ingId
          ? inc.get(`Ingredient|${ingId}`) || inc.get(ingId)
          : null;
        const ia = ing?.attributes || {};
        if (ia.cost === null || ia.cost === undefined) continue;
        hasRecipe = true;
        const shrink = Number(pa.appliedShrinkage || 0);
        computed +=
          Number(pa.amount || 0) * (1 + shrink / 100) * Number(ia.cost);
      }
    }

    const catRef = p.relationships?.productCategory?.data;
    const catId =
      catRef && !Array.isArray(catRef) ? String(catRef.id) : "";
    const catName =
      categories[catId] ||
      String(
        (inc.get(`ProductCategory|${catId}`) || inc.get(catId))?.attributes
          ?.name || "Sin categoría"
      );

    const finalCost = direct > 0 ? direct : round(computed, 2);
    products[String(p.id)] = {
      id: String(p.id),
      name: String(a.name || "Producto"),
      categoryId: catId,
      categoryName: catName,
      price: Number(a.price || 0),
      cost: finalCost,
      hasRecipe: hasRecipe || direct > 0,
    };
  }

  return { products, categories };
}

export function buildLines(
  rawSales: JsonApiResource[],
  itemsMap: Map<string, JsonApiResource>,
  catalog: Record<string, CatalogProduct>
): {
  lines: FudoSaleLine[];
  stats: {
    sales_total: number;
    sales_closed: number;
    items_processed: number;
    price_mode: "linea" | "unidad";
    ingreso_total: number;
    costo_total: number;
    ganancia_total: number;
    cmv_pct: number;
  };
} {
  let salesClosed = 0;
  let totalFudoSaleHeader = 0;
  let sumAsLine = 0;
  let sumAsUnit = 0;

  const rawItems: Array<{
    saleId: string;
    fecha: string;
    categoria: string;
    producto: string;
    qty: number;
    rawPrice: number;
    unitCost: number;
    channel: string;
  }> = [];

  for (const sale of rawSales) {
    const attrs = sale.attributes || {};
    const state = String(attrs.saleState || "CLOSED").toUpperCase();
    if (state !== "CLOSED") continue;
    const fecha =
      localDateFromUtc(attrs.closedAt || attrs.createdAt) ||
      String(attrs.closedAt || attrs.createdAt || "").slice(0, 10);
    if (!fecha) continue;

    salesClosed += 1;
    totalFudoSaleHeader += Number(attrs.total || 0);

    const saleType = String(attrs.saleType || "").toUpperCase();
    const channel =
      saleType === "DELIVERY"
        ? "delivery"
        : saleType === "TAKEAWAY"
        ? "takeaway"
        : "salon";

    const itemRefs = sale.relationships?.items?.data;
    const refs = Array.isArray(itemRefs)
      ? itemRefs
      : itemRefs
      ? [itemRefs]
      : [];

    for (const ref of refs) {
      const item =
        itemsMap.get(`Item|${String(ref.id)}`) || itemsMap.get(String(ref.id));
      if (!item) continue;
      const ia = item.attributes || {};
      if (ia.canceled) continue;

      const qty = Number(ia.quantity || 1);
      if (qty <= 0) continue;
      const rawPrice = Number(ia.price || 0);
      const pRef = item.relationships?.product?.data;
      const pid = pRef && !Array.isArray(pRef) ? String(pRef.id) : "";
      const catProd = catalog[pid];

      const prodName = catProd?.name || String(ia.name || "Producto");
      const catName = catProd?.categoryName || "General";
      const unitCost =
        catProd && catProd.cost > 0
          ? catProd.cost
          : Number(ia.cost || 0);

      sumAsLine += rawPrice;
      sumAsUnit += rawPrice * qty;

      rawItems.push({
        saleId: String(sale.id),
        fecha,
        categoria: catName,
        producto: prodName,
        qty,
        rawPrice,
        unitCost,
        channel,
      });
    }
  }

  const diffLine = Math.abs(sumAsLine - totalFudoSaleHeader);
  const diffUnit = Math.abs(sumAsUnit - totalFudoSaleHeader);
  const priceMode: "linea" | "unidad" =
    diffLine <= diffUnit ? "linea" : "unidad";

  const grouped = new Map<string, FudoSaleLine>();

  for (const it of rawItems) {
    const lineIngreso =
      priceMode === "linea" ? it.rawPrice : it.rawPrice * it.qty;
    const lineCosto = it.unitCost * it.qty;
    const wk = weekKey(it.fecha);
    const ck = normKey(it.categoria);
    const key = `${it.fecha}|${ck}|${normKey(it.producto)}`;

    const existing = grouped.get(key);
    if (existing) {
      existing.cantidad = round(existing.cantidad + it.qty, 2);
      existing.ingreso = round(existing.ingreso + lineIngreso, 2);
      existing.costo = round(existing.costo + lineCosto, 2);
      existing.ganancia = round(existing.ingreso - existing.costo, 2);
      existing.ventas = existing.ingreso;
      existing.cmv = existing.costo;
      existing.cmv_pct = round(safeDiv(existing.costo, existing.ingreso), 4);
    } else {
      const hash = crypto
        .createHash("sha1")
        .update(key, "utf-8")
        .digest("hex");
      const ing = round(lineIngreso, 2);
      const cos = round(lineCosto, 2);
      grouped.set(key, {
        hash,
        semana_key: wk,
        semana: wk,
        fecha: it.fecha,
        mes: it.fecha.slice(0, 7),
        categoria: it.categoria,
        categoria_key: ck,
        subcategoria: "",
        producto: it.producto,
        cantidad: round(it.qty, 2),
        ingreso: ing,
        costo: cos,
        ganancia: round(ing - cos, 2),
        ventas: ing,
        cmv: cos,
        cmv_pct: round(safeDiv(cos, ing), 4),
        costo_unit: it.qty > 0 ? round(cos / it.qty, 2) : 0,
        fuente: `fudo:${it.saleId}`,
        source: "fudo",
        channel: it.channel,
      });
    }
  }

  const lines = Array.from(grouped.values()).sort((a, b) =>
    a.fecha.localeCompare(b.fecha)
  );
  const ingresoTotal = round(lines.reduce((s, l) => s + l.ingreso, 0));
  const costoTotal = round(lines.reduce((s, l) => s + l.costo, 0));
  const gananciaTotal = round(ingresoTotal - costoTotal);

  return {
    lines,
    stats: {
      sales_total: rawSales.length,
      sales_closed: salesClosed,
      items_processed: rawItems.length,
      price_mode: priceMode,
      ingreso_total: ingresoTotal,
      costo_total: costoTotal,
      ganancia_total: gananciaTotal,
      cmv_pct: round(safeDiv(costoTotal, ingresoTotal), 4),
    },
  };
}

export async function fetchSales(
  client: FudoClient,
  dFrom: string,
  dTo: string
) {
  const catalogData = await fetchProductCatalog(client);
  const start = `${dFrom}T00:00:00Z`;
  const end = `${addDays(dTo, 1)}T00:00:00Z`;

  const resp = await client.get("/sales", {
    "filter[closedAt]": `and(gte.${start},lt.${end})`,
    include: "items,items.product,items.product.productCategory",
    "page[size]": 500,
    sort: "id",
  });

  const inc = indexIncluded(resp.included);
  return buildLines(resp.data || [], inc, catalogData.products);
}

export async function previewFudoSales(
  client: FudoClient,
  dFrom: string,
  dTo: string
) {
  const res = await fetchSales(client, dFrom, dTo);
  return {
    ok: true,
    desde: dFrom,
    hasta: dTo,
    stats: res.stats,
    sample: res.lines.slice(0, 25),
  };
}

export interface FudoSyncedExpense {
  external_id: string;
  fecha: string;
  proveedor: string;
  proveedor_key: string;
  categoria: string;
  descripcion: string;
  monto: number;
  origen_fudo: "insumo_receta" | "caja_principal" | "caja_grande";
}

/**
 * Descarga Gastos de Fudo (`/expenses`: ingredientes y materia prima que actualizan el costo del producto)
 * y Movimientos de Caja (`/cash-movements` o categorías de Caja Principal / Caja Grande),
 * discriminando:
 * - `insumo_receta`: compras de ingredientes y materia prima en Fudo.
 * - `caja_principal`: compras y retiros de caja principal para gastos del día a día (se cargan como Gasto Externo).
 * - `caja_grande`: retiros de efectivo para gastos fijos y variables (expensas, sueldos, proveedores, alquiler).
 */
export async function fetchFudoExpensesAndCashMovements(
  client: FudoClient,
  dFrom: string,
  dTo: string
): Promise<{
  expenses: FudoSyncedExpense[];
  cash_principal: FudoSyncedExpense[];
  cash_grande: FudoSyncedExpense[];
}> {
  const expenses: FudoSyncedExpense[] = [];
  const cashPrincipal: FudoSyncedExpense[] = [];
  const cashGrande: FudoSyncedExpense[] = [];

  try {
    const resp = await client.get("/expenses", {
      "filter[date]": `and(gte.${dFrom},lte.${dTo})`,
      include: "provider,expenseCategory,cashRegister",
      "page[size]": 500,
      sort: "id",
    });
    const inc = indexIncluded(resp.included);

    for (const exp of resp.data || []) {
      const attrs = exp.attributes || {};
      if (attrs.canceled) continue;
      const fecha = String(attrs.date || "").slice(0, 10);
      if (!fecha) continue;
      const monto = round(Number(attrs.amount || 0), 2);
      if (monto <= 0) continue;

      const pRef = exp.relationships?.provider?.data;
      const pid = pRef && !Array.isArray(pRef) ? String(pRef.id) : "";
      const provObj = pid ? inc.get(`Provider|${pid}`) || inc.get(pid) : null;
      const proveedor = norm(provObj?.attributes?.name || "");

      const cRef = exp.relationships?.expenseCategory?.data;
      const cid = cRef && !Array.isArray(cRef) ? String(cRef.id) : "";
      const catObj = cid
        ? inc.get(`ExpenseCategory|${cid}`) || inc.get(cid)
        : null;
      const categoria = norm(
        catObj?.attributes?.name || "Materia Prima / Insumos"
      );

      const crRef = exp.relationships?.cashRegister?.data;
      const crid = crRef && !Array.isArray(crRef) ? String(crRef.id) : "";
      const crObj = crid
        ? inc.get(`CashRegister|${crid}`) || inc.get(crid)
        : null;
      const cajaNombre = normKey(crObj?.attributes?.name || "");

      const descripcion = norm(
        attrs.description || attrs.receiptNumber || ""
      );
      const textKey = `${normKey(categoria)} ${normKey(descripcion)} ${cajaNombre}`;

      let origenFudo: "insumo_receta" | "caja_principal" | "caja_grande" =
        "insumo_receta";
      if (
        cajaNombre.includes("grande") ||
        textKey.includes("caja grande")
      ) {
        origenFudo = "caja_grande";
      } else if (
        (cajaNombre.includes("principal") && !proveedor) ||
        textKey.includes("movimientos de caja") ||
        textKey.includes("retiro caja principal")
      ) {
        origenFudo = "caja_principal";
      }

      const item: FudoSyncedExpense = {
        external_id: String(exp.id),
        fecha,
        proveedor: proveedor || descripcion || "Sin proveedor",
        proveedor_key: normProvider(proveedor || descripcion),
        categoria,
        descripcion,
        monto,
        origen_fudo: origenFudo,
      };

      if (origenFudo === "caja_principal") {
        cashPrincipal.push(item);
      } else if (origenFudo === "caja_grande") {
        cashGrande.push(item);
      } else {
        expenses.push(item);
      }
    }
  } catch {
    // Si la cuenta no tiene /expenses habilitado o falla red
  }

  // Intentar también el endpoint de movimientos de caja (/cash-movements) si está disponible en la cuenta Fudo
  try {
    const start = `${dFrom}T00:00:00Z`;
    const end = `${addDays(dTo, 1)}T00:00:00Z`;
    const cmResp = await client.get("/cash-movements", {
      "filter[createdAt]": `and(gte.${start},lt.${end})`,
      include: "cashRegister",
      "page[size]": 500,
    });
    const inc = indexIncluded(cmResp.included);

    for (const cm of cmResp.data || []) {
      const attrs = cm.attributes || {};
      if (attrs.canceled) continue;
      const rawAmount = Number(attrs.amount || 0);
      const movType = normKey(attrs.type || attrs.movementType || "out");
      // Solo egresos / retiros de caja
      if (movType.includes("in") || movType.includes("ingreso")) continue;
      const monto = round(Math.abs(rawAmount), 2);
      if (monto <= 0) continue;

      const fecha =
        localDateFromUtc(attrs.createdAt || attrs.date) ||
        String(attrs.createdAt || attrs.date || dFrom).slice(0, 10);

      const crRef = cm.relationships?.cashRegister?.data;
      const crid = crRef && !Array.isArray(crRef) ? String(crRef.id) : "";
      const crObj = crid
        ? inc.get(`CashRegister|${crid}`) || inc.get(crid)
        : null;
      const cajaRaw = norm(crObj?.attributes?.name || "Principal");
      const cajaKey = normKey(cajaRaw);
      const desc = norm(attrs.description || attrs.comment || "Retiro de Caja");

      const isCajaGrande = cajaKey.includes("grande");
      const item: FudoSyncedExpense = {
        external_id: `cm-${cm.id}`,
        fecha,
        proveedor: desc,
        proveedor_key: normProvider(desc),
        categoria: isCajaGrande
          ? "Movimientos Caja Grande"
          : "Movimientos de Caja > Principal",
        descripcion: `${cajaRaw}: ${desc}`,
        monto,
        origen_fudo: isCajaGrande ? "caja_grande" : "caja_principal",
      };

      if (isCajaGrande) {
        cashGrande.push(item);
      } else {
        cashPrincipal.push(item);
      }
    }
  } catch {
    // /cash-movements es opcional según permisos del token Fudo
  }

  return {
    expenses,
    cash_principal: cashPrincipal,
    cash_grande: cashGrande,
  };
}

export function saveFudoExpensesAndCashToLocalDb(data: {
  expenses: FudoSyncedExpense[];
  cash_principal: FudoSyncedExpense[];
  cash_grande: FudoSyncedExpense[];
}) {
  return runTransaction(() => {
    for (const e of data.expenses) {
      executeSql(
        `INSERT INTO fudo_expenses (
          external_id, fecha, categoria, proveedor, proveedor_key, descripcion, monto, medio_pago, estado
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Fudo Insumos', 'confirmed')
        ON CONFLICT(external_id) DO UPDATE SET
          fecha = excluded.fecha,
          categoria = excluded.categoria,
          proveedor = excluded.proveedor,
          proveedor_key = excluded.proveedor_key,
          descripcion = excluded.descripcion,
          monto = excluded.monto`,
        [
          e.external_id,
          e.fecha,
          e.categoria,
          e.proveedor,
          e.proveedor_key,
          e.descripcion,
          e.monto,
        ]
      );
    }

    // Los movimientos de Caja > Principal se cargan como Gastos Externos discriminados
    for (const cp of data.cash_principal) {
      const extDesc = `[Caja Principal] ${cp.descripcion || cp.proveedor}`;
      const existing = executeSql(
        `UPDATE external_expenses
         SET monto = ?, fecha = ?, mes_key = ?
         WHERE proveedor_key = ? AND descripcion = ?`,
        [
          cp.monto,
          cp.fecha,
          cp.fecha.slice(0, 7),
          cp.proveedor_key,
          extDesc,
        ]
      );
      if (existing.changes === 0) {
        executeSql(
          `INSERT INTO external_expenses (
            fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key, descripcion, monto, es_fijo
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [
            cp.fecha,
            cp.fecha.slice(0, 7),
            "Movimientos de Caja > Principal",
            "movimientos de caja principal",
            cp.proveedor,
            cp.proveedor_key,
            extDesc,
            cp.monto,
          ]
        );
      }
    }

    return {
      fudo_insumos: data.expenses.length,
      caja_principal: data.cash_principal.length,
      caja_grande: data.cash_grande.length,
    };
  });
}
