import { NextResponse } from "next/server";
import { generateExpensesCsv } from "@/lib/analytics/local-analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mes = searchParams.get("mes") || undefined;
    const semana = searchParams.get("semana") || undefined;
    const csv = generateExpensesCsv({ mes, semana });
    const suffix = semana || mes || "todos";
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="gastos-${suffix}.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

