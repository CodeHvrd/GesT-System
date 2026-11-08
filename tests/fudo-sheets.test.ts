import { describe, it, expect, beforeEach } from "vitest";
import { DatabaseSync, initSqliteSchema, setTestSqliteDb } from "../src/lib/db/local-db";
import {
  parseCsv,
  normalizeExpenses,
  normalizeSales,
  normalizeWeekly,
  normalizeMonthly,
  replaceExpenses,
  replaceSalesWeeks,
  confirmEntries,
} from "../src/lib/sheets/sync";
import { buildLines, CatalogProduct } from "../src/lib/fudo/sync";
import { executeSql, queryAll } from "../src/lib/db/local-db";

describe("Google Sheets CSV & Fudo Sync Logic", () => {
  beforeEach(() => {
    const mem = new DatabaseSync(":memory:");
    initSqliteSchema(mem);
    setTestSqliteDb(mem);
  });

  it("parses CSV with quoted fields, commas, and newlines", () => {
    const csv = `Fecha,Categoria,Proveedor,Monto\n10/04/2026,"Mercadería, Fresca","Proveedor ""A""",$ 15.200,50`;
    const rows = parseCsv(csv);
    expect(rows.length).toBe(2);
    expect(rows[1][0]).toBe("10/04/2026");
    expect(rows[1][1]).toBe("Mercadería, Fresca");
    expect(rows[1][2]).toBe('Proveedor "A"');
  });

  it("normalizes expenses, sales, weekly and monthly history from sheet rows", () => {
    const expRows = [
      ["Fecha", "Mes", "Categoría", "Proveedor", "Descripción", "Cantidad", "Monto", "Medio de Pago"],
      ["12/04/2026", "Abril 2026", "Mercadería", "Distribuidora Sur SRL", "Harina y queso", "2", "$ 45.000", "Efectivo"],
      ["13/04/2026", "2026-04", "Alquiler", "Inmobiliaria", "Alquiler local", "1", "$ 350.000", "Transferencia"],
    ];
    const normExp = normalizeExpenses(expRows);
    expect(normExp.length).toBe(2);
    expect(normExp[0].fecha).toBe("2026-04-12");
    expect(normExp[0].mes_key).toBe("2026-04");
    expect(normExp[0].proveedor_key).toBe("distribuidora sur");
    expect(normExp[0].monto).toBe(45000);

    const salesRows = [
      ["Fecha", "Categoría", "Producto", "Cantidad", "Ingreso", "Costo"],
      ["10/04/2026", "Cafetería", "Café Doble", "10", "$ 30.000", "$ 7.500"],
    ];
    const normSales = normalizeSales(salesRows);
    expect(normSales.length).toBe(1);
    expect(normSales[0].semana_key).toBe("2026-04-S2");
    expect(normSales[0].ganancia).toBe(22500);

    const weeklyRows = [
      ["Semana", "Fecha Inicio", "Fecha Fin", "Ventas", "Costo", "Ganancia", "Gastos", "Observaciones"],
      ["Semana 2", "08/04/2026", "14/04/2026", "500000", "175000", "325000", "210000", "Buen fin de semana"],
    ];
    const normW = normalizeWeekly(weeklyRows);
    expect(normW.length).toBe(1);
    expect(normW[0].semana_key).toBe("2026-04-S2");
    expect(normW[0].ingreso).toBe(500000);

    const monthlyRows = [
      ["Mes", "Ventas", "Costo", "Gastos"],
      ["Abril 2026", "2000000", "700000", "900000"],
    ];
    const normM = normalizeMonthly(monthlyRows);
    expect(normM.length).toBe(1);
    expect(normM[0].mes_key).toBe("2026-04");
    expect(normM[0].ganancia).toBe(1300000);
  });

  it("replaces expenses, preserves local pending entries, and confirms matched entries", () => {
    // Insert a pending entry
    executeSql(
      `INSERT INTO entries (creado_en, fecha, mes, proveedor, categoria, descripcion, monto, cantidad, medio_pago, estado)
       VALUES ('2026-04-12T10:00:00Z', '2026-04-12', '2026-04', 'Distribuidora Sur', 'Mercadería', 'Harina', 45000, 1, 'Efectivo', 'pendiente')`
    );

    const sheetExpenses = normalizeExpenses([
      ["Fecha", "Categoría", "Proveedor", "Monto"],
      ["12/04/2026", "Mercadería", "Distribuidora Sur SRL", "45000"],
    ]);
    replaceExpenses(sheetExpenses);
    const confirmed = confirmEntries(sheetExpenses);
    expect(confirmed).toBe(1);

    const entries = queryAll<{ estado: string }>("SELECT estado FROM entries");
    expect(entries[0].estado).toBe("confirmado");
  });

  it("builds Fudo sales lines and auto-detects linea vs unidad price mode", () => {
    const catalog: Record<string, CatalogProduct> = {
      "101": {
        id: "101",
        name: "Medialuna",
        categoryId: "1",
        categoryName: "Pastelería",
        price: 1000,
        cost: 350,
        hasRecipe: true,
      },
    };

    // Case 1: item.price is line total (3 units * 1000 = 3000, matching sale.total = 3000)
    const rawSalesLinea = [
      {
        id: "S1",
        attributes: {
          createdAt: "2026-04-10T14:00:00Z",
          saleState: "CLOSED",
          total: 3000,
        },
        relationships: {
          items: { data: [{ id: "I1", type: "Item" }] },
        },
      },
    ];
    const itemsMapLinea = new Map([
      [
        "I1",
        {
          id: "I1",
          attributes: { price: 3000, quantity: 3, canceled: false },
          relationships: { product: { data: { id: "101" } } },
        },
      ],
    ]);

    const resLinea = buildLines(rawSalesLinea, itemsMapLinea, catalog);
    expect(resLinea.stats.price_mode).toBe("linea");
    expect(resLinea.lines[0].ingreso).toBe(3000);
    expect(resLinea.lines[0].costo).toBe(1050);
    expect(resLinea.lines[0].ganancia).toBe(1950);

    const dbSave = replaceSalesWeeks(resLinea.lines);
    expect(dbSave.inserted).toBe(1);
    expect(dbSave.weeks).toContain("2026-04-S2");
  });
});
