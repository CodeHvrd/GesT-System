import crypto from "node:crypto";
import { addDays, localDateFromUtc, weekKey } from "../dates";
import { norm, normKey, normProvider, round, safeDiv } from "../format";
import { executeSql, runTransaction } from "../db/local-db";
import { hasPostgresUrl, pgQueryOne, withPg } from "../db/pg-db";
import { loadConfig, saveConfig } from "../config";
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

export interface PgSaleRecord {
  external_id: string;
  closed_at: string | null;
  business_date: string;
  sale_type: string | null;
  state: string;
  total: number;
  channel: string;
  channel_detail: string;
  cash_amount: number;
  virtual_amount: number;
  payload: Record<string, unknown>;
  items: Array<{
    product: string;
    category: string;
    quantity: number;
    unit_price: number | null;
    line_total: number;
    unit_cost: number | null;
    line_cost: number;
  }>;
}

/**
 * Resuelve las credenciales de Fudo desde:
 * 1) Variables de entorno / config.json local
 * 2) Tabla `fudo_credentials` en Neon PostgreSQL (si está configurada la base en la nube)
 */
export async function resolveFudoCredentials(custom?: {
  apiKey?: string | null;
  apiSecret?: string | null;
}): Promise<{
  apiKey: string;
  apiSecret: string;
  authUrl: string;
  apiUrl: string;
}> {
  const cfg = loadConfig();
  let apiKey = String(custom?.apiKey || cfg.fudo_api_key || "").trim();
  let apiSecret = String(
    custom?.apiSecret && custom.apiSecret !== "••••••••"
      ? custom.apiSecret
      : cfg.fudo_api_secret || ""
  ).trim();

  if ((!apiKey || !apiSecret) && hasPostgresUrl()) {
    try {
      const row = await pgQueryOne<{
        api_key_enc: string;
        api_secret_enc: string;
      }>(
        "SELECT api_key_enc, api_secret_enc FROM fudo_credentials ORDER BY updated_at DESC LIMIT 1"
      );
      if (row) {
        apiKey = apiKey || String(row.api_key_enc || "").trim();
        apiSecret = apiSecret || String(row.api_secret_enc || "").trim();
        if (apiKey && apiSecret) {
          saveConfig({
            fudo_api_key: apiKey,
            fudo_api_secret: apiSecret,
          });
        }
      }
    } catch {
      // tabla fudo_credentials puede no existir aún
    }
  }

  return {
    apiKey,
    apiSecret,
    authUrl: cfg.fudo_auth_url,
    apiUrl: cfg.fudo_api_url,
  };
}

/**
 * Guarda las credenciales de Fudo tanto en config.json como en `fudo_credentials` de Neon PostgreSQL.
 */
export async function saveFudoCredentialsEverywhere(
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const cleanKey = String(apiKey || "").trim();
  const cleanSecret = String(apiSecret || "").trim();
  if (!cleanKey || !cleanSecret) return;

  saveConfig({
    fudo_api_key: cleanKey,
    fudo_api_secret: cleanSecret,
  });

  if (hasPostgresUrl()) {
    try {
      await withPg(async (pg) => {
        const vRow = await pg.query(
          "SELECT id FROM venues WHERE slug = 'bois' ORDER BY id ASC LIMIT 1"
        );
        let venueId = vRow.rows[0]?.id;
        if (!venueId) {
          const ins = await pg.query(
            "INSERT INTO venues (name, slug) VALUES ('Bois', 'bois') RETURNING id"
          );
          venueId = ins.rows[0]?.id;
        }
        await pg.query(`
          CREATE TABLE IF NOT EXISTS fudo_credentials (
            venue_id       bigint PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
            api_key_enc    text NOT NULL,
            api_secret_enc text NOT NULL,
            updated_at     timestamptz NOT NULL DEFAULT now()
          )
        `);
        await pg.query(
          `INSERT INTO fudo_credentials (venue_id, api_key_enc, api_secret_enc, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (venue_id) DO UPDATE
             SET api_key_enc = EXCLUDED.api_key_enc,
                 api_secret_enc = EXCLUDED.api_secret_enc,
                 updated_at = now()`,
          [venueId, cleanKey, cleanSecret]
        );
      });
    } catch {
      // ignore if schema differs
    }
  }
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
    const catResp = await client.get("/product-categories", {
      "page[size]": 500,
    });
    for (const c of catResp.data || []) {
      categories[String(c.id)] = String(c.attributes?.name || "Sin categoría");
    }
  } catch {
    // optional
  }

  let page = 1;
  while (page <= 10) {
    const data = await client.get("/products", {
      "page[size]": 500,
      "page[number]": page,
      include: "proportions.ingredient,productCategory",
    });
    const rows = data.data || [];
    const inc = indexIncluded(data.included);

    for (const p of rows) {
      const a = p.attributes || {};
      const direct =
        a.cost !== null && a.cost !== undefined ? Number(a.cost) : 0;
      let computed = 0;
      let hasRecipe = false;
      const refs = p.relationships?.proportions?.data;
      if (Array.isArray(refs) && refs.length > 0) {
        for (const ref of refs) {
          const pr =
            inc.get(`Proportion|${String(ref.id)}`) || inc.get(String(ref.id));
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
        name: String(a.name || "Producto").trim() || "Producto",
        categoryId: catId,
        categoryName: catName.trim() || "Sin categoría",
        price: Number(a.price || 0),
        cost: finalCost,
        hasRecipe: hasRecipe || direct > 0,
      };
    }

    if (rows.length < 500) break;
    page += 1;
  }

  return { products, categories };
}

