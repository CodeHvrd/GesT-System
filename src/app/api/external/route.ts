import { NextResponse } from "next/server";
import {
  externalList,
  externalAdd,
  externalRemove,
} from "@/lib/analytics/cloud-analytics";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const dFrom = searchParams.get("desde") || undefined;
    const dTo = searchParams.get("hasta") || undefined;
    const items = await externalList(dFrom, dTo);
    return NextResponse.json({ ok: true, items });
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
    const res = await externalAdd(body);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    let id = Number(searchParams.get("id") || 0);
    if (!id) {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        id = Number(body.id || 0);
      } catch {
        // ignore
      }
    }
    const res = await externalRemove(id);
    return NextResponse.json(res, { status: res.ok ? 200 : 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

