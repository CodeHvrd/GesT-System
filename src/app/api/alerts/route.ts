import { NextResponse } from "next/server";
import {
  buildAlerts,
  defaultWeek,
  availableWeeks,
} from "@/lib/analytics/local-analytics";
import { weekLabel } from "@/lib/dates";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const wk = searchParams.get("key") || searchParams.get("week") || defaultWeek();
    const alerts = buildAlerts(wk);
    return NextResponse.json({
      ok: true,
      semana_key: wk,
      label: weekLabel(wk),
      alertas: alerts,
      semanas_disponibles: availableWeeks().map((k) => ({
        key: k,
        label: weekLabel(k),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

