import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { DATA_DIR, DB_PATH } from "../config";

const requireNode = createRequire(import.meta.url);
const sqliteModule = requireNode("node:sqlite") as typeof import("node:sqlite");
export const DatabaseSync = sqliteModule.DatabaseSync;
export type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

export const LOCAL_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS sync_log (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       TEXT NOT NULL,
    tab      TEXT NOT NULL,
    status   TEXT NOT NULL,
    rows     INTEGER,
    inserted INTEGER,
    message  TEXT,
    ms       INTEGER
);

CREATE TABLE IF NOT EXISTS expenses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    hash          TEXT,
    fila_origen   INTEGER DEFAULT 0,
    fecha         TEXT NOT NULL DEFAULT '',
    mes           TEXT DEFAULT '',
    mes_key       TEXT DEFAULT '',
    tipo          TEXT DEFAULT 'Variable',
    categoria     TEXT DEFAULT '',
    categoria_key TEXT DEFAULT '',
    subcategoria  TEXT DEFAULT '',
    proveedor     TEXT DEFAULT '',
    proveedor_key TEXT DEFAULT '',
    descripcion   TEXT DEFAULT '',
    cantidad      REAL DEFAULT 1,
    monto         REAL NOT NULL DEFAULT 0,
    medio_pago    TEXT DEFAULT '',
    comprobante   TEXT DEFAULT '',
    validacion    TEXT DEFAULT '',
    fuente        TEXT DEFAULT 'sheet',
    source_row    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_exp_fecha ON expenses(fecha);
CREATE INDEX IF NOT EXISTS ix_exp_mes_key ON expenses(mes_key);
CREATE INDEX IF NOT EXISTS ix_exp_cat_key ON expenses(categoria_key);

CREATE TABLE IF NOT EXISTS sales (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    hash           TEXT,
    semana_key     TEXT NOT NULL DEFAULT '',
    semana         TEXT DEFAULT '',
    fecha          TEXT NOT NULL DEFAULT '',
    mes            TEXT DEFAULT '',
    categoria      TEXT DEFAULT '',
    categoria_key  TEXT DEFAULT '',
    subcategoria   TEXT DEFAULT '',
    producto       TEXT DEFAULT '',
    cantidad       REAL NOT NULL DEFAULT 0,
    ingreso        REAL NOT NULL DEFAULT 0,
    costo          REAL NOT NULL DEFAULT 0,
    ganancia       REAL NOT NULL DEFAULT 0,
    ventas         REAL DEFAULT 0,
    cmv            REAL DEFAULT 0,
    cmv_pct        REAL DEFAULT 0,
    costo_unit     REAL,
    import_batch   TEXT,
    fuente         TEXT DEFAULT 'sheet',
    source         TEXT DEFAULT 'sheet',
    source_row     INTEGER,
    channel        TEXT DEFAULT 'salon',
    cash_amount    REAL DEFAULT 0,
    virtual_amount REAL DEFAULT 0,
    payments_json  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sales_fecha ON sales(fecha);
CREATE INDEX IF NOT EXISTS ix_sales_semana_key ON sales(semana_key);
CREATE INDEX IF NOT EXISTS ix_sales_cat_key ON sales(categoria_key);

CREATE TABLE IF NOT EXISTS weekly_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    hash          TEXT,
    semana_key    TEXT NOT NULL DEFAULT '',
    semana        TEXT DEFAULT '',
    mes_key       TEXT DEFAULT '',
    mes           TEXT DEFAULT '',
    fecha_inicio  TEXT DEFAULT '',
    fecha_fin     TEXT DEFAULT '',
    categoria     TEXT DEFAULT '',
    cantidad      REAL DEFAULT 0,
    ingreso       REAL DEFAULT 0,
    costo         REAL DEFAULT 0,
    ganancia      REAL DEFAULT 0,
    gastos        REAL DEFAULT 0,
    ventas        REAL DEFAULT 0,
    cmv           REAL DEFAULT 0,
    cmv_pct       REAL,
    participacion REAL,
    observaciones TEXT DEFAULT '',
    source_row    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_wh_semana_key ON weekly_history(semana_key);

CREATE TABLE IF NOT EXISTS monthly_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    hash       TEXT,
    mes_key    TEXT NOT NULL DEFAULT '',
    mes        TEXT DEFAULT '',
    ingreso    REAL DEFAULT 0,
    costo      REAL DEFAULT 0,
    ganancia   REAL DEFAULT 0,
    gastos     REAL DEFAULT 0,
    ventas     REAL DEFAULT 0,
    cmv        REAL DEFAULT 0,
    bruto      REAL DEFAULT 0,
    cmv_pct    REAL DEFAULT 0,
    resultado  REAL DEFAULT 0,
    margen     REAL DEFAULT 0,
    snapshot   INTEGER DEFAULT 0,
    source_row INTEGER
);
CREATE INDEX IF NOT EXISTS ix_mh_mes_key ON monthly_history(mes_key);

