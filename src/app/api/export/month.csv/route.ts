import { NextResponse } from "next/server";
import { generateMonthCsv, monthKeys } from "@/lib/analytics/local-analytics";
import { todayAr } from "@/lib/dates";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const mk =
      searchParams.get("key") ||
      searchParams.get("month") ||
      monthKeys()[0] ||
      todayAr().slice(0, 7);
    const csv = generateMonthCsv(mk);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="mes-${mk}.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

