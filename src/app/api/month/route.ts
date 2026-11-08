import { NextResponse } from "next/server";
import { buildMonthReport } from "@/lib/analytics/local-analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mk = searchParams.get("key") || searchParams.get("month") || undefined;
    const data = buildMonthReport(mk);
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

