import { NextResponse } from "next/server";
import { executeSql } from "@/lib/db/local-db";

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const wk = body.semana_key ? String(body.semana_key) : "";
    let deleted = 0;
    if (wk) {
      const r = executeSql(
        "DELETE FROM sales WHERE semana_key = ? AND fuente LIKE 'fudo:%'",
        [wk]
      );
      deleted = Number(r.changes || 0);
    } else {
      const r = executeSql("DELETE FROM sales WHERE fuente LIKE 'fudo:%'");
      deleted = Number(r.changes || 0);
    }

    return NextResponse.json({
      ok: true,
      deleted,
      semana_key: wk || "all",
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

