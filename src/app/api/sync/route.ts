import { NextResponse } from "next/server";
import { syncAllSheets, replaceSalesWeeks } from "@/lib/sheets/sync";
import { syncAndReconcileContableMonth } from "@/lib/sheets/contable";
import { saveConfig } from "@/lib/config";
import { setSetting } from "@/lib/db/local-db";
import { FudoClient } from "@/lib/fudo/client";
import {
  fetchSales,
  fetchFudoExpensesAndCashMovements,
  saveFudoExpensesAndCashToLocalDb,
  resolveFudoCredentials,
  saveFudoCredentialsEverywhere,
  syncFudoToPostgres,
} from "@/lib/fudo/sync";
import { addDays, resolveDateRange, todayArgIso } from "@/lib/dates";
import {
  evaluateScheduleStatus,
  runFullFudoAndContableSync,
} from "@/lib/scheduler";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const autorun =
      searchParams.get("autorun") === "1" ||
      searchParams.get("autorun") === "true";
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

    const today = todayArgIso();
    const [rawFrom, rawTo] = resolveDateRange(
      String(body.preset || "este-mes"),
      body.desde ? String(body.desde) : null,
      body.hasta ? String(body.hasta) : null
    );

    // Garantizar que la sincronización de Fudo cubra siempre hasta hoy (hora ARG)
    // y al menos los últimos 15 días o el inicio del período seleccionado.
    const minRecentFrom = addDays(today, -15);
    const dFrom = rawFrom < minRecentFrom ? rawFrom : minRecentFrom;
    const dTo = rawTo > today ? rawTo : today;
    const mesKey = String(body.mes || dTo.slice(0, 7) || today.slice(0, 7));

    if (mode === "all" || mode === "fudo") {
      const reqKey = body.api_key ? String(body.api_key).trim() : "";
      const reqSecret = body.api_secret ? String(body.api_secret).trim() : "";
      if (reqKey && reqSecret && reqSecret !== "••••••••") {
        await saveFudoCredentialsEverywhere(reqKey, reqSecret);
      }

      const creds = await resolveFudoCredentials({
        apiKey: reqKey || null,
        apiSecret: reqSecret || null,
      });

      if (creds.apiKey && creds.apiSecret) {
        const client = new FudoClient({
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          authUrl: creds.authUrl,
          apiUrl: creds.apiUrl,
        });
        const fudoRes = await fetchSales(client, dFrom, dTo);
        if (fudoRes.lines.length > 0) {
          replaceSalesWeeks(fudoRes.lines);
        }

        let expData:
          | {
              expenses: Awaited<
                ReturnType<typeof fetchFudoExpensesAndCashMovements>
              >["expenses"];
              cash_principal: Awaited<
                ReturnType<typeof fetchFudoExpensesAndCashMovements>
              >["cash_principal"];
              cash_grande: Awaited<
                ReturnType<typeof fetchFudoExpensesAndCashMovements>
              >["cash_grande"];
            }
          | undefined;
        let expensesInfo: Record<string, unknown> = {};
        try {
          expData = await fetchFudoExpensesAndCashMovements(
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

        let pgInfo: Record<string, unknown> = {};
        try {
          const pgSync = await syncFudoToPostgres({
            dFrom,
            dTo,
            pgSales: fudoRes.pgSales,
            catalog: fudoRes.catalog,
            expData,
          });
          pgInfo = {
            pg_synced: pgSync.ok,
            pg_sales_written: pgSync.sales_written,
            pg_expenses_written: pgSync.expenses_written,
          };
        } catch (pgErr) {
          pgInfo = {
            pg_synced: false,
            pg_error: (pgErr as Error).message,
          };
        }

        const nowIso = new Date().toISOString();
        setSetting("last_sync", nowIso);
        saveConfig({ last_sync_at: nowIso, last_sync_status: "ok" });

        results.fudo = {
          ok: true,
          desde: dFrom,
          hasta: dTo,
          inserted: fudoRes.lines.length,
          sales_closed: fudoRes.stats.sales_closed,
          stats: fudoRes.stats,
          ...expensesInfo,
          ...pgInfo,
        };
      } else {
        results.fudo = {
          ok: false,
          skipped: true,
          needs_credentials: true,
          message:
            "Credenciales de Fudo no configuradas. Hacé clic en 'Fudo API' arriba a la derecha para ingresarlas.",
        };
      }
    }

    if (
      mode === "all" ||
      mode === "contable" ||
      mode === "sheets" ||
      mode === "fudo"
    ) {
      try {
        const contableRes = await syncAndReconcileContableMonth({ mesKey });
        results.contable = {
          ok: true,
          hoja_mes: contableRes.hoja_mes,
          mes_key: contableRes.mes_key,
          filas_procesadas: contableRes.totales.filas_procesadas,
          proveedores_varios_conciliados:
            contableRes.totales.proveedores_varios_conciliados_count,
          proveedores_varios_faltantes_en_fudo:
            contableRes.totales.proveedores_varios_faltantes_count,
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
