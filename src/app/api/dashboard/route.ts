import { NextResponse } from "next/server";
import { dashboard } from "@/lib/analytics/cloud-analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const data = await dashboard({
      preset: searchParams.get("preset"),
      desde: searchParams.get("desde"),
      hasta: searchParams.get("hasta"),
      canal: searchParams.get("canal"),
    });
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

