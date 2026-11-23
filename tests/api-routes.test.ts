import { describe, it, expect, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  DatabaseSync,
  initSqliteSchema,
  setTestSqliteDb,
  executeSql,
} from "../src/lib/db/local-db";
import { GET as getHealth } from "../src/app/api/health/route";
import { GET as getHealthz } from "../src/app/api/healthz/route";
import { GET as getReadyz } from "../src/app/api/readyz/route";
import { GET as getMeta } from "../src/app/api/meta/route";
import { GET as getDashboard } from "../src/app/api/dashboard/route";
import { GET as getDashboardSummary } from "../src/app/api/dashboard/summary/route";
import { GET as getDashboardSales } from "../src/app/api/dashboard/sales/route";
import { GET as getDashboardExpenses } from "../src/app/api/dashboard/expenses/route";
import { GET as getDashboardReview } from "../src/app/api/dashboard/review/route";
import {
  GET as getExternal,
  POST as postExternal,
  DELETE as deleteExternal,
} from "../src/app/api/external/route";
import { GET as getOverview } from "../src/app/api/overview/route";
import { GET as getWeek } from "../src/app/api/week/route";
import { GET as getMonth } from "../src/app/api/month/route";
import { GET as getExpenses } from "../src/app/api/expenses/route";
import { GET as getSuggest } from "../src/app/api/suggest/route";
import { GET as getEntries, POST as postEntries } from "../src/app/api/entries/route";
import { POST as postDiscard } from "../src/app/api/entries/discard/route";
import { GET as getPasteWeek } from "../src/app/api/paste/week/route";
import { GET as getAlerts } from "../src/app/api/alerts/route";
import { GET as getQuality } from "../src/app/api/quality/route";
import { GET as getConfig } from "../src/app/api/config/route";
import { GET as getWeekCsv } from "../src/app/api/export/week.csv/route";
import {
  GET as getInvoices,
  POST as postInvoices,
  PATCH as patchInvoices,
} from "../src/app/api/invoices/route";
import { POST as postScanInvoice } from "../src/app/api/invoices/scan/route";
import { addDays, todayAr } from "../src/lib/dates";
import { middleware } from "../src/middleware";

