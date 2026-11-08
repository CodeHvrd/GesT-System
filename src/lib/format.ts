/**
 * Utilidades de números, monedas, porcentajes y normalización de texto (es-AR).
 * Migración 100% compatible con `app/util.py` y `cloud/analytics_pg.py`.
 */

export function round(v: unknown, decimals = 2): number {
  const n = Number(v || 0);
  if (!Number.isFinite(n)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round((n + Number.EPSILON) * factor) / factor;
}

export function f(v: unknown): number {
  const n = Number(v || 0);
  return Number.isFinite(n) ? n : 0;
}

export function safeDiv(
  a: number | null | undefined,
  b: number | null | undefined
): number {
  if (
    a === null ||
    a === undefined ||
    b === null ||
    b === undefined ||
    b === 0
  ) {
    return 0;
  }
  const res = a / b;
  return Number.isFinite(res) ? res : 0;
}

/**
 * Normaliza espacios simples preservando capitalización para textos legibles.
 */
export function norm(text: unknown): string {
  return String(text ?? "")
    .replace(/\u200b/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza un texto para llaves de comparación (sin tildes, minúsculas, `&` -> `y`).
 */
export function normKey(s: unknown): string {
  const raw = String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " y ")
    .replace(/[^a-z0-9\s]/g, " ");
  return raw.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Normaliza nombres de proveedor quitando sufijos societarios (SRL, SA, etc.).
 */
export function normProvider(name: unknown): string {
  const base = normKey(name);
  if (!base) return "";
  const tokens = base
    .split(" ")
    .filter(
      (t) =>
        t &&
        !["srl", "sa", "sas", "s", "r", "l", "a", "sh", "hnos"].includes(t)
    );
  return tokens.join(" ");
}

/**
 * Convierte montos es-AR / en-US a número (devuelve 0 si está vacío o inválido).
 */
export function parseNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  let s = String(value).trim();
  if (!s) return 0;

  let neg = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s
    .replace(/\u2212/g, "-")
    .replace(/%/g, "")
    .replace(/\$/g, "")
    .replace(/ARS/gi, "")
    .replace(/U\$S/gi, "")
    .replace(/[\s\u00a0]/g, "");

  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  s = s.replace(/[^0-9.,]/g, "");
  if (!s) return 0;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    const parts = s.split(",");
    if (parts.length === 2 && parts[1].length === 3 && parts[0].length > 3) {
      s = s.replace(/,/g, "");
    } else {
      s = s.replace(",", ".");
    }
  } else if (hasDot) {
    const parts = s.split(".");
    if (
      parts.length > 2 ||
      (parts.length === 2 &&
        parts[1].length === 3 &&
        parts[0].length >= 1 &&
        !s.startsWith("0."))
    ) {
      s = s.replace(/\./g, "");
    }
  }

  const v = Number.parseFloat(s);
  if (!Number.isFinite(v)) return 0;
  return neg ? -v : v;
}

/**
 * Devuelve fracción decimal (ej. "35%" -> 0.35, 0.28 -> 0.28, 42 -> 0.42).
 */
export function parsePercent(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const v = parseNumber(value);
  if (v === 0) return 0;
  if (Math.abs(v) > 1) return v / 100;
  return v;
}

export function parseIntSafe(value: unknown): number {
  return Math.round(parseNumber(value));
}

function formatEsArNumber(absVal: number, decimals: number): string {
  const fixed = absVal.toFixed(decimals);
  const [intPart, decPart] = fixed.split(".");
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return decimals > 0 && decPart !== undefined
    ? `${withThousands},${decPart}`
    : withThousands;
}

export function money(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "$0";
  const num = Number(v);
  const sign = num < 0 ? "-" : "";
  return `${sign}$${formatEsArNumber(Math.abs(num), decimals)}`;
}

export function shortMoney(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "$0";
  const n = Number(v);
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e6) {
    return `${sign}$${(abs / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (abs >= 1e3) {
    return `${sign}$${Math.round(abs / 1e3)}k`;
  }
  return `${sign}$${Math.round(abs)}`;
}

export function number(v: number | null | undefined, decimals = 0): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "0";
  const num = Number(v);
  const sign = num < 0 ? "-" : "";
  return `${sign}${formatEsArNumber(Math.abs(num), decimals)}`;
}

/**
 * Formatea porcentaje aceptando tanto fracción (0.352 -> "35,2%") como puntos (> 1.5 -> "35,2%").
 */
export function pct(v: number | null | undefined, decimals = 1): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "0,0%";
  let num = Number(v);
  if (Math.abs(num) <= 1.5 && num !== 0) {
    num = num * 100;
  }
  return `${num.toFixed(decimals).replace(".", ",")}%`;
}

export function signed(
  v: number | null | undefined,
  formatter?: ((val: number) => string) | number,
  suffix = ""
): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "0";
  const num = Number(v);
  const sign = num > 0 ? "+" : num < 0 ? "-" : "";
  if (typeof formatter === "function") {
    return `${sign}${formatter(Math.abs(num))}`;
  }
  const dec = typeof formatter === "number" ? formatter : 1;
  return `${sign}${number(Math.abs(num), dec)}${suffix}`;
}

export function pctPoints(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "0,0 pp";
  let num = Number(v);
  if (Math.abs(num) <= 1.5 && num !== 0) {
    num = num * 100;
  }
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(1).replace(".", ",")} pp`;
}

export function plural(n: number, singular: string, pluralStr: string): string {
  return n === 1 ? singular : pluralStr;
}
