import { NextResponse } from "next/server";
import { parseCsv } from "@/lib/sheets/sync";
import {
  getContableReconciliation,
  syncAndReconcileContableMonth,
  resolveContableDiscrepancy,
  monthKeyFromContableTab,
  contableTabNameForMonth,
  type FudoExpenseForCheck,
} from "@/lib/sheets/contable";
import { evaluateScheduleStatus } from "@/lib/scheduler";
import { todayArgIso } from "@/lib/dates";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const hojaParam = searchParams.get("hoja") || "";
    const mesParam = searchParams.get("mes") || "";
    const forceSync = searchParams.get("sync") === "1" || searchParams.get("sync") === "true";

    const mesKey =
      mesParam ||
      (hojaParam ? monthKeyFromContableTab(hojaParam) : null) ||
      todayArgIso().slice(0, 7);

    let data = await getContableReconciliation(mesKey);
    if (forceSync || (data.items.length === 0 && searchParams.get("autoload") === "1")) {
      data = await syncAndReconcileContableMonth({
        mesKey,
        tabName: hojaParam || contableTabNameForMonth(mesKey),
      }) as any;
    }

    return NextResponse.json({
      ok: true,
      data: {
        ...data,
        schedule: evaluateScheduleStatus(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const hoja = String(body.hoja || "").trim();
    const mes =
      String(body.mes || "").trim() ||
      (hoja ? monthKeyFromContableTab(hoja) : null) ||
      todayArgIso().slice(0, 7);
    const tabName = hoja || contableTabNameForMonth(mes);

    let csvRows: string[][] | undefined;
    if (typeof body.csv_text === "string" && body.csv_text.trim()) {
      csvRows = parseCsv(body.csv_text);
    } else if (Array.isArray(body.csv_rows)) {
      csvRows = body.csv_rows;
    }

    let fudoExpenses: FudoExpenseForCheck[] | undefined;
    if (Array.isArray(body.fudo_expenses)) {
      fudoExpenses = body.fudo_expenses.map((fe: Record<string, unknown>, idx: number) => ({
        id: String(fe.id || `fudo-test-${idx + 1}`),
        fecha: String(fe.fecha || fe.date || `${mes}-02`),
        proveedor: String(fe.proveedor || fe.provider || ""),
        monto: Number(fe.monto ?? fe.amount ?? 0),
        descripcion: String(fe.descripcion || fe.description || ""),
        categoria: String(fe.categoria || fe.category || "Materia Prima / Insumos"),
      }));
    }

    const result = await syncAndReconcileContableMonth({
      mesKey: mes,
      tabName,
      csvRows,
      fudoExpenses,
    });

    return NextResponse.json({
      ok: true,
      data: {
        ...result,
        schedule: evaluateScheduleStatus(),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const hash = String(body.hash || "").trim();
    const accion = body.accion as
      | "confirmar_en_fudo"
      | "mantener_gasto_externo"
      | "mover_a_caja_principal"
      | "mover_a_caja_grande_fijo"
      | "mover_a_caja_grande_variable"
      | "ignorar";

    if (!hash || !accion) {
      return NextResponse.json(
        { ok: false, error: "Se requiere 'hash' y 'accion' para resolver la discrepancia." },
        { status: 400 }
      );
    }

    const updated = await resolveContableDiscrepancy({
      hash,
      accion,
      nota: body.nota ? String(body.nota) : undefined,
      nuevoMonto: body.nuevo_monto !== undefined ? Number(body.nuevo_monto) : undefined,
      nuevoProveedor: body.nuevo_proveedor ? String(body.nuevo_proveedor) : undefined,
      fudoExpenseId: body.fudo_expense_id ? String(body.fudo_expense_id) : undefined,
    });

    if (!updated) {
      return NextResponse.json(
        { ok: false, error: "No se encontró el registro contable indicado." },
        { status: 404 }
      );
    }

    const reconciliation = await getContableReconciliation(updated.mes_key);

    return NextResponse.json({
      ok: true,
      data: {
        updated,
        reconciliation,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
