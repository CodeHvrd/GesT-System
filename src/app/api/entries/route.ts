import { NextResponse } from "next/server";
import { createEntry, entriesPayload } from "@/lib/analytics/local-analytics";
import { hydrateLocalFromPostgres, persistUnifiedExpenseToPg } from "@/lib/db/pg-sync";
import { createInvoice } from "@/lib/invoices/service";
import { norm, parseNumber } from "@/lib/format";
import { todayAr, addDays } from "@/lib/dates";

export async function GET() {
  try {
    await hydrateLocalFromPostgres();
    const data = entriesPayload();
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

async function processSingleEntry(item: Record<string, unknown>) {
  const res = createEntry(item);
  if (res.ok) {
    const destino = (norm(item.destino) || "caja_principal") as
      | "caja_principal"
      | "caja_grande_variable"
      | "caja_grande_fijo"
      | "factura_proveedor"
      | "fudo_insumo";
    const fecha = norm(item.fecha) || todayAr();
    const fechaVenc = norm(item.fecha_vencimiento) || addDays(todayAr(), 7);
    const medioPago = norm(item.medio_pago) || "Efectivo";
    const comprobante = norm(item.comprobante || item.numero_factura);
    const estadoPago = (
      norm(item.estado_pago).toLowerCase() === "pendiente" ||
      destino === "factura_proveedor" ||
      medioPago.toLowerCase().includes("corriente")
        ? "pendiente"
        : "pagado"
    ) as "pendiente" | "pagado";

    if (
      destino === "factura_proveedor" ||
      Boolean(comprobante) ||
      estadoPago === "pendiente"
    ) {
      await createInvoice({
        fecha_emision: fecha,
        fecha_vencimiento: fechaVenc,
        proveedor: norm(item.proveedor),
        categoria: norm(item.categoria) || "Mercadería",
        numero_factura: comprobante,
        descripcion: norm(item.descripcion),
        monto: parseNumber(item.monto),
        estado_pago: estadoPago,
        medio_pago: medioPago,
        origen: norm(item.origen) || "carga_app",
      });
    }

    await persistUnifiedExpenseToPg({
      entryId: res.id,
      fecha,
      fecha_vencimiento: fechaVenc,
      destino,
      proveedor: norm(item.proveedor),
      categoria: norm(item.categoria) || "Mercadería",
      descripcion: norm(item.descripcion),
      monto: parseNumber(item.monto),
      medio_pago: medioPago,
      comprobante,
      estado_pago: estadoPago,
    });
  }
  return res;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (Array.isArray(body.items)) {
      const results = [];
      for (const item of body.items) {
        results.push(await processSingleEntry(item as Record<string, unknown>));
      }
      return NextResponse.json({
        ok: true,
        created: results.filter((r) => r.ok).length,
        results,
        ...entriesPayload(),
      });
    }
    const res = await processSingleEntry(body);
    return NextResponse.json(
      { ...res, ...entriesPayload() },
      { status: res.ok ? 200 : 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