CREATE TABLE IF NOT EXISTS entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    creado_en    TEXT NOT NULL DEFAULT '',
    created_at   TEXT DEFAULT '',
    fecha        TEXT NOT NULL DEFAULT '',
    mes          TEXT NOT NULL DEFAULT '',
    tipo         TEXT DEFAULT 'Variable',
    proveedor    TEXT DEFAULT '',
    categoria    TEXT DEFAULT '',
    subcategoria TEXT DEFAULT '',
    descripcion  TEXT DEFAULT '',
    monto        REAL NOT NULL DEFAULT 0,
    cantidad     REAL DEFAULT 1,
    medio_pago   TEXT DEFAULT 'Efectivo',
    comprobante  TEXT DEFAULT '',
    estado       TEXT NOT NULL DEFAULT 'pendiente',
    enviado_en   TEXT DEFAULT '',
    pushed_at    TEXT DEFAULT '',
    error        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_entries_estado ON entries(estado);

CREATE TABLE IF NOT EXISTS external_expenses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    creado_en     TEXT NOT NULL DEFAULT (datetime('now')),
    fecha         TEXT DEFAULT '',
    mes_key       TEXT DEFAULT '',
    categoria     TEXT DEFAULT '',
    categoria_key TEXT DEFAULT '',
    proveedor     TEXT DEFAULT '',
    proveedor_key TEXT DEFAULT '',
    descripcion   TEXT DEFAULT '',
    monto         REAL NOT NULL DEFAULT 0,
    es_fijo       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS fudo_expenses (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id   TEXT UNIQUE,
    fecha         TEXT NOT NULL DEFAULT '',
    categoria     TEXT DEFAULT '',
    proveedor     TEXT DEFAULT '',
    proveedor_key TEXT DEFAULT '',
    descripcion   TEXT DEFAULT '',
    monto         REAL NOT NULL DEFAULT 0,
    medio_pago    TEXT DEFAULT '',
    estado        TEXT DEFAULT 'confirmed',
    payload       TEXT
);
CREATE INDEX IF NOT EXISTS ix_fudo_exp_fecha ON fudo_expenses(fecha);

