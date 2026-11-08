import { NextResponse } from "next/server";
import { queryOne, getSetting } from "@/lib/db/local-db";

export async function GET() {
  try {
    const sales = Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM sales")?.n || 0);
    const expenses = Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM expenses")?.n || 0);
    const weekly = Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM weekly_history")?.n || 0);
    const monthly = Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM monthly_history")?.n || 0);
    const lastSync = getSetting("last_sync") || null;

    return NextResponse.json({
      ok: true,
      status: "ok",
      last_sync: lastSync,
      counts: {
        sales,
        expenses,
        weekly,
        monthly,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

