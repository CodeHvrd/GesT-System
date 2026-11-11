import { NextResponse } from "next/server";
import { FudoClient } from "@/lib/fudo/client";
import {
  previewFudoSales,
  resolveFudoCredentials,
} from "@/lib/fudo/sync";
import { resolveDateRange } from "@/lib/dates";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const creds = await resolveFudoCredentials();

    if (!creds.apiKey || !creds.apiSecret) {
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
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      authUrl: creds.authUrl,
      apiUrl: creds.apiUrl,
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
