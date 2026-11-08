import { describe, it, expect, beforeEach } from "vitest";
import {
  DatabaseSync,
  initSqliteSchema,
  setTestSqliteDb,
  executeSql,
} from "../src/lib/db/local-db";
import {
  buildWeekReport,
  buildMonthReport,
  buildOverview,
  listExpenses,
  dataIssues,
  createEntry,
  discardEntry,
  weekPaste,
  generateWeekCsv,
  generateMonthCsv,
  generateExpensesCsv,
} from "../src/lib/analytics/local-analytics";
import {
  dashboard,
  externalAdd,
  externalList,
  externalRemove,
} from "../src/lib/analytics/cloud-analytics";

describe("Analytics Engines (Local & Cloud / Portal)", () => {
  beforeEach(() => {
    const mem = new DatabaseSync(":memory:");
    initSqliteSchema(mem);
    setTestSqliteDb(mem);

    // Seed sample sales in 2026-04-S2 (2026-04-10)
    executeSql(
      `INSERT INTO sales (semana_key, fecha, categoria, categoria_key, producto, cantidad, ingreso, costo, ganancia, fuente)
       VALUES
       ('2026-04-S2', '2026-04-10', 'Cafetería', 'cafeteria', 'Latte', 20, 60000, 15000, 45000, 'fudo:1'),
       ('2026-04-S2', '2026-04-11', 'Pastelería', 'pasteleria', 'Torta Choc', 10, 50000, 30000, 20000, 'fudo:2'),
       ('2026-04-S2', '2026-04-11', 'Bebidas', 'bebidas', 'Agua sin costo', 5, 10000, 0, 10000, 'fudo:3')`
    );

    // Seed sample expenses in 2026-04
    executeSql(
      `INSERT INTO expenses (fila_origen, fecha, mes_key, categoria, categoria_key, proveedor, proveedor_key, descripcion, cantidad, monto, medio_pago, fuente)
       VALUES
       (1, '2026-04-10', '2026-04', 'Mercadería', 'mercaderia', 'Café Sur', 'cafe sur', 'Granos café', 1, 25000, 'Efectivo', 'sheet'),
       (2, '2026-04-10', '2026-04', 'Mercadería', 'mercaderia', 'Café Sur', 'cafe sur', 'Granos café dup', 1, 25000, 'Efectivo', 'sheet'),
       (3, '2026-04-11', '2026-04', 'Alquiler', 'alquiler', 'Inmobiliaria', 'inmobiliaria', 'Alquiler abril', 1, 15000, 'Transferencia', 'sheet')`
    );
  });

  it("computes weekly report, CMV targets, alerts, TSV paste blocks, and CSV exports", () => {
    const rep = buildWeekReport("2026-04-S2");
    expect(rep.resumen.ingreso).toBe(120000);
    expect(rep.resumen.costo).toBe(45000);
    expect(rep.resumen.ganancia_bruta).toBe(75000);
    expect(rep.resumen.gastos_reposicion).toBe(50000);
    expect(rep.resumen.gastos_fijos).toBe(15000);
    expect(rep.resumen.gastos_total).toBe(65000);
    expect(rep.resumen.ganancia_caja).toBe(55000);

    // Should detect uncosted product ("Agua sin costo") and duplicate expense ("Café Sur" 25000)
    const alertCodes = rep.alertas.map((a) => a.codigo);
    expect(alertCodes).toContain("sin-costear");
    expect(alertCodes).toContain("duplicados");

    const paste = weekPaste("2026-04-S2");
    expect(paste.tsv_resumen).toContain("Semana 2\t120000\t45000\t75000");
    expect(paste.tsv_categorias).toContain("Cafetería");

    const csv = generateWeekCsv("2026-04-S2");
    expect(csv).toContain("Categoria,Cantidad,Ingreso,Costo");
    expect(csv).toContain("Cafetería");
  });

  it("computes monthly report, overview, data quality issues, and entries queue", () => {
    const mRep = buildMonthReport("2026-04");
    expect(mRep.ingreso).toBe(120000);
    expect(mRep.gastos_total).toBe(65000);
    expect(generateMonthCsv("2026-04")).toContain("2026-04-S2");

    const ov = buildOverview("2026-04-S2");
    expect(ov.counts.sales).toBe(3);
    expect(ov.counts.expenses).toBe(3);

    const issues = dataIssues();
    expect(issues.resumen.duplicados).toBe(1);

    // Create and discard an entry
    const created = createEntry({
      fecha: "2026-04-12",
      proveedor: "Lácteos Sur",
      categoria: "Mercadería",
      monto: 18000,
    });
    expect(created.ok).toBe(true);
    expect(listExpenses({ mes: "2026-04" }).total_count).toBe(4);

    discardEntry(created.id!);
    expect(listExpenses({ mes: "2026-04" }).total_count).toBe(3);
    expect(generateExpensesCsv({ mes: "2026-04" })).toContain("Café Sur");
  });

  it("computes full Cloud/Portal dashboard, profit equation, and external expenses CRUD", async () => {
    const extRes = await externalAdd({
      fecha: "2026-04-10",
      categoria: "Contador",
      proveedor: "Estudio Contable",
      monto: 30000,
      es_fijo: false,
    });
    expect(extRes.ok).toBe(true);

    const extItems = await externalList("2026-04-01", "2026-04-30");
    expect(extItems.length).toBe(1);

    const dash = await dashboard({
      desde: "2026-04-01",
      hasta: "2026-04-30",
      canal: "todos",
    });

    expect(dash.summary.kpis.ventas_netas).toBe(120000);
    expect(dash.summary.kpis.cmv).toBe(45000);
    expect(dash.summary.kpis.ganancia_bruta).toBe(75000);
    expect(dash.summary.kpis.gastos_externos_puntuales).toBe(30000);
    expect(dash.summary.ecuacion_ganancia.igual_ganancia_bruta).toBe(75000);
    expect(dash.review.items.length).toBeGreaterThan(0);

    await externalRemove(extRes.id);
    const afterRemove = await externalList("2026-04-01", "2026-04-30");
    expect(afterRemove.length).toBe(0);
  });
});