function isClosePrice(a: number, b: number, tol = 0.02): boolean {
  if (!b) return Math.abs(a) < 1;
  return Math.abs(a - b) / Math.abs(b) <= tol;
}

function detectSalePriceMode(
  items: Array<{ qty: number; rawPrice: number }>,
  total: number
): "linea" | "unidad" {
  if (!items.length) return "linea";
  const line = items.reduce((s, i) => s + i.rawPrice, 0);
  const unit = items.reduce((s, i) => s + i.rawPrice * i.qty, 0);
  if (isClosePrice(line, total) || !isClosePrice(unit, total)) {
    return "linea";
  }
  return "unidad";
}

export function buildLines(
  rawSales: JsonApiResource[],
  itemsMap: Map<string, JsonApiResource>,
  catalog: Record<string, CatalogProduct>
): {
  lines: FudoSaleLine[];
  pgSales: PgSaleRecord[];
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

  const pgSales: PgSaleRecord[] = [];

  for (const sale of rawSales) {
    const attrs = sale.attributes || {};
    const state = String(attrs.saleState || "CLOSED").toUpperCase();
    if (state !== "CLOSED") continue;
    const fecha =
      localDateFromUtc(attrs.closedAt || attrs.createdAt) ||
      String(attrs.closedAt || attrs.createdAt || "").slice(0, 10);
    if (!fecha) continue;

    salesClosed += 1;
    const saleTotal = Number(attrs.total || 0);
    totalFudoSaleHeader += saleTotal;

    const saleType = String(attrs.saleType || "").toUpperCase();
    let origin = "";
    const orderRefs = sale.relationships?.orders?.data;
    const oRefs = Array.isArray(orderRefs)
      ? orderRefs
      : orderRefs
      ? [orderRefs]
      : [];
    for (const oRef of oRefs) {
      const ord =
        itemsMap.get(`Order|${String(oRef.id)}`) ||
        itemsMap.get(String(oRef.id));
      const oOrigin = String(ord?.attributes?.origin || "").trim();
      if (oOrigin) origin = oOrigin;
    }

    let channel: "salon" | "takeaway" | "delivery" = "salon";
    let channelDetail = "salon";
    if (saleType === "DELIVERY" || origin) {
      channel = "delivery";
      channelDetail = origin || "delivery";
    } else if (saleType === "TAKEAWAY") {
      channel = "takeaway";
      channelDetail = "takeaway";
    }

    const itemRefs = sale.relationships?.items?.data;
    const refs = Array.isArray(itemRefs)
      ? itemRefs
      : itemRefs
      ? [itemRefs]
      : [];

    const saleParsedItems: Array<{
      producto: string;
      categoria: string;
      qty: number;
      rawPrice: number;
      costVal: number;
      costIsUnit: boolean;
    }> = [];

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
      const prodInc = pid
        ? itemsMap.get(`Product|${pid}`) || itemsMap.get(pid)
        : null;
      const catProd = catalog[pid];

      const prodName =
        (
          catProd?.name ||
          String(prodInc?.attributes?.name || ia.name || "Producto")
        ).trim() || "Producto";

      let catName = catProd?.categoryName || "";
      if (!catName && prodInc) {
        const cRef = prodInc.relationships?.productCategory?.data;
        const cid = cRef && !Array.isArray(cRef) ? String(cRef.id) : "";
        const catInc = cid
          ? itemsMap.get(`ProductCategory|${cid}`) || itemsMap.get(cid)
          : null;
        catName = String(catInc?.attributes?.name || "").trim();
      }
      if (!catName) catName = "Sin categoría";

      const rawItemCost =
        ia.cost !== null && ia.cost !== undefined ? Number(ia.cost) : 0;
      let costVal = 0;
      let costIsUnit = true;
      if (rawItemCost > 0) {
        costVal = rawItemCost;
        costIsUnit = false;
      } else if (catProd && catProd.cost > 0) {
        costVal = catProd.cost;
        costIsUnit = true;
      }

      const unitCost = costIsUnit ? costVal : safeDiv(costVal, qty);

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

      saleParsedItems.push({
        producto: prodName,
        categoria: catName,
        qty,
        rawPrice,
        costVal,
        costIsUnit,
      });
    }

    // Medios de pago de la venta para Neon PostgreSQL
    let cashAmt = 0;
    let virtualAmt = 0;
    const payMethods: Record<string, number> = {};
    const payRefs = sale.relationships?.payments?.data;
    const pRefs = Array.isArray(payRefs)
      ? payRefs
      : payRefs
      ? [payRefs]
      : [];
    for (const pRef of pRefs) {
      const pay =
        itemsMap.get(`Payment|${String(pRef.id)}`) ||
        itemsMap.get(String(pRef.id));
      if (!pay) continue;
      const pa = pay.attributes || {};
      if (pa.canceled) continue;
      const pAmt = Number(pa.amount || 0);
      const pmRef = pay.relationships?.paymentMethod?.data;
      const pmid = pmRef && !Array.isArray(pmRef) ? String(pmRef.id) : "";
      const pm = pmid
        ? itemsMap.get(`PaymentMethod|${pmid}`) || itemsMap.get(pmid)
        : null;
      const pma = pm?.attributes || {};
      const pmName = String(pma.name || "Otro").trim() || "Otro";
      const pmCode = String(pma.code || "").trim().toLowerCase();
      payMethods[pmName] = round((payMethods[pmName] || 0) + pAmt, 2);
      if (pmCode === "cash" || pmName.toLowerCase().includes("efectivo")) {
        cashAmt += pAmt;
      } else {
        virtualAmt += pAmt;
      }
    }
    if (cashAmt === 0 && virtualAmt === 0 && saleTotal > 0) {
      if (channel === "delivery") {
        virtualAmt = saleTotal;
        payMethods["Online Pedidos Ya"] = round(saleTotal, 2);
      } else {
        cashAmt = saleTotal;
        payMethods["Efectivo"] = round(saleTotal, 2);
      }
    }

    const saleMode = detectSalePriceMode(saleParsedItems, saleTotal);
    const pgItems = saleParsedItems.map((it) => {
      const lineTotal =
        saleMode === "unidad"
          ? round(it.rawPrice * it.qty, 2)
          : round(it.rawPrice, 2);
      const unitPrice =
        saleMode === "unidad"
          ? it.rawPrice
          : it.qty
          ? round(it.rawPrice / it.qty, 4)
          : null;
      const lineCost =
        it.costIsUnit || saleMode === "unidad"
          ? round(it.costVal * it.qty, 2)
          : round(it.costVal, 2);
      const unitCost =
        it.costIsUnit || saleMode === "unidad"
          ? round(it.costVal, 4)
          : it.qty
          ? round(it.costVal / it.qty, 4)
          : null;

      return {
        product: it.producto,
        category: it.categoria,
        quantity: it.qty,
        unit_price: unitPrice,
        line_total: lineTotal,
        unit_cost: unitCost,
        line_cost: lineCost,
      };
    });

    pgSales.push({
      external_id: String(sale.id),
      closed_at: attrs.closedAt ? String(attrs.closedAt) : null,
      business_date: fecha,
      sale_type: attrs.saleType ? String(attrs.saleType) : null,
      state,
      total: saleTotal,
      channel,
      channel_detail: channelDetail,
      cash_amount: round(cashAmt, 2),
      virtual_amount: round(virtualAmt, 2),
      payload: {
        ...sale,
        payments_summary: {
          cash: round(cashAmt, 2),
          virtual: round(virtualAmt, 2),
          methods: payMethods,
        },
      },
      items: pgItems,
    });
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
    pgSales,
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
  // En Argentina (UTC-3), el día comercial empieza a las 03:00:00Z
  const start = `${dFrom}T03:00:00Z`;
  const end = `${addDays(dTo, 1)}T03:00:00Z`;

  const allSales: JsonApiResource[] = [];
  const allIncluded: JsonApiResource[] = [];

  let page = 1;
  while (page <= 40) {
    const resp = await client.get("/sales", {
      "filter[closedAt]": `and(gte.${start},lt.${end})`,
      include:
        "items,items.product,items.product.productCategory,orders,payments,payments.paymentMethod",
      "page[size]": 500,
      "page[number]": page,
      sort: "id",
    });

    const pageSales = resp.data || [];
    allSales.push(...pageSales);
    if (resp.included && resp.included.length > 0) {
      allIncluded.push(...resp.included);
    }

    if (pageSales.length < 500) break;
    page += 1;
  }

  const inc = indexIncluded(allIncluded);
  const built = buildLines(allSales, inc, catalogData.products);
  return {
    ...built,
    catalog: catalogData.products,
  };
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
  fecha_vencimiento?: string;
  proveedor: string;
  proveedor_key: string;
  categoria: string;
  numero_factura?: string;
  descripcion: string;
  monto: number;
  status?: string;
  medio_pago?: string;
  origen_fudo: "insumo_receta" | "caja_principal" | "caja_grande";
  payload?: Record<string, unknown>;
}

