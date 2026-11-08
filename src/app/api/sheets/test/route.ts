import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";
import { discoverTabs } from "@/lib/sheets/sync";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cfg = loadConfig();
    const sheetId = searchParams.get("sheet_id") || cfg.sheet_id;
    const apiKey = searchParams.get("api_key") || cfg.google_api_key;
    const res = await discoverTabs(sheetId, apiKey);
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

