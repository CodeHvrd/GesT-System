import { NextResponse } from "next/server";
import { FudoClient } from "@/lib/fudo/client";
import { resolveFudoCredentials } from "@/lib/fudo/sync";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const creds = await resolveFudoCredentials({
      apiKey: searchParams.get("api_key"),
      apiSecret: searchParams.get("api_secret"),
    });

    const client = new FudoClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      authUrl: creds.authUrl,
      apiUrl: creds.apiUrl,
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