/**
 * Descarga Gastos de Fudo (`/expenses`: ingredientes y materia prima que actualizan el costo del producto)
 * y Movimientos de Caja (`/cash-movements` o categorías de Caja Principal / Caja Grande).
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
    let page = 1;
    while (page <= 30) {
      const resp = await client.get("/expenses", {
        "filter[date]": `and(gte.${dFrom},lte.${dTo})`,
        include: "provider,expenseCategory,cashRegister",
        "page[size]": 500,
        "page[number]": page,
        sort: "id",
      });
      const rows = resp.data || [];
      const inc = indexIncluded(resp.included);

      for (const exp of rows) {
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
        const numeroFactura = norm(
          attrs.receiptNumber || attrs.invoiceNumber || ""
        );
        const fechaVenc = attrs.dueDate ? String(attrs.dueDate).slice(0, 10) : "";
        const medioPago = norm(
          attrs.paymentMethod || attrs.paymentType || (attrs.paymentStatus === "pending" ? "Cta. Corriente" : "Efectivo")
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
          fecha_vencimiento: fechaVenc,
          proveedor: proveedor || descripcion || "Sin proveedor",
          proveedor_key: normProvider(proveedor || descripcion),
          categoria,
          numero_factura: numeroFactura,
          descripcion,
          monto,
          status: attrs.status
            ? String(attrs.status)
            : attrs.paymentStatus
            ? String(attrs.paymentStatus)
            : "cargado",
          medio_pago: medioPago,
          origen_fudo: origenFudo,
          payload: exp as unknown as Record<string, unknown>,
        };

        if (origenFudo === "caja_principal") {
          cashPrincipal.push(item);
        } else if (origenFudo === "caja_grande") {
          cashGrande.push(item);
        } else {
          expenses.push(item);
        }
      }

      if (rows.length < 500) break;
      page += 1;
    }
  } catch {
    // Si la cuenta no tiene /expenses habilitado o falla red
  }

  // Intentar también el endpoint de movimientos de caja (/cash-movements) si está disponible en la cuenta Fudo
  try {
    const start = `${dFrom}T03:00:00Z`;
    const end = `${addDays(dTo, 1)}T03:00:00Z`;
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
        status: "cargado",
        origen_fudo: isCajaGrande ? "caja_grande" : "caja_principal",
        payload: cm as unknown as Record<string, unknown>,
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

      // Guardar también en supplier_invoices (Facturas de Proveedores)
      const estadoPago =
        e.status === "paid" || e.status === "pagado" || e.medio_pago === "Efectivo"
          ? "pagado"
          : "pendiente";
      const medioPago = e.medio_pago || "Cta. Corriente";
      const fechaVenc = e.fecha_vencimiento || addDays(e.fecha, 14);

      executeSql(
        `INSERT INTO supplier_invoices (
          external_id, fecha_emision, fecha_vencimiento, proveedor, proveedor_key,
          categoria, numero_factura, descripcion, monto, estado_pago, medio_pago,
          origen, payload, actualizado_en
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fudo', ?, datetime('now'))
        ON CONFLICT(external_id) DO UPDATE SET
          fecha_emision = excluded.fecha_emision,
          fecha_vencimiento = COALESCE(NULLIF(excluded.fecha_vencimiento, ''), supplier_invoices.fecha_vencimiento),
          proveedor = excluded.proveedor,
          proveedor_key = excluded.proveedor_key,
          categoria = excluded.categoria,
          numero_factura = COALESCE(NULLIF(excluded.numero_factura, ''), supplier_invoices.numero_factura),
          descripcion = excluded.descripcion,
          monto = excluded.monto,
          estado_pago = CASE WHEN supplier_invoices.estado_pago = 'pagado' THEN 'pagado' ELSE excluded.estado_pago END,
          medio_pago = excluded.medio_pago,
          actualizado_en = datetime('now')`,
        [
          e.external_id,
          e.fecha,
          fechaVenc,
          e.proveedor,
          e.proveedor_key,
          e.categoria,
          e.numero_factura || "",
          e.descripcion,
          e.monto,
          estadoPago,
          medioPago,
          JSON.stringify(e.payload || {}),
        ]
      );
    }

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

/**
 * Sincroniza ventas, ítems, catálogo, gastos y corridas (`sync_runs`) directamente en Neon PostgreSQL.
 */
