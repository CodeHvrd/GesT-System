import { NextResponse } from "next/server";
import { meta } from "@/lib/analytics/cloud-analytics";

export async function GET() {
  try {
    const data = await meta();
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