describe("Next.js Divided API Routes & Auth Middleware", () => {
  beforeEach(() => {
    const mem = new DatabaseSync(":memory:");
    initSqliteSchema(mem);
    setTestSqliteDb(mem);

    executeSql(
      `INSERT INTO sales (semana_key, fecha, categoria, categoria_key, producto, cantidad, ingreso, costo, ganancia, fuente)
       VALUES ('2026-04-S2', '2026-04-10', 'Cafetería', 'cafeteria', 'Espresso', 10, 25000, 6000, 19000, 'fudo:1')`
    );
    executeSql(
      `INSERT INTO expenses (fila_origen, fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key, descripcion, cantidad, monto, medio_pago, fuente)
       VALUES (1, '2026-04-10', '2026-04', 'Mercadería', 'mercaderia', 'Distribuidora Café', 'distribuidora cafe', 'Café en grano', 1, 10000, 'Efectivo', 'sheet')`
    );
  });

  it("serves /api/health, /api/healthz, /api/readyz, and /api/meta", async () => {
    const h1 = await (await getHealth()).json();
    expect(h1.ok).toBe(true);
    expect(h1.counts.sales).toBe(1);

    const h2 = await (await getHealthz()).json();
    expect(h2.status).toBe("ok");

    const r1 = await (await getReadyz()).json();
    expect(r1.status).toBe("ready");

    const m1 = await (await getMeta()).json();
    expect(m1.ok).toBe(true);
    expect(m1.canales).toContain("salon");
  });

  it("serves divided /api/dashboard/* endpoints", async () => {
    const url = "http://localhost:3000/api/dashboard?desde=2026-04-01&hasta=2026-04-30";
    const full = await (await getDashboard(new Request(url))).json();
    expect(full.ok).toBe(true);
    expect(full.summary.kpis.ventas_netas).toBe(25000);

    const sum = await (await getDashboardSummary(new Request(url))).json();
    expect(sum.ok).toBe(true);
    expect(sum.summary.kpis.ganancia_bruta).toBe(19000);

    const sales = await (await getDashboardSales(new Request(url))).json();
    expect(sales.ok).toBe(true);
    expect(sales.categories.items.length).toBe(1);

    const exp = await (await getDashboardExpenses(new Request(url))).json();
    expect(exp.ok).toBe(true);
    expect(exp.totales.planilla_reposicion).toBe(10000);

    const rev = await (await getDashboardReview(new Request(url))).json();
    expect(rev.ok).toBe(true);
    expect(rev.resumen.total).toBeGreaterThan(0);
  });

  it("handles /api/external GET, POST, DELETE", async () => {
    const createReq = new Request("http://localhost:3000/api/external", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fecha: "2026-04-10",
        categoria: "Mantenimiento",
        monto: 12000,
        es_fijo: false,
      }),
    });
    const created = await (await postExternal(createReq)).json();
    expect(created.ok).toBe(true);

    const list = await (
      await getExternal(new Request("http://localhost:3000/api/external"))
    ).json();
    expect(list.items.length).toBe(1);

    const del = await (
      await deleteExternal(
        new Request(`http://localhost:3000/api/external?id=${created.id}`, {
          method: "DELETE",
        })
      )
    ).json();
    expect(del.ok).toBe(true);
  });

  it("serves local admin endpoints (/api/overview, /api/week, /api/month, /api/expenses, /api/suggest, /api/entries, /api/alerts, /api/quality, /api/config, /api/export/week.csv)", async () => {
    const ov = await (
      await getOverview(new Request("http://localhost:3000/api/overview?week=2026-04-S2"))
    ).json();
    expect(ov.ok).toBe(true);

    const wk = await (
      await getWeek(new Request("http://localhost:3000/api/week?key=2026-04-S2"))
    ).json();
    expect(wk.ok).toBe(true);
    expect(wk.resumen.ingreso).toBe(25000);

    const mo = await (
      await getMonth(new Request("http://localhost:3000/api/month?key=2026-04"))
    ).json();
    expect(mo.ok).toBe(true);
    expect(mo.ingreso).toBe(25000);

    const ex = await (
      await getExpenses(new Request("http://localhost:3000/api/expenses?mes=2026-04"))
    ).json();
    expect(ex.ok).toBe(true);
    expect(ex.total_count).toBe(1);

    const sg = await (
      await getSuggest(
        new Request("http://localhost:3000/api/suggest?proveedor=Distribuidora")
      )
    ).json();
    expect(sg.ok).toBe(true);
    expect(sg.sugerencia.categoria).toBe("Mercadería");

    // Entries POST -> GET -> Discard
    const ePost = await (
      await postEntries(
        new Request("http://localhost:3000/api/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fecha: "2026-04-12",
            proveedor: "Panadería",
            categoria: "Mercadería",
            monto: 8500,
          }),
        })
      )
    ).json();
    expect(ePost.ok).toBe(true);
    expect(ePost.pendientes.length).toBe(1);

    const eGet = await (await getEntries()).json();
    expect(eGet.pendientes.length).toBe(1);

    const eDisc = await (
      await postDiscard(
        new Request("http://localhost:3000/api/entries/discard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: ePost.id }),
        })
      )
    ).json();
    expect(eDisc.pendientes.length).toBe(0);

    const pw = await (
      await getPasteWeek(
        new Request("http://localhost:3000/api/paste/week?key=2026-04-S2")
      )
    ).json();
    expect(pw.ok).toBe(true);
    expect(pw.tsv_resumen).toContain("25000");

    const al = await (
      await getAlerts(new Request("http://localhost:3000/api/alerts?key=2026-04-S2"))
    ).json();
    expect(al.ok).toBe(true);

    const ql = await (await getQuality()).json();
    expect(ql.ok).toBe(true);

    const cfg = await (await getConfig()).json();
    expect(cfg.ok).toBe(true);
    expect(cfg.config.fudo_api_secret).not.toMatch(/[a-zA-Z0-9]{10,}/);

    const csvRes = await getWeekCsv(
      new Request("http://localhost:3000/api/export/week.csv?key=2026-04-S2")
    );
    expect(csvRes.status).toBe(200);
    expect(await csvRes.text()).toContain("Cafetería");
  });

  it("scans invoice photo text, autocompletes legible fields, flags illegible fields, and defaults due reminder to +7 days (editable)", async () => {
    const today = todayAr();
    const expectedDue7 = addDays(today, 7);

    // 1. Escaneo completo legible
    const scanFull = await (
      await postScanInvoice(
        new Request("http://localhost:3000/api/invoices/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ocr_text:
              "FACTURA A N° 0004-00089412\nDistribuidora Café\nCUIT 30-71458963-9\nFecha de Emisión: 10/04/2026\nIMPORTE TOTAL: $ 145.800,50",
          }),
        })
      )
    ).json();
    expect(scanFull.ok).toBe(true);
    expect(scanFull.scanned.proveedor).toBe("Distribuidora Café");
    expect(scanFull.scanned.numero_factura).toBe("0004-00089412");
    expect(scanFull.scanned.monto).toBe(145800.5);
    expect(scanFull.scanned.fecha_vencimiento).toBe(expectedDue7);
    expect(scanFull.scanned.campos_incompletos.length).toBe(0);

    // 2. Escaneo con partes borrosas / ilegibles (sin monto ni número de factura)
    const scanBlurry = await (
      await postScanInvoice(
        new Request("http://localhost:3000/api/invoices/scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ocr_text: "FACTURA A\nDistribuidora Café\nFecha: 10/04/2026",
          }),
        })
      )
    ).json();
    expect(scanBlurry.ok).toBe(true);
    expect(scanBlurry.scanned.proveedor).toBe("Distribuidora Café");
    expect(scanBlurry.scanned.campos_incompletos).toContain("monto");
    expect(scanBlurry.scanned.campos_incompletos).toContain("numero_factura");
    expect(scanBlurry.scanned.fecha_vencimiento).toBe(expectedDue7);

    // 3. Crear factura sin especificar vencimiento -> debe fijar default +7 días desde hoy
    const created = await (
      await postInvoices(
        new Request("http://localhost:3000/api/invoices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            proveedor: "Distribuidora Café",
            numero_factura: "0004-00089412",
            monto: 145800.5,
          }),
        })
      )
    ).json();
    expect(created.ok).toBe(true);
    expect(created.fecha_vencimiento).toBe(expectedDue7);

    // 4. Modificar manualmente el recordatorio de vencimiento y marcar como pagada
    const customDue = addDays(today, 12);
    const patched = await (
      await patchInvoices(
        new Request("http://localhost:3000/api/invoices", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invoice_id: created.id,
            fecha_vencimiento: customDue,
            estado: "pagado",
          }),
        })
      )
    ).json();
    expect(patched.ok).toBe(true);
    expect(patched.fecha_vencimiento).toBe(customDue);

    const list = await (
      await getInvoices(new Request("http://localhost:3000/api/invoices?estado=pagado"))
    ).json();
    expect(list.ok).toBe(true);
    expect(list.facturas[0].fecha_vencimiento).toBe(customDue);
  });

  it("enforces Basic Auth in middleware when PORTAL_PASS is set, while exempting /api/healthz", () => {
    const prevPass = process.env.PORTAL_PASS;
    process.env.PORTAL_PASS = "secret123";
    process.env.PORTAL_USER = "admin";

    try {
      // Exempt healthz
      const healthReq = new NextRequest("http://localhost:3000/api/healthz");
      const healthRes = middleware(healthReq);
      expect(healthRes.status).toBe(200);

      // Unauthorized request to dashboard
      const unauthReq = new NextRequest("http://localhost:3000/api/dashboard");
      const unauthRes = middleware(unauthReq);
      expect(unauthRes.status).toBe(401);

      // Authorized request
      const token = Buffer.from("admin:secret123").toString("base64");
      const authReq = new NextRequest("http://localhost:3000/api/dashboard", {
        headers: { authorization: `Basic ${token}` },
      });
      const authRes = middleware(authReq);
      expect(authRes.status).toBe(200);
    } finally {
      if (prevPass === undefined) delete process.env.PORTAL_PASS;
      else process.env.PORTAL_PASS = prevPass;
    }
  });
});
