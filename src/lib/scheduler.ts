import { loadConfig, saveConfig } from "./config";
import { todayArgIso } from "./dates";
import { FudoClient } from "./fudo/client";
import {
  fetchSales,
  fetchFudoExpensesAndCashMovements,
  saveFudoExpensesAndCashToLocalDb,
  resolveFudoCredentials,
  syncFudoToPostgres,
} from "./fudo/sync";
import { replaceSalesWeeks } from "./sheets/sync";
import {
  syncAndReconcileContableMonth,
  contableTabNameForMonth,
} from "./sheets/contable";

/**
 * Horarios programados por defecto en Hora Argentina (ART = UTC-3):
 * - 02:00 hs ARG (05:00 UTC) -> Cierre del turno noche
 * - 16:00 hs ARG (19:00 UTC) -> Corte de mediodía / tarde
 */
export const DEFAULT_SCHEDULED_HOURS_ARG = ["02:00", "16:00"] as const;

export interface ScheduleWindowStatus {
  now_arg_iso: string;
  current_hour_arg: string;
  scheduled_hours_arg: string[];
  matching_slot: string | null;
  slot_key: string | null;
  already_ran_slot: boolean;
  should_run: boolean;
  next_slot_arg: string;
  last_scheduled_sync_slot: string;
  last_sync_at: string;
}

/**
 * Obtiene la fecha y hora actual en Argentina (ART = UTC-3) a partir de un Date UTC.
 */
