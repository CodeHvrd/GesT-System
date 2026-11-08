import { describe, it, expect } from "vitest";
import {
  contableTabNameForMonth,
  monthKeyFromContableTab,
  parseContableDate,
  parseContableRows,
  crossCheckContableWithFudo,
} from "../src/lib/sheets/contable";
import { parseCsv } from "../src/lib/sheets/sync";
import { queryAll } from "../src/lib/db/local-db";
import { evaluateScheduleStatus } from "../src/lib/scheduler";
import {
  GET as getReconcile,
  POST as postReconcile,
  PATCH as patchReconcile,
} from "../src/app/api/reconcile/route";

const REAL_NOVIEMBRE_26_CSV = `Fecha,Descripción,Cuenta,Tipo,Descripción,Entrada (D),Salida (H),Saldo,Observaciones
02/11/2026,Los Gringos ,Proveedores Varios,Egresos Mercaderia,Fiambres,"$225,735.00",0.00,"$225,735.00",
02/11/2026,Promarco,Proveedores Varios,Egresos Mercaderia,Insumos,"$42,333.92",0.00,"$268,068.92",
02/11/2026,Papelera,Proveedores Varios,Egresos Mercaderia,Descartables,"$34,480.00","34,480.00","$268,068.92",No cargado en Fudo
03/11,CocaCola,Proveedores Varios,Egresos Mercaderia,Bebidas,"$124,688.46","124,700.00","$268,057.38",Redondeo pago efectivo
,Marleand,Proveedores Varios,Egresos Mercaderia,Panificados,"$70,400.00",0.00,"$338,457.38",Sin fecha explicita
04/11/2026,Verduleria Chica,Movimientos de Caja > Principal,Caja Principal,Limon y menta,0.00,"$18,500.00","$338,457.38",Compra del dia a dia
05/11/2026,Obras sanitarias ,Egresos Servicios Exteriores,Caja Grande,Agua mensual,"$151,148.14","151,148.14","$338,457.38",Servicio fijo
05/11/2026,Pago Sueldos Cocina,Caja Grande,Egresos Sueldos,Quincena,0.00,"$480,000.00","$338,457.38",Retiro Caja Grande`;

