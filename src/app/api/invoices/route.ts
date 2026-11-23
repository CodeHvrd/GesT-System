import { NextResponse } from "next/server";
import {
  createInvoice,
  getInvoicesReport,
  updateInvoiceStatus,
} from "@/lib/invoices/service";
import { hydrateLocalFromPostgres } from "@/lib/db/pg-sync";

export async function GET(request: Request) {
  try {
    await hydrateLocalFromPostgres();
    const { searchParams } = new URL(request.url);
    const estado = searchParams.get("estado") || undefined;
    const proveedor = searchParams.get("proveedor") || undefined;

    const report = await getInvoicesReport({ estado, proveedor });
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const created = await createInvoice(body);
    if (!created.ok) {
      return NextResponse.json(created, { status: 400 });
    }
    const report = await getInvoicesReport();
    return NextResponse.json({ ...created, ...report });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const {
      invoice_id,
      estado,
      fecha_pago,
      fecha_vencimiento,
      fecha_emision,
      proveedor,
      numero_factura,
      descripcion,
      categoria,
      monto,
      medio_pago,
    } = body;

    if (!invoice_id) {
      return NextResponse.json(
        { ok: false, error: "invoice_id es obligatorio." },
        { status: 400 }
      );
    }

    const res = await updateInvoiceStatus(invoice_id, estado, fecha_pago, {
      fecha_vencimiento,
      fecha_emision,
      proveedor,
      numero_factura,
      descripcion,
      categoria,
      monto,
      medio_pago,
    });
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
