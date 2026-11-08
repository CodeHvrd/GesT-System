import { NextResponse } from "next/server";
import { triggerUpdateCheck } from "@/lib/version";

export async function POST() {
  try {
    const res = await triggerUpdateCheck();
    return NextResponse.json(res);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