describe("Planilla Contable ('NOVIEMBRE 26' / 'DICIEMBRE 26') & Reconciliación con Fudo", () => {
  it("convierte correctamente entre clave mensual YYYY-MM y nombre de solapa ('NOVIEMBRE 26', 'DICIEMBRE 26')", () => {
    expect(contableTabNameForMonth("2026-11")).toBe("NOVIEMBRE 26");
    expect(contableTabNameForMonth("2026-12")).toBe("DICIEMBRE 26");
    expect(contableTabNameForMonth("2027-01")).toBe("ENERO 27");

    expect(monthKeyFromContableTab("NOVIEMBRE 26")).toBe("2026-11");
    expect(monthKeyFromContableTab("DICIEMBRE 26")).toBe("2026-12");
    expect(monthKeyFromContableTab("ENERO 27")).toBe("2027-01");
  });

  it("interpreta fechas completas, cortas (DD/MM) y vacías heredando la fila previa", () => {
    expect(parseContableDate("02/11/2026", "2026-11", "")).toBe("2026-11-02");
    expect(parseContableDate("03/11", "2026-11", "2026-11-02")).toBe("2026-11-03");
    expect(parseContableDate("", "2026-11", "2026-11-03")).toBe("2026-11-03");
  });

  it("parsea las 9 columnas exactas de la Planilla Contable y discrimina Proveedores Varios, Caja Principal y Caja Grande", () => {
    const csvRows = parseCsv(REAL_NOVIEMBRE_26_CSV);
    const parsed = parseContableRows(csvRows, "NOVIEMBRE 26", "2026-11");

    expect(parsed.length).toBe(8);

    const losGringos = parsed.find((r) => r.proveedor === "Los Gringos");
    expect(losGringos).toBeDefined();
    expect(losGringos?.cuenta).toBe("Proveedores Varios");
    expect(losGringos?.entrada_d).toBe(225735);
    expect(losGringos?.salida_h).toBe(0);
    expect(losGringos?.monto_efectivo).toBe(225735);
    expect(losGringos?.origen_clasificado).toBe("proveedores_varios");

    const marleand = parsed.find((r) => r.proveedor === "Marleand");
    expect(marleand?.fecha).toBe("2026-11-03"); // Heredada de CocaCola (03/11)

    const cajaPrinc = parsed.find((r) => r.proveedor === "Verduleria Chica");
    expect(cajaPrinc?.origen_clasificado).toBe("caja_principal");
    expect(cajaPrinc?.posicion_actual).toBe("caja_principal");
    expect(cajaPrinc?.monto_efectivo).toBe(18500);

    const obrasSanitarias = parsed.find((r) => r.proveedor === "Obras sanitarias");
    expect(obrasSanitarias?.posicion_actual).toBe("caja_grande_fijo");

    const sueldos = parsed.find((r) => r.proveedor === "Pago Sueldos Cocina");
    expect(sueldos?.origen_clasificado).toBe("caja_grande");
    expect(sueldos?.posicion_actual).toBe("caja_grande_fijo");
  });

  it("cruza 'Proveedores Varios' contra Gastos Fudo: concilia los existentes y posiciona los faltantes como Gasto Externo", () => {
    const csvRows = parseCsv(REAL_NOVIEMBRE_26_CSV);
    const parsed = parseContableRows(csvRows, "NOVIEMBRE 26", "2026-11");

    const fudoExpenses = [
      {
        id: "fudo-1",
        fecha: "2026-11-02",
        proveedor: "Los Gringos",
        monto: 225735,
      },
      {
        id: "fudo-2",
        fecha: "2026-11-02",
        proveedor: "Promarco",
        monto: 42333.92,
      },
      {
        id: "fudo-3",
        fecha: "2026-11-03",
        proveedor: "CocaCola",
        monto: 124688.46, // Coincide con Entrada (D) aunque Salida (H) sea 124.700 por redondeo
      },
    ];

    const { checkedRows, fudoOnlyExpenses } = crossCheckContableWithFudo(
      parsed,
      fudoExpenses
    );

    expect(fudoOnlyExpenses.length).toBe(0);

    const gringos = checkedRows.find((r) => r.proveedor === "Los Gringos")!;
    expect(gringos.estado_conciliacion).toBe("conciliado_fudo");
    expect(gringos.posicion_actual).toBe("gasto_fudo");
    expect(gringos.fudo_expense_id).toBe("fudo-1");

    const coca = checkedRows.find((r) => r.proveedor === "CocaCola")!;
    expect(coca.estado_conciliacion).toBe("conciliado_fudo");
    expect(coca.posicion_actual).toBe("gasto_fudo");

    // Papelera y Marleand son "Proveedores Varios" pero NO están en Fudo:
    // Deben notificarse como faltante_en_fudo y posicionarse como gasto_externo
    const papelera = checkedRows.find((r) => r.proveedor === "Papelera")!;
    expect(papelera.estado_conciliacion).toBe("faltante_en_fudo");
    expect(papelera.posicion_actual).toBe("gasto_externo");

    const marleand = checkedRows.find((r) => r.proveedor === "Marleand")!;
    expect(marleand.estado_conciliacion).toBe("faltante_en_fudo");
    expect(marleand.posicion_actual).toBe("gasto_externo");
  });

  it("permite auditar y resolver discrepancias vía API /api/reconcile (POST, GET, PATCH)", async () => {
    const postReq = new Request("http://localhost:3000/api/reconcile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hoja: "NOVIEMBRE 26",
        csv_text: REAL_NOVIEMBRE_26_CSV,
        fudo_expenses: [
          {
            id: "fudo-1",
            fecha: "2026-11-02",
            proveedor: "Los Gringos",
            monto: 225735,
          },
          {
            id: "fudo-2",
            fecha: "2026-11-02",
            proveedor: "Promarco",
            monto: 42333.92,
          },
          {
            id: "fudo-3",
            fecha: "2026-11-03",
            proveedor: "CocaCola",
            monto: 124688.46,
          },
        ],
      }),
    });

    const postRes = await postReconcile(postReq);
    const postJson = await postRes.json();
    expect(postJson.ok).toBe(true);
    expect(postJson.data.hoja_mes).toBe("NOVIEMBRE 26");
    expect(postJson.data.totales.proveedores_varios_conciliados_count).toBe(3);
    expect(postJson.data.totales.proveedores_varios_faltantes_count).toBe(2);
    expect(postJson.data.discrepancias_pendientes.length).toBe(2);

    const papeleraDisc = postJson.data.discrepancias_pendientes.find(
      (d: any) => d.proveedor === "Papelera"
    );
    expect(papeleraDisc).toBeDefined();
    expect(papeleraDisc.posicion_actual).toBe("gasto_externo");
    expect(papeleraDisc.celda_ref).toBe("B4");
    expect(papeleraDisc.sheet_cell_url).toContain("range=B4");

    // Verificar que los ítems que NO son "Proveedores Varios" (Verduleria Chica, Obras sanitarias, Pago Sueldos Cocina)
    // fueron guardados automáticamente como Gastos Externos en la DB y NO están en discrepancias_pendientes
    const autoExternals = queryAll<Record<string, unknown>>(
      "SELECT * FROM external_expenses WHERE mes_key = '2026-11' AND descripcion LIKE '[Contable Auto]%'"
    );
    expect(autoExternals.length).toBe(3);

    // Resolver la discrepancia de Papelera manteniéndola como Gasto Externo verificado y ajustando nota/monto
    const patchReq = new Request("http://localhost:3000/api/reconcile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        hash: papeleraDisc.hash,
        accion: "mantener_gasto_externo",
        nota: "Compra descartables fuera de receta Fudo",
        nuevo_monto: 34500,
      }),
    });

    const patchRes = await patchReconcile(patchReq);
    const patchJson = await patchRes.json();
    expect(patchJson.ok).toBe(true);
    expect(patchJson.data.updated.resuelto).toBe(true);
    expect(patchJson.data.updated.posicion_actual).toBe("gasto_externo");
    expect(patchJson.data.updated.monto_efectivo).toBe(34500);
    expect(patchJson.data.reconciliation.discrepancias_pendientes.length).toBe(1);

    // Consultar por GET /api/reconcile?hoja=NOVIEMBRE%2026
    const getReq = new Request(
      "http://localhost:3000/api/reconcile?hoja=NOVIEMBRE%2026"
    );
    const getRes = await getReconcile(getReq);
    const getJson = await getRes.json();
    expect(getJson.ok).toBe(true);
    expect(getJson.data.mes_key).toBe("2026-11");
  });

  it("verifica la programación automática de Fudo a las 02:00 hs ARG (05:00 UTC) y 16:00 hs ARG (19:00 UTC)", () => {
    // 05:10 UTC = 02:10 ARG -> debe coincidir con el turno "02:00"
    const at2amArg = new Date("2026-11-10T05:10:00Z");
    const status2am = evaluateScheduleStatus(at2amArg);
    expect(status2am.current_hour_arg).toBe("02:10");
    expect(status2am.matching_slot).toBe("02:00");
    expect(status2am.should_run).toBe(true);

    // 19:15 UTC = 16:15 ARG -> debe coincidir con el turno "16:00"
    const at4pmArg = new Date("2026-11-10T19:15:00Z");
    const status4pm = evaluateScheduleStatus(at4pmArg);
    expect(status4pm.current_hour_arg).toBe("16:15");
    expect(status4pm.matching_slot).toBe("16:00");
    expect(status4pm.should_run).toBe(true);

    // 14:00 UTC = 11:00 ARG -> fuera de ventana programada
    const at11amArg = new Date("2026-11-10T14:00:00Z");
    const status11am = evaluateScheduleStatus(at11amArg);
    expect(status11am.current_hour_arg).toBe("11:00");
    expect(status11am.matching_slot).toBeNull();
    expect(status11am.should_run).toBe(false);
  });
});
