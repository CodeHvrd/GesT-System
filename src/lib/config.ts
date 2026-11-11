/**
 * Configuración persistente del sistema (`config.json` + SQLite settings + Neon PostgreSQL `fudo_credentials`).
 * Migración 100% compatible con `app/config.py` y `cloud/server_pg.py`.
 */

import fs from "node:fs";
import path from "node:path";
import { normKey, parsePercent, round } from "./format";
import { getSetting, setSetting } from "./db/local-db";

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const CONFIG_PATH = path.join(ROOT_DIR, "config.json");
export const DB_PATH = path.join(DATA_DIR, "gestion.db");

export interface TabConfig {
  name: string;
  gid: number;
}

export interface AppConfig {
  nombre_negocio: string;
  restaurant: string;
  moneda: string;
  sheet_id: string;
  sheet_url: string;
  sheet_contable_id: string;
  sheet_contable_gid: number;
  sheet_contable_url: string;
  fudo_sync_hours_arg: string[];
  last_scheduled_sync_slot?: string;
  last_sync_at?: string;
  last_sync_status?: string;
  google_api_key: string;
  apps_script_webhook_url: string;
  webhook_url: string;
  webhook_token: string;
  fudo_api_key: string;
  fudo_api_secret: string;
  fudo_auth_url: string;
  fudo_api_url: string;
  cmv_objetivo_general: number;
  cmv_objetivo_por_categoria: Record<string, number>;
  gastos_fijos_categorias: string[];
  alerta_caida_ventas_pct: number;
  alerta_suba_cmv_puntos: number;
  tabs: Record<string, string | TabConfig>;
}

export const DEFAULT_CONFIG: AppConfig = {
  nombre_negocio: "GesT — Gestión Gastronómica",
  restaurant: "GesT — Gestión Gastronómica",
  moneda: "ARS",
  sheet_id: "",
  sheet_url: "",
  sheet_contable_id: "1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh",
  sheet_contable_gid: 1313414032,
  sheet_contable_url:
    "https://docs.google.com/spreadsheets/d/1gNitzY7n44UYr1FP-RFpIPchRT4A1oSh/edit?gid=1313414032#gid=1313414032",
  fudo_sync_hours_arg: ["02:00", "16:00"],
  google_api_key: "",
  apps_script_webhook_url: "",
  webhook_url: "",
  webhook_token: "",
  fudo_api_key: "",
  fudo_api_secret: "",
  fudo_auth_url: "https://auth.fu.do/api",
  fudo_api_url: "https://api.fu.do/v1alpha1",
  cmv_objetivo_general: 0.35,
  cmv_objetivo_por_categoria: {
    cafeteria: 0.25,
    pasteleria: 0.35,
    panaderia: 0.35,
    cocina: 0.38,
    bebidas: 0.4,
  },
  gastos_fijos_categorias: [
    "Alquiler",
    "Sueldos",
    "Impuestos",
    "Servicios",
    "Luz",
    "Gas",
    "Internet",
    "Contador",
    "Seguro",
  ],
  alerta_caida_ventas_pct: 0.15,
  alerta_suba_cmv_puntos: 3,
  tabs: {
    expenses: "GASTOS",
    sales: "VENTAS",
    weekly: "SEMANAL",
    monthly: "MENSUAL",
  },
};

export function sheetIdFromUrl(urlOrId: string | null | undefined): string {
  const s = String(urlOrId || "").trim();
  if (!s) return "";
  const m = /\/spreadsheets\/d\/([a-zA-Z0-9_-]{15,})/.exec(s);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{15,}$/.test(s)) return s;
  return s;
}

export function tabUrl(sheetIdOrCfg: string | AppConfig, tabName: string): string {
  const sid =
    typeof sheetIdOrCfg === "string"
      ? sheetIdFromUrl(sheetIdOrCfg)
      : sheetIdFromUrl(sheetIdOrCfg.sheet_id || sheetIdOrCfg.sheet_url);
  if (!sid) return "";
  return `https://docs.google.com/spreadsheets/d/${sid}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
}

export function parseTargetsText(text: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[=:]/);
    if (parts.length < 2) continue;
    const k = normKey(parts[0]);
    const val = parsePercent(parts.slice(1).join("="));
    if (k && val > 0) {
      out[k] = round(val, 4);
    }
  }
  return out;
}

export function targetsText(targets: Record<string, number> | undefined): string {
  const obj = targets || DEFAULT_CONFIG.cmv_objetivo_por_categoria;
  return Object.entries(obj)
    .map(([k, v]) => `${k} = ${round((v <= 1 ? v * 100 : v), 1)}%`)
    .join("\n");
}

export function loadConfig(customPath: string = CONFIG_PATH): AppConfig {
  const cfg: AppConfig = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  if (fs.existsSync(customPath)) {
    try {
      const raw = fs.readFileSync(customPath, "utf-8");
      const stored = JSON.parse(raw) as Record<string, any>;
      if (stored && typeof stored === "object") {
        Object.assign(cfg, stored);
        if (stored.fudo && typeof stored.fudo === "object") {
          if (!cfg.fudo_api_key && stored.fudo.api_key) cfg.fudo_api_key = stored.fudo.api_key;
          if (!cfg.fudo_api_secret && stored.fudo.api_secret) cfg.fudo_api_secret = stored.fudo.api_secret;
        }
      }
    } catch {
      // ignore invalid config.json
    }
  }

  // Si no están en config.json, intentar leer de SQLite settings (persistencia local permanente)
  try {
    if (!cfg.fudo_api_key) {
      const dbKey = getSetting("fudo_api_key");
      if (dbKey) cfg.fudo_api_key = dbKey.trim();
    }
    if (!cfg.fudo_api_secret) {
      const dbSecret = getSetting("fudo_api_secret");
      if (dbSecret) cfg.fudo_api_secret = dbSecret.trim();
    }
  } catch {
    // ignore
  }

  // Variables de entorno de Render / Docker
  if (!cfg.fudo_api_key && process.env.FUDO_API_KEY) {
    cfg.fudo_api_key = process.env.FUDO_API_KEY.trim();
  }
  if (!cfg.fudo_api_secret && process.env.FUDO_API_SECRET) {
    cfg.fudo_api_secret = process.env.FUDO_API_SECRET.trim();
  }
  if (cfg.sheet_url && !cfg.sheet_id) {
    cfg.sheet_id = sheetIdFromUrl(cfg.sheet_url);
  }
  return cfg;
}

export function saveConfig(
  partial: Record<string, unknown>,
  customPath: string = CONFIG_PATH
): AppConfig {
  const current = loadConfig(customPath);
  const next: AppConfig = {
    ...current,
    ...(partial as Partial<AppConfig>),
  };
  if (next.sheet_url && !partial.sheet_id) {
    next.sheet_id = sheetIdFromUrl(next.sheet_url);
  } else if (next.sheet_id) {
    next.sheet_id = sheetIdFromUrl(next.sheet_id);
  }

  // Escribir en config.json
  try {
    fs.writeFileSync(customPath, JSON.stringify(next, null, 2), "utf-8");
  } catch {
    // ignore read-only fs errors in restricted environments
  }

  // Persistir siempre también en SQLite settings para que sobreviva recreaciones de contenedor
  try {
    if (next.fudo_api_key) {
      setSetting("fudo_api_key", next.fudo_api_key);
    }
    if (next.fudo_api_secret) {
      setSetting("fudo_api_secret", next.fudo_api_secret);
    }
  } catch {
    // ignore
  }

  return next;
}
