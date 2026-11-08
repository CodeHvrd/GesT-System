import { NextResponse } from "next/server";
import {
  summary,
  progress,
  VALID_CHANNELS,
  ChannelType,
} from "@/lib/analytics/cloud-analytics";
import { resolveDateRange } from "@/lib/dates";
import { normKey } from "@/lib/format";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const [dFrom, dTo] = resolveDateRange(
      searchParams.get("preset"),
      searchParams.get("desde"),
      searchParams.get("hasta")
    );
    const rawCh = normKey(searchParams.get("canal") || "todos") as ChannelType;
    const channel: ChannelType = VALID_CHANNELS.includes(rawCh)
      ? rawCh
      : "todos";

    const [sumData, progData] = await Promise.all([
      summary(dFrom, dTo, channel),
      progress(dFrom, dTo, channel),
    ]);

    return NextResponse.json({
      ok: true,
      periodo: sumData.periodo,
      summary: sumData,
      progress: progData,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

