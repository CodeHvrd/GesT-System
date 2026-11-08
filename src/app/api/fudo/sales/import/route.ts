import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { FudoClient } from "@/lib/fudo/client";
import { fetchSales } from "@/lib/fudo/sync";
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

    const cfg = loadConfig();
    if (!cfg.fudo_api_key || !cfg.fudo_api_secret) {
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
      apiKey: cfg.fudo_api_key,
      apiSecret: cfg.fudo_api_secret,
      authUrl: cfg.fudo_auth_url,
      apiUrl: cfg.fudo_api_url,
    });

    const res = await fetchSales(client, dFrom, dTo);
    const dbRes = replaceSalesWeeks(res.lines);

    return NextResponse.json({
      ok: true,
      desde: dFrom,
      hasta: dTo,
      inserted: dbRes.inserted,
      weeks: dbRes.weeks,
      stats: res.stats,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

