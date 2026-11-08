import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { FudoClient } from "@/lib/fudo/client";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cfg = loadConfig();
    const apiKey = searchParams.get("api_key") || cfg.fudo_api_key;
    const apiSecret =
      searchParams.get("api_secret") &&
      searchParams.get("api_secret") !== "••••••••"
        ? searchParams.get("api_secret")!
        : cfg.fudo_api_secret;

    const client = new FudoClient({
      apiKey,
      apiSecret,
      authUrl: cfg.fudo_auth_url,
      apiUrl: cfg.fudo_api_url,
    });
    const res = await client.health();
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

