import { NextResponse } from "next/server";
import { buildWeekReport } from "@/lib/analytics/local-analytics";
import { hydrateLocalFromPostgres } from "@/lib/db/pg-sync";

export async function GET(request: Request) {
  try {
    await hydrateLocalFromPostgres();
    const { searchParams } = new URL(request.url);
    const wk = searchParams.get("key") || searchParams.get("week") || undefined;
    const data = buildWeekReport(wk);
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
