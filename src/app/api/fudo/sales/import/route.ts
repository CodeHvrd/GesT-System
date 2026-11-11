import { NextResponse } from "next/server";
import { FudoClient } from "@/lib/fudo/client";
import {
  fetchSales,
  resolveFudoCredentials,
  syncFudoToPostgres,
} from "@/lib/fudo/sync";
import { replaceSalesWeeks } from "@/lib/sheets/sync";
import { resolveDateRange } from "@/lib/dates";

export async function POST(request: Request) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const creds = await resolveFudoCredentials();
    if (!creds.apiKey || !creds.apiSecret) {
      return NextResponse.json(
        { ok: false, error: "Credenciales de Fudo no configuradas." },
        { status: 400 }
      );
    }

    const [dFrom, dTo] = resolveDateRange(
      body.preset ? String(body.preset) : "este-mes",
      body.desde ? String(body.desde) : body.from ? String(body.from) : null,
      body.hasta ? String(body.hasta) : body.to ? String(body.to) : null
    );

    const client = new FudoClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      authUrl: creds.authUrl,
      apiUrl: creds.apiUrl,
    });

    const res = await fetchSales(client, dFrom, dTo);
    const dbRes = replaceSalesWeeks(res.lines);
    let pgRes: Record<string, unknown> = {};
    try {
      const pg = await syncFudoToPostgres({
        dFrom,
        dTo,
        pgSales: res.pgSales,
        catalog: res.catalog,
      });
      pgRes = { pg_synced: pg.ok, pg_sales_written: pg.sales_written };
    } catch (e) {
      pgRes = { pg_synced: false, pg_error: (e as Error).message };
    }

    return NextResponse.json({
      ok: true,
      desde: dFrom,
      hasta: dTo,
      inserted: dbRes.inserted,
      weeks: dbRes.weeks,
      stats: res.stats,
      ...pgRes,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
