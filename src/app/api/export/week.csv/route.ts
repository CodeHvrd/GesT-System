import { NextResponse } from "next/server";
import { generateWeekCsv, defaultWeek } from "@/lib/analytics/local-analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const wk = searchParams.get("key") || searchParams.get("week") || defaultWeek();
    const csv = generateWeekCsv(wk);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="semana-${wk}.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

