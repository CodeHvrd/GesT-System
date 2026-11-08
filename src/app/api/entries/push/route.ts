import { NextResponse } from "next/server";
import { pushEntries, entriesPayload } from "@/lib/analytics/local-analytics";

export async function POST() {
  try {
    const res = await pushEntries();
    return NextResponse.json({
      ...res,
      ...entriesPayload(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

