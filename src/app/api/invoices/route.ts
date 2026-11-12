import { NextResponse } from "next/server";
import { getInvoicesReport, updateInvoiceStatus } from "@/lib/invoices/service";

export async function GET(request: Request) {
  try {
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

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const { invoice_id, estado, fecha_pago } = body;

    if (!invoice_id || !estado) {
      return NextResponse.json(
        { ok: false, error: "invoice_id y estado son obligatorios." },
        { status: 400 }
      );
    }

    const res = await updateInvoiceStatus(invoice_id, estado, fecha_pago);
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
