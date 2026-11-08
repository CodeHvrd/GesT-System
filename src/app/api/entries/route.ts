import { NextResponse } from "next/server";
import { createEntry, entriesPayload } from "@/lib/analytics/local-analytics";

export async function GET() {
  try {
    const data = entriesPayload();
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (Array.isArray(body.items)) {
      const results = [];
      for (const item of body.items) {
        results.push(createEntry(item as Record<string, unknown>));
      }
      return NextResponse.json({
        ok: true,
        created: results.filter((r) => r.ok).length,
        results,
        ...entriesPayload(),
      });
    }
    const res = createEntry(body);
    return NextResponse.json(
      { ...res, ...entriesPayload() },
      { status: res.ok ? 200 : 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

