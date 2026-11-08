import { NextResponse } from "next/server";
import { getVersionInfo } from "@/lib/version";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const checkRemote = searchParams.get("remote") === "1";
    const info = await getVersionInfo(checkRemote);
    return NextResponse.json({ ok: true, ...info });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

