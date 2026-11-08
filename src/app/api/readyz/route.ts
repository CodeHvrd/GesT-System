import { NextResponse } from "next/server";
import { hasPostgresUrl, pgHealthCheck } from "@/lib/db/pg-db";
import { queryOne } from "@/lib/db/local-db";

export async function GET() {
  try {
    if (hasPostgresUrl()) {
      const ok = await pgHealthCheck();
      if (!ok) {
        return NextResponse.json(
          { status: "not_ready", db: "postgres_unreachable" },
          { status: 503 }
        );
      }
      return NextResponse.json({ status: "ready", db: "postgres" });
    }
    const r = queryOne<{ ok: number }>("SELECT 1 AS ok");
    return NextResponse.json({
      status: r?.ok === 1 ? "ready" : "not_ready",
      db: "sqlite",
    });
  } catch (err) {
    return NextResponse.json(
      { status: "not_ready", error: (err as Error).message },
      { status: 503 }
    );
  }
}

