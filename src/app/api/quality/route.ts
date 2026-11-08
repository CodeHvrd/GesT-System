import { NextResponse } from "next/server";
import { dataIssues } from "@/lib/analytics/local-analytics";

export async function GET() {
  try {
    const data = dataIssues();
    return NextResponse.json({ ok: true, ...data });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

