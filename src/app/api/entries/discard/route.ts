import { NextResponse } from "next/server";
import { discardEntry, entriesPayload } from "@/lib/analytics/local-analytics";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = Number(body.id || 0);
    if (!id) {
      return NextResponse.json(
        { ok: false, error: "ID de entrada requerido." },
        { status: 400 }
      );
    }
    const res = discardEntry(id);
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

