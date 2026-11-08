import fs from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { ROOT_DIR } from "../config";

let pool: Pool | null = null;

export function loadEnvFile(envPath: string = path.join(ROOT_DIR, ".env")): void {
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf-8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const k = line.slice(0, idx).trim();
    const v = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!process.env[k]) {
      process.env[k] = v;
    }
  }
}

export function hasPostgresUrl(): boolean {
  loadEnvFile();
  return Boolean(
    (process.env.DATABASE_URL || process.env.DATABASE_URL_DIRECT || "").trim()
  );
}

export const hasPostgresConfig = hasPostgresUrl;

export function getDatabaseUrl(direct = false): string {
  loadEnvFile();
  if (direct) {
    const directUrl = (process.env.DATABASE_URL_DIRECT || "").trim();
    if (directUrl) return directUrl;
  }
  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    throw new Error("Falta DATABASE_URL en las variables de entorno.");
  }
  return url;
}

export function getPgPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(false),
      max: 5,
      connectionTimeoutMillis: 15000,
    });
  }
  return pool;
}

export async function withPg<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPgPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function pgQueryAll<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return withPg(async (client) => {
    const res = await client.query(sql, params);
    return (res.rows || []) as T[];
  });
}

export async function pgQueryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const rows = await pgQueryAll<T>(sql, params);
  return rows[0];
}

export async function pgExecute(
  sql: string,
  params: unknown[] = []
): Promise<number> {
  return withPg(async (client) => {
    const res = await client.query(sql, params);
    return res.rowCount || 0;
  });
}

export async function pgHealthCheck(): Promise<boolean> {
  try {
    const row = await pgQueryOne<{ ok: number }>("SELECT 1 AS ok");
    return row?.ok === 1;
  } catch {
    return false;
  }
}