export async function syncFudoToPostgres(params: {
  dFrom: string;
  dTo: string;
  pgSales: PgSaleRecord[];
  catalog: Record<string, CatalogProduct>;
  expData?: {
    expenses: FudoSyncedExpense[];
    cash_principal: FudoSyncedExpense[];
    cash_grande: FudoSyncedExpense[];
  };
}): Promise<{
  ok: boolean;
  sales_written: number;
  expenses_written: number;
  run_id?: number;
}> {
  if (!hasPostgresUrl()) {
    return { ok: false, sales_written: 0, expenses_written: 0 };
  }

  return withPg(async (pg) => {
    const vRes = await pg.query(
      "SELECT id FROM venues WHERE slug = 'bois' ORDER BY id ASC LIMIT 1"
    );
    let venueId = vRes.rows[0]?.id;
    if (!venueId) {
      const ins = await pg.query(
        "INSERT INTO venues (name, slug) VALUES ('Bois', 'bois') RETURNING id"
      );
      venueId = ins.rows[0]?.id;
    }

    await pg.query(
      "ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_amount numeric(12,2) NOT NULL DEFAULT 0"
    );
    await pg.query(
      "ALTER TABLE sales ADD COLUMN IF NOT EXISTS virtual_amount numeric(12,2) NOT NULL DEFAULT 0"
    );

    const runRes = await pg.query(
      `INSERT INTO sync_runs (venue_id, kind, range_start, range_end, started_at, status)
       VALUES ($1, 'fudo_sales', $2::date, $3::date, clock_timestamp(), 'running')
       RETURNING id`,
      [venueId, params.dFrom, params.dTo]
    );
    const runId = runRes.rows[0]?.id;

    try {
      const categoriesSet = new Set<string>();
      const productsMap = new Map<
        string,
        { name: string; category: string; cost: number | null; price: number | null }
      >();

      for (const p of Object.values(params.catalog || {})) {
        if (p.categoryName) categoriesSet.add(p.categoryName);
        productsMap.set(p.name, {
          name: p.name,
          category: p.categoryName || "Sin categoría",
          cost: p.cost > 0 ? p.cost : null,
          price: p.price > 0 ? p.price : null,
        });
      }

      for (const s of params.pgSales) {
        for (const it of s.items) {
          categoriesSet.add(it.category || "Sin categoría");
          if (!productsMap.has(it.product)) {
            productsMap.set(it.product, {
              name: it.product,
              category: it.category || "Sin categoría",
              cost: it.unit_cost,
              price: it.unit_price,
            });
          }
        }
      }

      const catIdMap = new Map<string, number>();
      if (categoriesSet.size > 0) {
        const catPayload = Array.from(categoriesSet).map((name) => ({ name }));
        const cRows = await pg.query(
          `INSERT INTO product_categories (venue_id, name)
           SELECT $1, x.name
             FROM jsonb_to_recordset($2::jsonb) AS x(name text)
           ON CONFLICT (venue_id, name) DO UPDATE
             SET name = EXCLUDED.name
           RETURNING id, name`,
          [venueId, JSON.stringify(catPayload)]
        );
        for (const r of cRows.rows) {
          catIdMap.set(String(r.name), Number(r.id));
        }
      }

      const prodIdMap = new Map<string, number>();
      if (productsMap.size > 0) {
        const prodPayload = Array.from(productsMap.values()).map((p) => ({
          name: p.name,
          category_id: catIdMap.get(p.category) || null,
          cost: p.cost,
          price: p.price,
        }));
        const pRows = await pg.query(
          `INSERT INTO products (venue_id, name, category_id, cost, price)
           SELECT $1, x.name, x.category_id, x.cost, x.price
             FROM jsonb_to_recordset($2::jsonb) AS x(
               name text, category_id bigint, cost numeric, price numeric
             )
           ON CONFLICT (venue_id, name) DO UPDATE
             SET category_id = COALESCE(EXCLUDED.category_id, products.category_id),
                 cost = COALESCE(EXCLUDED.cost, products.cost),
                 price = COALESCE(EXCLUDED.price, products.price),
                 updated_at = now()
           RETURNING id, name`,
          [venueId, JSON.stringify(prodPayload)]
        );
        for (const r of pRows.rows) {
          prodIdMap.set(String(r.name), Number(r.id));
        }
      }

      let salesWritten = 0;
      if (params.pgSales.length > 0) {
        const salesPayload = params.pgSales.map((s) => ({
          external_id: s.external_id,
          closed_at: s.closed_at,
          business_date: s.business_date,
          sale_type: s.sale_type,
          state: s.state,
          total: s.total,
          channel: s.channel,
          channel_detail: s.channel_detail,
          cash_amount: s.cash_amount,
          virtual_amount: s.virtual_amount,
          payload: s.payload,
        }));

        const sRows = await pg.query(
          `INSERT INTO sales (
             venue_id, source, external_id, closed_at, business_date,
             sale_type, state, total, channel, channel_detail,
             cash_amount, virtual_amount, payload
           )
           SELECT $1, 'fudo', x.external_id, x.closed_at::timestamptz, x.business_date::date,
                  x.sale_type, x.state, x.total, x.channel, x.channel_detail,
                  COALESCE(x.cash_amount, 0), COALESCE(x.virtual_amount, 0), x.payload
             FROM jsonb_to_recordset($2::jsonb) AS x(
               external_id text, closed_at text, business_date text,
               sale_type text, state text, total numeric,
               channel text, channel_detail text,
               cash_amount numeric, virtual_amount numeric, payload jsonb
             )
           ON CONFLICT (venue_id, source, external_id) DO UPDATE
             SET closed_at = EXCLUDED.closed_at,
                 business_date = EXCLUDED.business_date,
                 sale_type = EXCLUDED.sale_type,
                 state = EXCLUDED.state,
                 total = EXCLUDED.total,
                 channel = EXCLUDED.channel,
                 channel_detail = EXCLUDED.channel_detail,
                 cash_amount = EXCLUDED.cash_amount,
                 virtual_amount = EXCLUDED.virtual_amount,
                 payload = EXCLUDED.payload,
                 fetched_at = now()
           RETURNING id, external_id`,
          [venueId, JSON.stringify(salesPayload)]
        );

        const saleIdMap = new Map<string, number>();
        const saleIds: number[] = [];
        for (const r of sRows.rows) {
          const sid = Number(r.id);
          saleIdMap.set(String(r.external_id), sid);
          saleIds.push(sid);
        }

        if (saleIds.length > 0) {
          await pg.query("DELETE FROM sale_items WHERE sale_id = ANY($1::bigint[])", [
            saleIds,
          ]);
        }

        const flatItems: Array<Record<string, unknown>> = [];
        for (const s of params.pgSales) {
          const sid = saleIdMap.get(s.external_id);
          if (!sid) continue;
          for (const it of s.items) {
            flatItems.push({
              sale_id: sid,
              product_id: prodIdMap.get(it.product) || null,
              quantity: it.quantity,
              unit_price: it.unit_price,
              line_total: it.line_total,
              unit_cost: it.unit_cost,
              line_cost: it.line_cost,
            });
          }
        }

        if (flatItems.length > 0) {
          await pg.query(
            `INSERT INTO sale_items (
               sale_id, product_id, quantity, unit_price, line_total,
               unit_cost, line_cost, canceled
             )
             SELECT x.sale_id, x.product_id, x.quantity, x.unit_price, x.line_total,
                    x.unit_cost, x.line_cost, false
               FROM jsonb_to_recordset($1::jsonb) AS x(
                 sale_id bigint, product_id bigint, quantity numeric,
                 unit_price numeric, line_total numeric, unit_cost numeric, line_cost numeric
               )`,
            [JSON.stringify(flatItems)]
          );
        }

        const syncedDates = Array.from(
          new Set(params.pgSales.map((s) => s.business_date))
        );
        if (syncedDates.length > 0) {
          await pg.query(
            "DELETE FROM sales WHERE venue_id = $1 AND source = 'sheet' AND business_date = ANY($2::date[])",
            [venueId, syncedDates]
          );
        }

        salesWritten = params.pgSales.length;
      }

      let expensesWritten = 0;
      const allFudoExp = [
        ...(params.expData?.expenses || []),
        ...(params.expData?.cash_principal || []),
        ...(params.expData?.cash_grande || []),
      ];

      if (allFudoExp.length > 0) {
        const provSet = new Set<string>();
        const expCatSet = new Set<string>();
        for (const e of allFudoExp) {
          if (e.proveedor) provSet.add(e.proveedor);
          if (e.categoria) expCatSet.add(e.categoria);
        }

        const provIdMap = new Map<string, number>();
        if (provSet.size > 0) {
          const pRows = await pg.query(
            `INSERT INTO providers (venue_id, name)
             SELECT $1, x.name
               FROM jsonb_to_recordset($2::jsonb) AS x(name text)
             ON CONFLICT (venue_id, name) DO UPDATE
               SET name = EXCLUDED.name
             RETURNING id, name`,
            [venueId, JSON.stringify(Array.from(provSet).map((name) => ({ name })))]
          );
          for (const r of pRows.rows) {
            provIdMap.set(String(r.name), Number(r.id));
          }
        }

        const ecIdMap = new Map<string, number>();
        if (expCatSet.size > 0) {
          const ecRows = await pg.query(
            `INSERT INTO expense_categories (venue_id, name)
             SELECT $1, x.name
               FROM jsonb_to_recordset($2::jsonb) AS x(name text)
             ON CONFLICT (venue_id, name) DO UPDATE
               SET name = EXCLUDED.name
             RETURNING id, name`,
            [venueId, JSON.stringify(Array.from(expCatSet).map((name) => ({ name })))]
          );
          for (const r of ecRows.rows) {
            ecIdMap.set(String(r.name), Number(r.id));
          }
        }

        const expPayload = allFudoExp.map((e) => ({
          external_id: e.external_id,
          expense_date: e.fecha,
          amount: e.monto,
          description: e.descripcion || e.proveedor,
          provider_id: provIdMap.get(e.proveedor) || null,
          category_id: ecIdMap.get(e.categoria) || null,
          category_name: e.categoria,
          status: e.status || "cargado",
          payload: e.payload || {},
        }));

        await pg.query(
          `INSERT INTO expenses (
             venue_id, source, external_id, expense_date, amount, description,
             provider_id, category_id, category_name, status, payload
           )
           SELECT $1, 'fudo', x.external_id, x.expense_date::date, x.amount, x.description,
                  x.provider_id, x.category_id, x.category_name, x.status, x.payload
             FROM jsonb_to_recordset($2::jsonb) AS x(
               external_id text, expense_date text, amount numeric, description text,
               provider_id bigint, category_id bigint, category_name text,
               status text, payload jsonb
             )
           ON CONFLICT (venue_id, source, external_id) DO UPDATE
             SET expense_date = EXCLUDED.expense_date,
                 amount = EXCLUDED.amount,
                 description = EXCLUDED.description,
                 provider_id = EXCLUDED.provider_id,
                 category_id = EXCLUDED.category_id,
                 category_name = EXCLUDED.category_name,
                 status = EXCLUDED.status,
                 payload = EXCLUDED.payload,
                 fetched_at = now()`,
          [venueId, JSON.stringify(expPayload)]
        );

        // Guardar facturas de proveedores también en supplier_invoices de Postgres
        const invPayload = allFudoExp.map((e) => {
          const estadoPago =
            e.status === "paid" || e.status === "pagado" || e.medio_pago === "Efectivo"
              ? "pagado"
              : "pendiente";
          const medioPago = e.medio_pago || "Cta. Corriente";
          const fechaVenc = e.fecha_vencimiento || addDays(e.fecha, 14);
          return {
            external_id: e.external_id,
            fecha_emision: e.fecha,
            fecha_vencimiento: fechaVenc,
            proveedor: e.proveedor || "Sin proveedor",
            proveedor_key: e.proveedor_key || normProvider(e.proveedor || ""),
            categoria: e.categoria || "",
            numero_factura: e.numero_factura || "",
            descripcion: e.descripcion || "",
            monto: e.monto,
            estado_pago: estadoPago,
            medio_pago: medioPago,
            payload: e.payload || {},
          };
        });

        await pg.query(
          `CREATE TABLE IF NOT EXISTS supplier_invoices (
             id                BIGSERIAL PRIMARY KEY,
             external_id       TEXT UNIQUE,
             fecha_emision     DATE NOT NULL,
             fecha_vencimiento DATE,
             proveedor         TEXT NOT NULL,
             proveedor_key     TEXT NOT NULL,
             categoria         TEXT,
             numero_factura    TEXT,
             descripcion       TEXT,
             monto             NUMERIC(14, 2) NOT NULL DEFAULT 0,
             estado_pago       TEXT NOT NULL DEFAULT 'pendiente',
             medio_pago        TEXT DEFAULT 'Cta. Corriente',
             fecha_pago        DATE,
             origen            TEXT DEFAULT 'fudo',
             payload           JSONB,
             creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
             actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
           );
           CREATE INDEX IF NOT EXISTS ix_pg_sinv_prov ON supplier_invoices(proveedor_key);
           CREATE INDEX IF NOT EXISTS ix_pg_sinv_estado ON supplier_invoices(estado_pago);
           CREATE INDEX IF NOT EXISTS ix_pg_sinv_venc ON supplier_invoices(fecha_vencimiento);`
        );

        await pg.query(
          `INSERT INTO supplier_invoices (
             external_id, fecha_emision, fecha_vencimiento, proveedor, proveedor_key,
             categoria, numero_factura, descripcion, monto, estado_pago, medio_pago,
             origen, payload, actualizado_en
           )
           SELECT x.external_id, x.fecha_emision::date, x.fecha_vencimiento::date,
                  x.proveedor, x.proveedor_key, x.categoria, x.numero_factura,
                  x.descripcion, x.monto, x.estado_pago, x.medio_pago,
                  'fudo', x.payload, now()
             FROM jsonb_to_recordset($1::jsonb) AS x(
               external_id text, fecha_emision text, fecha_vencimiento text,
               proveedor text, proveedor_key text, categoria text,
               numero_factura text, descripcion text, monto numeric,
               estado_pago text, medio_pago text, payload jsonb
             )
           ON CONFLICT (external_id) DO UPDATE
             SET fecha_emision = EXCLUDED.fecha_emision,
                 fecha_vencimiento = COALESCE(EXCLUDED.fecha_vencimiento, supplier_invoices.fecha_vencimiento),
                 proveedor = EXCLUDED.proveedor,
                 proveedor_key = EXCLUDED.proveedor_key,
                 categoria = EXCLUDED.categoria,
                 numero_factura = COALESCE(NULLIF(EXCLUDED.numero_factura, ''), supplier_invoices.numero_factura),
                 descripcion = EXCLUDED.descripcion,
                 monto = EXCLUDED.monto,
                 estado_pago = CASE WHEN supplier_invoices.estado_pago = 'pagado' THEN 'pagado' ELSE EXCLUDED.estado_pago END,
                 medio_pago = EXCLUDED.medio_pago,
                 actualizado_en = now()`,
          [JSON.stringify(invPayload)]
        );
        expensesWritten = allFudoExp.length;
      }

      if (runId) {
        await pg.query(
          `UPDATE sync_runs
              SET status = 'ok',
                  rows_read = $1,
                  rows_written = $2,
                  finished_at = clock_timestamp()
            WHERE id = $3`,
          [params.pgSales.length, salesWritten, runId]
        );
      }

      return {
        ok: true,
        sales_written: salesWritten,
        expenses_written: expensesWritten,
        run_id: runId,
      };
    } catch (err) {
      if (runId) {
        await pg.query(
          `UPDATE sync_runs
              SET status = 'error',
                  message = $1,
                  finished_at = clock_timestamp()
            WHERE id = $2`,
          [String((err as Error).message || err).slice(0, 1000), runId]
        );
      }
      throw err;
    }
  });
}
