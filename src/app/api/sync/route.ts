import { NextResponse } from "next/server";
import { syncAllSheets, replaceSalesWeeks } from "@/lib/sheets/sync";
import { syncAndReconcileContableMonth } from "@/lib/sheets/contable";
import { loadConfig } from "@/lib/config";
import { FudoClient } from "@/lib/fudo/client";
import {
  fetchSales,
  fetchFudoExpensesAndCashMovements,
  saveFudoExpensesAndCashToLocalDb,
} from "@/lib/fudo/sync";
import { resolveDateRange, todayArgIso } from "@/lib/dates";
import { evaluateScheduleStatus, runFullFudoAndContableSync } from "@/lib/scheduler";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const autorun = searchParams.get("autorun") === "1" || searchParams.get("autorun") === "true";
    const status = evaluateScheduleStatus();

    if (autorun && status.should_run) {
      const syncResult = await runFullFudoAndContableSync({
        daysBack: 30,
        slotKey: status.slot_key,
      });
      return NextResponse.json({
        ok: true,
        triggered_scheduled_sync: true,
        schedule: evaluateScheduleStatus(),
        sync_result: syncResult,
      });
    }

    return NextResponse.json({
      ok: true,
      triggered_scheduled_sync: false,
      schedule: status,
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
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const mode = String(body.source || body.mode || "all");
    const results: Record<string, unknown> = {};

    if (mode === "scheduled_cron") {
      const schedule = evaluateScheduleStatus();
      const cronRes = await runFullFudoAndContableSync({
        daysBack: Number(body.days_back || 30),
        slotKey: schedule.slot_key || `${todayArgIso()}@cron`,
      });
      return NextResponse.json({
        ok: true,
        mode: "scheduled_cron",
        schedule: evaluateScheduleStatus(),
        ...cronRes,
      });
    }

    if (mode === "all" || mode === "sheets") {
      results.sheets = await syncAllSheets();
    }

    const [dFrom, dTo] = resolveDateRange(
      String(body.preset || "este-mes"),
      body.desde ? String(body.desde) : null,
      body.hasta ? String(body.hasta) : null
    );
    const mesKey = String(body.mes || dTo.slice(0, 7) || todayArgIso().slice(0, 7));

    if (mode === "all" || mode === "fudo") {
      const cfg = loadConfig();
      if (cfg.fudo_api_key && cfg.fudo_api_secret) {
        const client = new FudoClient({
          apiKey: cfg.fudo_api_key,
          apiSecret: cfg.fudo_api_secret,
          authUrl: cfg.fudo_auth_url,
          apiUrl: cfg.fudo_api_url,
        });
        const fudoRes = await fetchSales(client, dFrom, dTo);
        if (fudoRes.lines.length > 0) {
          replaceSalesWeeks(fudoRes.lines);
        }

        let expensesInfo: Record<string, unknown> = {};
        try {
          const expData = await fetchFudoExpensesAndCashMovements(
            client,
            dFrom,
            dTo
          );
          const saved = saveFudoExpensesAndCashToLocalDb(expData);
          expensesInfo = {
            ...saved,
          };
        } catch (expErr) {
          expensesInfo = { warning: (expErr as Error).message };
        }

        results.fudo = {
          ok: true,
          desde: dFrom,
          hasta: dTo,
          inserted: fudoRes.lines.length,
          stats: fudoRes.stats,
          ...expensesInfo,
        };
      } else {
        results.fudo = {
          ok: false,
          skipped: true,
          message: "Credenciales de Fudo no configuradas.",
        };
      }
    }

    if (mode === "all" || mode === "contable" || mode === "sheets" || mode === "fudo") {
      try {
        const contableRes = await syncAndReconcileContableMonth({ mesKey });
        results.contable = {
          ok: true,
          hoja_mes: contableRes.hoja_mes,
          mes_key: contableRes.mes_key,
          filas_procesadas: contableRes.totales.filas_procesadas,
          proveedores_varios_conciliados: contableRes.totales.proveedores_varios_conciliados_count,
          proveedores_varios_faltantes_en_fudo: contableRes.totales.proveedores_varios_faltantes_count,
          discrepancias_pendientes: contableRes.discrepancias_pendientes.length,
        };
      } catch (contErr) {
        results.contable = {
          ok: false,
          error: (contErr as Error).message,
        };
      }
    }

    results.schedule = evaluateScheduleStatus();

    return NextResponse.json({
      ok: true,
      ...results,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}
