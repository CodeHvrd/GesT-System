import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { FudoClient } from "@/lib/fudo/client";
import { previewFudoSales } from "@/lib/fudo/sync";
import { resolveDateRange } from "@/lib/dates";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cfg = loadConfig();

    if (!cfg.fudo_api_key || !cfg.fudo_api_secret) {
      return NextResponse.json(
        { ok: false, error: "Credenciales de Fudo no configuradas." },
        { status: 400 }
      );
    }

    const [dFrom, dTo] = resolveDateRange(
      searchParams.get("preset") || "esta-semana",
      searchParams.get("desde") || searchParams.get("from"),
      searchParams.get("hasta") || searchParams.get("to")
    );

    const client = new FudoClient({
      apiKey: cfg.fudo_api_key,
      apiSecret: cfg.fudo_api_secret,
      authUrl: cfg.fudo_auth_url,
      apiUrl: cfg.fudo_api_url,
    });

    const preview = await previewFudoSales(client, dFrom, dTo);
    return NextResponse.json(preview);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

