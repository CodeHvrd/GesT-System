import { NextResponse } from "next/server";
import { listExpenses } from "@/lib/analytics/local-analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const data = listExpenses({
      mes: searchParams.get("mes") || undefined,
      semana: searchParams.get("semana") || undefined,
      categoria: searchParams.get("categoria") || undefined,
      proveedor: searchParams.get("proveedor") || undefined,
      medio_pago: searchParams.get("medio_pago") || undefined,
      q: searchParams.get("q") || undefined,
      limit: searchParams.get("limit")
        ? Number(searchParams.get("limit"))
        : undefined,
    });
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

