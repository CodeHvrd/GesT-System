import { NextResponse } from "next/server";
import {
  expensesDetail,
  expensesCross,
  externalList,
} from "@/lib/analytics/cloud-analytics";
import { resolveDateRange } from "@/lib/dates";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const [dFrom, dTo] = resolveDateRange(
      searchParams.get("preset"),
      searchParams.get("desde"),
      searchParams.get("hasta")
    );

    const [detail, cross, extList] = await Promise.all([
      expensesDetail(dFrom, dTo),
      expensesCross(6),
      externalList(dFrom, dTo),
    ]);

    return NextResponse.json({
      ok: true,
      desde: dFrom,
      hasta: dTo,
      ...detail,
      cross_mensual: cross,
      externos_lista: extList,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