export function getArgDateParts(nowUtc: Date = new Date()): {
  dateIso: string;
  hour: number;
  minute: number;
  hhmm: string;
} {
  const argTime = new Date(nowUtc.getTime() - 3 * 3600 * 1000);
  const year = argTime.getUTCFullYear();
  const month = String(argTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(argTime.getUTCDate()).padStart(2, "0");
  const hour = argTime.getUTCHours();
  const minute = argTime.getUTCMinutes();
  const dateIso = `${year}-${month}-${day}`;
  const hhmm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0"
  )}`;
  return { dateIso, hour, minute, hhmm };
}

/**
 * Verifica si corresponde ejecutar la sincronización programada de Fudo (02:00 hs ARG o 16:00 hs ARG)
 * dentro de una ventana de tolerancia (por defecto 45 minutos desde la hora programada).
 */
export function evaluateScheduleStatus(
  nowUtc: Date = new Date(),
  toleranceMinutes = 45
): ScheduleWindowStatus {
  const cfg = loadConfig();
  const scheduledHours =
    Array.isArray(cfg.fudo_sync_hours_arg) && cfg.fudo_sync_hours_arg.length > 0
      ? cfg.fudo_sync_hours_arg
      : [...DEFAULT_SCHEDULED_HOURS_ARG];

  const { dateIso, hour, minute, hhmm } = getArgDateParts(nowUtc);
  const currentMinutesOfDay = hour * 60 + minute;

  let matchingSlot: string | null = null;
  for (const slot of scheduledHours) {
    const [slotH, slotM] = slot.split(":").map((n) => parseInt(n, 10));
    if (Number.isNaN(slotH) || Number.isNaN(slotM)) continue;
    const slotMinutes = slotH * 60 + slotM;
    const diff = currentMinutesOfDay - slotMinutes;
    if (diff >= 0 && diff <= toleranceMinutes) {
      matchingSlot = slot;
      break;
    }
  }

  const slotKey = matchingSlot ? `${dateIso}@${matchingSlot}` : null;
  const lastSlot = String(cfg.last_scheduled_sync_slot || "");
  const alreadyRan = Boolean(slotKey && lastSlot === slotKey);

  let nextSlotArg = scheduledHours[0] || "02:00";
  const sortedSlots = [...scheduledHours].sort();
  for (const slot of sortedSlots) {
    const [slotH, slotM] = slot.split(":").map((n) => parseInt(n, 10));
    if (slotH * 60 + slotM > currentMinutesOfDay) {
      nextSlotArg = `${dateIso} ${slot} ARG`;
      break;
    }
    nextSlotArg = `Mañana ${sortedSlots[0]} ARG`;
  }

  return {
    now_arg_iso: `${dateIso}T${hhmm}:00-03:00`,
    current_hour_arg: hhmm,
    scheduled_hours_arg: scheduledHours,
    matching_slot: matchingSlot,
    slot_key: slotKey,
    already_ran_slot: alreadyRan,
    should_run: Boolean(matchingSlot && !alreadyRan),
    next_slot_arg: nextSlotArg,
    last_scheduled_sync_slot: lastSlot,
    last_sync_at: String(cfg.last_sync_at || ""),
  };
}

/**
 * Ejecuta la sincronización programada o manual completa:
 * 1. Ventas e ítems de Fudo API
 * 2. Gastos Fudo (materia prima / ingredientes) + Movimientos de Caja (Principal y Caja Grande)
 * 3. Persistencia en SQLite local y en Neon PostgreSQL
 * 4. Doble checkeo y conciliación con Planilla Contable del mes correspondiente
 */
export async function runFullFudoAndContableSync(options?: {
  daysBack?: number;
  mesKey?: string;
  slotKey?: string | null;
}) {
  const daysBack = options?.daysBack ?? 30;
  const todayIso = todayArgIso();
  const dFrom = new Date(`${todayIso}T12:00:00Z`);
  dFrom.setUTCDate(dFrom.getUTCDate() - daysBack);
  const fromIso = dFrom.toISOString().slice(0, 10);
  const mesKey = options?.mesKey || todayIso.slice(0, 7);

  const results: Record<string, unknown> = {
    from: fromIso,
    to: todayIso,
    mes_key: mesKey,
    hoja_contable: contableTabNameForMonth(mesKey),
  };

  const creds = await resolveFudoCredentials();
  if (creds.apiKey && creds.apiSecret) {
    const client = new FudoClient({
      apiKey: creds.apiKey,
      apiSecret: creds.apiSecret,
      authUrl: creds.authUrl,
      apiUrl: creds.apiUrl,
    });

    let fudoRes: Awaited<ReturnType<typeof fetchSales>> | null = null;
    try {
      fudoRes = await fetchSales(client, fromIso, todayIso);
      if (fudoRes.lines.length > 0) {
        replaceSalesWeeks(fudoRes.lines);
      }
      results.fudo_sales = {
        ok: true,
        sales_saved: fudoRes.lines.length,
        stats: fudoRes.stats,
      };
    } catch (err) {
      results.fudo_sales = { ok: false, error: (err as Error).message };
    }

    let expData: Awaited<
      ReturnType<typeof fetchFudoExpensesAndCashMovements>
    > | undefined;
    try {
      expData = await fetchFudoExpensesAndCashMovements(
        client,
        fromIso,
        todayIso
      );
      const savedExp = saveFudoExpensesAndCashToLocalDb(expData);
      results.fudo_expenses_and_cash = {
        ok: true,
        ...savedExp,
      };
    } catch (err) {
      results.fudo_expenses_and_cash = {
        ok: false,
        error: (err as Error).message,
      };
    }

    if (fudoRes) {
      try {
        const pgSync = await syncFudoToPostgres({
          dFrom: fromIso,
          dTo: todayIso,
          pgSales: fudoRes.pgSales,
          catalog: fudoRes.catalog,
          expData,
        });
        results.postgres_sync = pgSync;
      } catch (err) {
        results.postgres_sync = { ok: false, error: (err as Error).message };
      }
    }
  } else {
    results.fudo_sales = {
      ok: false,
      skipped: true,
      message: "Credenciales de Fudo no configuradas.",
    };
  }

  try {
    const reconciliation = await syncAndReconcileContableMonth({ mesKey });
    results.contable_reconciliation = {
      ok: reconciliation.ok,
      hoja_mes: reconciliation.hoja_mes,
      total_filas: reconciliation.totales?.filas_procesadas || 0,
      proveedores_varios_conciliados:
        reconciliation.totales?.proveedores_varios_conciliados_count || 0,
      proveedores_varios_faltantes_en_fudo:
        reconciliation.totales?.proveedores_varios_faltantes_count || 0,
      discrepancias_pendientes:
        reconciliation.discrepancias_pendientes?.length || 0,
    };
  } catch (err) {
    results.contable_reconciliation = {
      ok: false,
      error: (err as Error).message,
    };
  }

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    last_sync_at: nowIso,
    last_sync_status: "ok",
  };
  if (options?.slotKey) {
    patch.last_scheduled_sync_slot = options.slotKey;
  }
  saveConfig(patch);

  return results;
}
