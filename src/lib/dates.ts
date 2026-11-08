/**
 * Utilidades de fechas, semanas del local (S1..S5), meses y zona horaria Argentina (UTC-3).
 * Migración 100% compatible con `app/util.py` y `cloud/analytics_pg.py`.
 */

import { parseNumber } from "./format";

export const MESES: Record<number, string> = {
  1: "Enero",
  2: "Febrero",
  3: "Marzo",
  4: "Abril",
  5: "Mayo",
  6: "Junio",
  7: "Julio",
  8: "Agosto",
  9: "Septiembre",
  10: "Octubre",
  11: "Noviembre",
  12: "Diciembre",
};

export const MESES_CORTO: Record<number, string> = {
  1: "ene",
  2: "feb",
  3: "mar",
  4: "abr",
  5: "may",
  6: "jun",
  7: "jul",
  8: "ago",
  9: "sep",
  10: "oct",
  11: "nov",
  12: "dic",
};

export function todayAr(now: Date = new Date()): string {
  const artMs = now.getTime() - 3 * 3600 * 1000;
  const d = new Date(artMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export const todayArgIso = todayAr;

export function localDateFromUtc(value: unknown): string {
  if (!value) return "";
  const s = String(value).trim();
  if (!s) return "";
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return "";
  const artMs = dt.getTime() - 3 * 3600 * 1000;
  const art = new Date(artMs);
  const yyyy = art.getUTCFullYear();
  const mm = String(art.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(art.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidYmd(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  const maxDay = daysInMonth(year, month);
  return day >= 1 && day <= maxDay;
}

function formatYmd(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseDate(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return value.toISOString().slice(0, 10);
  }
  let s = String(value).trim();
  if (!s) return "";
  s = s.split(" ")[0].split("T")[0];

  // YYYY-MM-DD
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (isValidYmd(y, mo, d)) return formatYmd(y, mo, d);
  }

  // DD/MM/YYYY o DD-MM-YYYY o DD.MM.YYYY
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s);
  if (m) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (isValidYmd(y, mo, d)) return formatYmd(y, mo, d);
    const [mo2, d2] = [Number(m[1]), Number(m[2])];
    if (isValidYmd(y, mo2, d2)) return formatYmd(y, mo2, d2);
  }

  // DD/MM/YY
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(s);
  if (m) {
    const [d, mo, yy] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const y = yy >= 70 ? 1900 + yy : 2000 + yy;
    if (isValidYmd(y, mo, d)) return formatYmd(y, mo, d);
  }

  // Serial de Excel
  const num = Number(s);
  if (Number.isFinite(num) && num > 20000 && num < 60000) {
    const baseMs = Date.UTC(1899, 11, 30) + Math.trunc(num) * 86400000;
    const dt = new Date(baseMs);
    return dt.toISOString().slice(0, 10);
  }

  return "";
}

/**
 * '2026-08' / '20226-10' / 'Abril 2026' -> 'YYYY-MM'
 */
export function parseMonthKey(value: unknown, fallbackDate = ""): string {
  const fbYear = fallbackDate ? fallbackDate.slice(0, 4) : todayAr().slice(0, 4);
  if (!value) return fallbackDate ? fallbackDate.slice(0, 7) : "";
  const s = String(value).trim().toLowerCase();

  // Fix 5-digit year typos like 20226-10 -> 2026-10
  const m = /(\d{4,5})-(\d{1,2})/.exec(s);
  if (m) {
    let yearStr = m[1];
    const month = Number(m[2]);
    if (yearStr.length === 5 && yearStr.startsWith("20")) {
      yearStr = `20${yearStr.slice(-2)}`;
    }
    if (month >= 1 && month <= 12) {
      return `${String(Number(yearStr)).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    }
  }

  for (const [numStr, name] of Object.entries(MESES)) {
    if (s.includes(name.toLowerCase())) {
      const y = /(20\d{2})/.exec(s);
      const yr = y ? y[1] : fbYear;
      return `${yr}-${String(Number(numStr)).padStart(2, "0")}`;
    }
  }

  return fallbackDate ? fallbackDate.slice(0, 7) : "";
}

/**
 * El local usa semanas relativas al mes:
 * S1 = 1-7, S2 = 8-14, S3 = 15-21, S4 = 22-28, S5 = 29-fin de mes.
 */
export function weekKey(isoDate: string): string {
  const d = parseDate(isoDate);
  if (!d) return "";
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  const idx = Math.min(5, Math.floor((day - 1) / 7) + 1);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-S${idx}`;
}

export function weekBounds(key: string): [string, string] {
  const m = /^(\d{4})-(\d{2})-S(\d)$/.exec(key);
  if (!m) {
    return ["", ""];
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const idx = Number(m[3]);
  const last = daysInMonth(year, month);
  let startDay = 1 + 7 * (idx - 1);
  let endDay = idx === 5 ? last : Math.min(7 * idx, last);
  if (startDay > last) {
    startDay = last;
    endDay = last;
  }
  return [formatYmd(year, month, startDay), formatYmd(year, month, endDay)];
}

export function weekIndex(key: string): number {
  return Number(key.slice(-1)) || 1;
}

export function prevWeek(key: string): string {
  let year = Number(key.slice(0, 4));
  let month = Number(key.slice(5, 7));
  const idx = weekIndex(key);
  if (idx > 1) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-S${idx - 1}`;
  }
  month -= 1;
  if (month === 0) {
    year -= 1;
    month = 12;
  }
  const last = daysInMonth(year, month);
  const lastIdx = Math.min(5, Math.floor((last - 1) / 7) + 1);
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-S${lastIdx}`;
}

export function nextWeek(key: string): string {
  let year = Number(key.slice(0, 4));
  let month = Number(key.slice(5, 7));
  const idx = weekIndex(key);
  const last = daysInMonth(year, month);
  const maxIdx = Math.min(5, Math.floor((last - 1) / 7) + 1);
  if (idx < maxIdx) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-S${idx + 1}`;
  }
  month += 1;
  if (month === 13) {
    year += 1;
    month = 1;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-S1`;
}

export function prevMonth(month: string): string {
  let year = Number(month.slice(0, 4));
  let m = Number(month.slice(5, 7)) - 1;
  if (m === 0) {
    year -= 1;
    m = 12;
  }
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export function nextMonth(month: string): string {
  let year = Number(month.slice(0, 4));
  let m = Number(month.slice(5, 7)) + 1;
  if (m === 13) {
    year += 1;
    m = 1;
  }
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

export function sameWeekPrevMonth(key: string): string {
  return `${prevMonth(key.slice(0, 7))}-S${weekIndex(key)}`;
}

export function weekLabel(key: string): string {
  const [start, end] = weekBounds(key);
  if (!start || !end) return key;
  const idx = weekIndex(key);
  const sDay = Number(start.slice(8, 10));
  const sMonth = Number(start.slice(5, 7));
  const eDay = Number(end.slice(8, 10));
  return `Semana ${idx} (${sDay}–${eDay} ${MESES_CORTO[sMonth]})`;
}

export function monthLabel(month: string, short = false): string {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const name = short ? MESES_CORTO[m] : MESES[m];
  return `${name} ${year}`;
}

export function currentWeek(todayIso?: string): string {
  return weekKey(todayIso || todayAr());
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function diffDays(d0: string, d1: string): number {
  const [y0, m0, day0] = d0.split("-").map(Number);
  const [y1, m1, day1] = d1.split("-").map(Number);
  const ms0 = Date.UTC(y0, m0 - 1, day0);
  const ms1 = Date.UTC(y1, m1 - 1, day1);
  return Math.round((ms1 - ms0) / 86400000);
}

export function labelPeriod(d0: string, d1: string): string {
  if (!d0 || !d1) return "";
  const [y0, m0, day0] = d0.split("-").map(Number);
  const [y1, m1, day1] = d1.split("-").map(Number);
  const nextAfterD1 = addDays(d1, 1);
  const nextDay = Number(nextAfterD1.slice(8, 10));

  if (day0 === 1 && nextDay === 1 && m0 === m1 && y0 === y1) {
    return `${MESES[m0]} ${y0}`;
  }
  if (y0 === y1 && m0 === m1) {
    return `${day0}–${day1} ${MESES_CORTO[m1]} ${y1}`;
  }
  return `${d0} → ${d1}`;
}

export function previousRange(d0: string, d1: string): [string, string] {
  const [y0, m0, day0] = d0.split("-").map(Number);
  const [y1, m1] = d1.split("-").map(Number);
  const nextAfterD1 = addDays(d1, 1);
  const nextDay = Number(nextAfterD1.slice(8, 10));

  if (day0 === 1 && nextDay === 1 && m0 === m1 && y0 === y1) {
    const prevEnd = addDays(d0, -1);
    const prevStart = `${prevEnd.slice(0, 8)}01`;
    return [prevStart, prevEnd];
  }
  const days = diffDays(d0, d1) + 1;
  const prevEnd = addDays(d0, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return [prevStart, prevEnd];
}

/**
 * Soporta tanto `resolveDateRange(preset, desde, hasta)` como `resolveDateRange({ from, to })`.
 */
export function resolveDateRange(
  presetOrParams?:
    | string
    | null
    | { preset?: string | null; from?: string | null; to?: string | null; desde?: string | null; hasta?: string | null },
  desdeArg?: string | null,
  hastaArg?: string | null
): [string, string] {
  const today = todayAr();
  let preset = "";
  let rawFrom = "";
  let rawTo = "";

  if (presetOrParams && typeof presetOrParams === "object") {
    preset = String(presetOrParams.preset || "").trim().toLowerCase();
    rawFrom = String(presetOrParams.desde || presetOrParams.from || "");
    rawTo = String(presetOrParams.hasta || presetOrParams.to || "");
  } else {
    preset = String(presetOrParams || "").trim().toLowerCase();
    rawFrom = String(desdeArg || "");
    rawTo = String(hastaArg || "");
  }

  const parsedFrom = parseDate(rawFrom);
  const parsedTo = parseDate(rawTo);
  if (!preset && parsedFrom && parsedTo) {
    return parsedFrom <= parsedTo
      ? [parsedFrom, parsedTo]
      : [parsedTo, parsedFrom];
  }

  if (preset === "hoy") {
    return [today, today];
  }
  if (preset === "ayer") {
    const yest = addDays(today, -1);
    return [yest, yest];
  }
  if (preset === "esta-semana") {
    const wk = weekKey(today);
    return weekBounds(wk);
  }
  if (preset === "ultimos-7") {
    return [addDays(today, -6), today];
  }
  if (preset === "ultimos-30") {
    return [addDays(today, -29), today];
  }
  if (preset === "mes-anterior") {
    const pm = prevMonth(today.slice(0, 7));
    const [py, pmo] = pm.split("-").map(Number);
    const last = daysInMonth(py, pmo);
    return [`${pm}-01`, `${pm}-${String(last).padStart(2, "0")}`];
  }
  if (preset === "este-mes") {
    const ym = today.slice(0, 7);
    return [`${ym}-01`, today];
  }

  const d1 = parsedTo || today;
  const d0 = parsedFrom || `${d1.slice(0, 7)}-01`;
  return d0 <= d1 ? [d0, d1] : [d1, d0];
}

export { parseNumber };
