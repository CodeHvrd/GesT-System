import crypto from "node:crypto";
import { hasPostgresUrl, pgQueryAll, pgQueryOne, withPg } from "./pg-db";
import { executeSql, queryOne, runTransaction } from "./local-db";
import { weekKey, todayAr, addDays, parseDate } from "../dates";
import { norm, normKey, normProvider, parseNumber, round } from "../format";

let lastHydratedAt = 0;
const HYDRATE_TTL_MS = 25_000;

function sha1(...parts: unknown[]): string {
  return crypto
    .createHash("sha1")
    .update(parts.map((p) => String(p ?? "")).join("|"), "utf-8")
    .digest("hex");
}

/**
 * Hidrata SQLite local desde Neon PostgreSQL cuando DATABASE_URL está configurado.
 * Garantiza que en Render (donde SQLite es efímero) los reportes semanales, mensuales,
 * sugerencias de proveedores y alertas trabajen siempre con toda la historia de Neon.
 */
export async function hydrateLocalFromPostgres(force = false): Promise<void> {
  if (!hasPostgresUrl()) return;
  const now = Date.now();
  if (!force && now - lastHydratedAt < HYDRATE_TTL_MS) {
    return;
  }

  try {
    const localSalesCount = Number(
      queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sales")?.n || 0
    );
    const localExpCount = Number(
      queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM expenses")?.n || 0
    );

    if (!force && localSalesCount > 0 && localExpCount > 0 && now - lastHydratedAt < 120_000) {
      return;
    }

    // 1. Traer ventas agregadas por fecha + categoría + producto desde Neon
    const pgSalesRows = await pgQueryAll<{
      fecha: string;
      categoria: string;
      producto: string;
      channel: string;
      cant: number;
      ing: number;
      cos: number;
    }>(`
      SELECT s.business_date::text AS fecha,
             COALESCE(c.name, 'Sin categoría') AS categoria,
             COALESCE(p.name, 'Producto') AS producto,
             COALESCE(s.channel, 'salon') AS channel,
             SUM(si.quantity)::float AS cant,
             SUM(si.line_total)::float AS ing,
             SUM(si.line_cost)::float AS cos
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE s.state = 'CLOSED' AND si.canceled = false
      GROUP BY 1, 2, 3, 4
      ORDER BY 1 DESC
      LIMIT 6000
    `);

    // 2. Traer gastos de Neon (expenses + external_expenses)
    const pgExpensesRows = await pgQueryAll<{
      id: string;
      source: string;
      fecha: string;
      categoria: string;
      proveedor: string;
      descripcion: string;
      monto: number;
    }>(`
      SELECT COALESCE(e.external_id, e.id::text) AS id,
             COALESCE(e.source, 'fudo') AS source,
             e.expense_date::text AS fecha,
             COALESCE(e.category_name, 'Mercadería') AS categoria,
             COALESCE(p.name, NULLIF(e.description, ''), 'Sin proveedor') AS proveedor,
             COALESCE(e.description, '') AS descripcion,
             COALESCE(e.amount, 0)::float AS monto
      FROM expenses e
      LEFT JOIN providers p ON p.id = e.provider_id
      ORDER BY e.expense_date DESC
      LIMIT 4000
    `);

    let pgExtRows: Array<{
      id: number;
      fecha: string;
      categoria: string;
      proveedor: string;
      descripcion: string;
      monto: number;
      es_fijo: boolean;
    }> = [];
    try {
      pgExtRows = await pgQueryAll(`
        SELECT id,
               COALESCE(expense_date::text, start_date::text, CURRENT_DATE::text) AS fecha,
               CASE WHEN kind = 'fijo' THEN 'Caja Grande (Fijo)' ELSE 'Caja Principal / Externo' END AS categoria,
               name AS proveedor,
               COALESCE(frequency, '') AS descripcion,
               amount::float AS monto,
               (kind = 'fijo') AS es_fijo
        FROM external_expenses
        ORDER BY id DESC
        LIMIT 1000
      `);
    } catch {
      // ignore if schema differs
    }

    runTransaction(() => {
      if (pgSalesRows.length > 0) {
        executeSql("DELETE FROM sales WHERE fuente LIKE 'pg:%' OR source = 'fudo'");
        for (const r of pgSalesRows) {
          const fecha = String(r.fecha || "").slice(0, 10);
          if (!fecha) continue;
          const wk = weekKey(fecha);
          const cat = norm(r.categoria) || "Sin categoría";
          const prod = norm(r.producto) || "Producto";
          const cant = round(Number(r.cant || 0), 2);
          const ing = round(Number(r.ing || 0), 2);
          const cos = round(Number(r.cos || 0), 2);
          const gan = round(ing - cos, 2);
          const h = sha1("pg-sale", fecha, cat, prod, r.channel);

          executeSql(
            `INSERT INTO sales (
              hash, semana_key, semana, fecha, mes, categoria, categoria_key,
              producto, cantidad, ingreso, costo, ganancia, ventas, cmv, fuente, source, channel
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fudo', ?)`,
            [
              h,
              wk,
              wk,
              fecha,
              fecha.slice(0, 7),
              cat,
              normKey(cat),
              prod,
              cant,
              ing,
              cos,
              gan,
              ing,
              cos,
              `pg:${h}`,
              r.channel || "salon",
            ]
          );
        }
      }

      if (pgExpensesRows.length > 0 || pgExtRows.length > 0) {
        executeSql("DELETE FROM expenses WHERE fuente LIKE 'pg:%'");
        for (const e of pgExpensesRows) {
          const fecha = String(e.fecha || "").slice(0, 10);
          if (!fecha) continue;
          const cat = norm(e.categoria) || "Mercadería";
          const prov = norm(e.proveedor);
          const monto = round(Number(e.monto || 0), 2);
          const h = sha1("pg-exp", e.source, e.id, fecha, monto);

          executeSql(
            `INSERT INTO expenses (
              hash, fecha, mes, mes_key, categoria, categoria_key,
              proveedor, proveedor_key, descripcion, cantidad, monto, medio_pago, fuente
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
            [
              h,
              fecha,
              fecha.slice(0, 7),
              fecha.slice(0, 7),
              cat,
              normKey(cat),
              prov,
              normProvider(prov),
              norm(e.descripcion),
              monto,
              e.source === "fudo" ? "Efectivo / Fudo" : "Planilla",
              `pg:${e.source}:${e.id}`,
            ]
          );

          if (e.source === "fudo") {
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
                String(e.id),
                fecha,
                cat,
                prov,
                normProvider(prov),
                norm(e.descripcion),
                monto,
              ]
            );
          }
        }

        for (const ext of pgExtRows) {
          const fecha = String(ext.fecha || "").slice(0, 10);
          if (!fecha) continue;
          const cat = norm(ext.categoria) || (ext.es_fijo ? "Estructura Fija" : "Caja Principal");
          const prov = norm(ext.proveedor);
          const monto = round(Number(ext.monto || 0), 2);
          const h = sha1("pg-ext", ext.id, fecha, monto);

          executeSql(
            `INSERT INTO expenses (
              hash, fecha, mes, mes_key, tipo, categoria, categoria_key,
              proveedor, proveedor_key, descripcion, cantidad, monto, medio_pago, fuente
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'Caja / Externo', ?)`,
            [
              h,
              fecha,
              fecha.slice(0, 7),
              fecha.slice(0, 7),
              ext.es_fijo ? "Fijo" : "Variable",
              cat,
              normKey(cat),
              prov,
              normProvider(prov),
              norm(ext.descripcion),
              monto,
              `pg:ext:${ext.id}`,
            ]
          );
        }
      }
    });

    lastHydratedAt = now;
  } catch {
    // Continuar con datos locales si falla la conexión momentánea
  }
}

/**
 * Registra un gasto o comprobante desde la App guardándolo simultáneamente en
 * SQLite local y en Neon PostgreSQL (expenses, external_expenses y/o supplier_invoices).
 */
export async function persistUnifiedExpenseToPg(input: {
  entryId?: number;
  fecha: string;
  fecha_vencimiento?: string;
  destino?: "caja_principal" | "caja_grande_variable" | "caja_grande_fijo" | "factura_proveedor" | "fudo_insumo";
  proveedor: string;
  categoria: string;
  descripcion: string;
  monto: number;
  medio_pago: string;
  comprobante: string;
  estado_pago?: "pendiente" | "pagado";
}): Promise<{ pg_saved: boolean; invoice_created: boolean }> {
  if (!hasPostgresUrl()) {
    return { pg_saved: false, invoice_created: false };
  }

  const fecha = parseDate(input.fecha) || todayAr();
  const destino = input.destino || "caja_principal";
  const esFijo = destino === "caja_grande_fijo";
  const esFactura =
    destino === "factura_proveedor" ||
    Boolean(input.comprobante) ||
    input.medio_pago.toLowerCase().includes("corriente") ||
    input.estado_pago === "pendiente";

  // Por defecto el recordatorio/vencimiento es 7 días después de cargada la factura
  const today = todayAr();
  const fechaVenc =
    parseDate(input.fecha_vencimiento) || addDays(today, 7);

  try {
    await withPg(async (pg) => {
      const vRes = await pg.query(
        "SELECT id FROM venues ORDER BY id ASC LIMIT 1"
      );
      const vid = vRes.rows[0]?.id || 1;

      const labelParts = [
        input.proveedor,
        input.categoria,
        input.descripcion,
        input.comprobante ? `Comp: ${input.comprobante}` : "",
      ].filter(Boolean);
      const nameLabel = labelParts.join(" · ").slice(0, 80) || "Gasto App";

      // 1. Si es Caja Principal o Caja Grande, guardar en external_expenses de Neon
      if (
        destino === "caja_principal" ||
        destino === "caja_grande_variable" ||
        destino === "caja_grande_fijo"
      ) {
        await pg.query(
          `INSERT INTO external_expenses (
            venue_id, kind, name, amount, expense_date, frequency, start_date
          ) VALUES ($1, $2, $3, $4, $5::date, $6, $5::date)`,
          [
            vid,
            esFijo ? "fijo" : "excepcional",
            nameLabel,
            round(input.monto, 2),
            fecha,
            esFijo ? "mensual" : destino,
          ]
        );
      }

      // 2. Guardar también en la tabla general expenses (source = 'manual')
      const extId = `app-${input.entryId || Date.now()}-${sha1(
        fecha,
        input.proveedor,
        input.monto,
        input.comprobante
      ).slice(0, 10)}`;

      let provId: number | null = null;
      if (input.proveedor) {
        const pRow = await pg.query(
          `INSERT INTO providers (venue_id, name)
           VALUES ($1, $2)
           ON CONFLICT (venue_id, name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [vid, input.proveedor]
        );
        provId = pRow.rows[0]?.id || null;
      }

      await pg.query(
        `INSERT INTO expenses (
           venue_id, source, external_id, expense_date, amount, description,
           provider_id, category_name, status, payload
         ) VALUES ($1, 'manual', $2, $3::date, $4, $5, $6, $7, $8, $9::jsonb)
         ON CONFLICT (venue_id, source, external_id) DO UPDATE
           SET amount = EXCLUDED.amount,
               description = EXCLUDED.description,
               category_name = EXCLUDED.category_name`,
        [
          vid,
          extId,
          fecha,
          round(input.monto, 2),
          input.descripcion || input.proveedor,
          provId,
          input.categoria,
          input.estado_pago || "pagado",
          JSON.stringify({
            destino,
            medio_pago: input.medio_pago,
            comprobante: input.comprobante,
            fecha_vencimiento: fechaVenc,
          }),
        ]
      );

      // 3. Si es Factura de Proveedor o Cuenta Corriente, registrar en supplier_invoices
      if (esFactura) {
        await pg.query(`
          CREATE TABLE IF NOT EXISTS supplier_invoices (
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
            origen            TEXT DEFAULT 'app',
            payload           JSONB,
            creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
            actualizado_en    TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);

        const estadoPago = input.estado_pago || "pendiente";
        await pg.query(
          `INSERT INTO supplier_invoices (
             external_id, fecha_emision, fecha_vencimiento, proveedor, proveedor_key,
             categoria, numero_factura, descripcion, monto, estado_pago, medio_pago,
             fecha_pago, origen, actualizado_en
           ) VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, 'app', now())
           ON CONFLICT (external_id) DO UPDATE
             SET fecha_vencimiento = EXCLUDED.fecha_vencimiento,
                 monto = EXCLUDED.monto,
                 estado_pago = EXCLUDED.estado_pago`,
          [
            extId,
            fecha,
            fechaVenc,
            input.proveedor || "Sin proveedor",
            normProvider(input.proveedor || "sin proveedor"),
            input.categoria || "Mercadería",
            input.comprobante || "",
            input.descripcion || "",
            round(input.monto, 2),
            estadoPago,
            input.medio_pago || "Cta. Corriente",
            estadoPago === "pagado" ? today : null,
          ]
        );
      }
    });

    return { pg_saved: true, invoice_created: esFactura };
  } catch {
    return { pg_saved: false, invoice_created: false };
  }
}