CREATE TABLE IF NOT EXISTS ingredient_prices (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient   TEXT NOT NULL,
    expense_date TEXT NOT NULL,
    unit_price   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS contable_ledger (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    hash                TEXT UNIQUE,
    hoja_mes            TEXT NOT NULL DEFAULT '',
    mes_key             TEXT NOT NULL DEFAULT '',
    fila_origen         INTEGER DEFAULT 0,
    fecha               TEXT NOT NULL DEFAULT '',
    proveedor           TEXT NOT NULL DEFAULT '',
    proveedor_key       TEXT NOT NULL DEFAULT '',
    cuenta              TEXT NOT NULL DEFAULT '',
    tipo                TEXT DEFAULT '',
    detalle             TEXT DEFAULT '',
    entrada_d           REAL DEFAULT 0,
    salida_h            REAL DEFAULT 0,
    monto_efectivo      REAL DEFAULT 0,
    saldo               REAL DEFAULT 0,
    observaciones       TEXT DEFAULT '',
    estado_pago         TEXT DEFAULT 'pagado',
    origen_clasificado  TEXT DEFAULT 'proveedores_varios',
    estado_conciliacion TEXT DEFAULT 'pendiente',
    posicion_actual     TEXT DEFAULT 'gasto_externo',
    fudo_expense_id     TEXT DEFAULT '',
    diferencia_monto    REAL DEFAULT 0,
    resuelto            INTEGER DEFAULT 0,
    resolucion_accion   TEXT DEFAULT '',
    resolucion_nota     TEXT DEFAULT '',
    updated_at          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_contable_mes ON contable_ledger(mes_key);
CREATE INDEX IF NOT EXISTS ix_contable_fecha ON contable_ledger(fecha);
`;

let activeDbOverride: DatabaseSyncInstance | null = null;
let singletonDb: DatabaseSyncInstance | null = null;

export function initSqliteSchema(db: DatabaseSyncInstance): void {
  db.exec(LOCAL_SCHEMA);
}

export function setTestSqliteDb(db: DatabaseSyncInstance | null): void {
  activeDbOverride = db;
  if (db) {
    initSqliteSchema(db);
  }
}

export function getSqliteDb(): DatabaseSyncInstance {
  if (activeDbOverride) {
    return activeDbOverride;
  }
  if (!singletonDb) {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    singletonDb = new DatabaseSync(DB_PATH);
    initSqliteSchema(singletonDb);
  }
  return singletonDb;
}

export function withSqlite<T>(fn: (conn: DatabaseSyncInstance) => T): T {
  const conn = getSqliteDb();
  return fn(conn);
}

export function runTransaction<T>(fn: () => T): T {
  const conn = getSqliteDb();
  conn.exec("BEGIN");
  try {
    const res = fn();
    conn.exec("COMMIT");
    return res;
  } catch (err) {
    try {
      conn.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
}

function isDbInstance(arg: unknown): arg is DatabaseSyncInstance {
  return Boolean(arg && typeof arg === "object" && "prepare" in arg);
}

export function queryAll<T = Record<string, unknown>>(
  sqlOrConn: string | DatabaseSyncInstance,
  paramsOrSql?: unknown[] | string,
  maybeParams?: unknown[]
): T[] {
  const conn = isDbInstance(sqlOrConn) ? sqlOrConn : getSqliteDb();
  const sql = isDbInstance(sqlOrConn) ? (paramsOrSql as string) : sqlOrConn;
  const params = isDbInstance(sqlOrConn)
    ? maybeParams || []
    : (paramsOrSql as unknown[]) || [];

  const stmt = conn.prepare(sql);
  return stmt.all(
    ...(params as (string | number | bigint | Uint8Array | null)[])
  ) as unknown as T[];
}

export function queryOne<T = Record<string, unknown>>(
  sqlOrConn: string | DatabaseSyncInstance,
  paramsOrSql?: unknown[] | string,
  maybeParams?: unknown[]
): T | undefined {
  const conn = isDbInstance(sqlOrConn) ? sqlOrConn : getSqliteDb();
  const sql = isDbInstance(sqlOrConn) ? (paramsOrSql as string) : sqlOrConn;
  const params = isDbInstance(sqlOrConn)
    ? maybeParams || []
    : (paramsOrSql as unknown[]) || [];

  const stmt = conn.prepare(sql);
  return stmt.get(
    ...(params as (string | number | bigint | Uint8Array | null)[])
  ) as unknown as T | undefined;
}

export function executeSql(
  sqlOrConn: string | DatabaseSyncInstance,
  paramsOrSql?: unknown[] | string,
  maybeParams?: unknown[]
): { changes: number; lastInsertRowid: number } {
  const conn = isDbInstance(sqlOrConn) ? sqlOrConn : getSqliteDb();
  const sql = isDbInstance(sqlOrConn) ? (paramsOrSql as string) : sqlOrConn;
  const params = isDbInstance(sqlOrConn)
    ? maybeParams || []
    : (paramsOrSql as unknown[]) || [];

  const stmt = conn.prepare(sql);
  const res = stmt.run(
    ...(params as (string | number | bigint | Uint8Array | null)[])
  );
  return {
    changes: Number(res.changes ?? 0),
    lastInsertRowid: Number(res.lastInsertRowid ?? 0),
  };
}

export function getSetting(key: string, defaultValue = ""): string {
  const row = queryOne<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key]
  );
  return row && row.value !== undefined && row.value !== null
    ? String(row.value)
    : defaultValue;
}

export function setSetting(key: string, value: string): void {
  executeSql(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

export function logSync(
  tab: string,
  status: string,
  rows: number,
  inserted: number,
  message = "",
  ms = 0
): void {
  executeSql(
    "INSERT INTO sync_log(ts, tab, status, rows, inserted, message, ms) VALUES(?,?,?,?,?,?,?)",
    [new Date().toISOString(), tab, status, rows, inserted, message, ms]
  );
}
