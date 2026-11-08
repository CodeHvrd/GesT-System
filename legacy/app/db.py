"""Base de datos SQLite: esquema y helpers."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from .config import DB_PATH, DATA_DIR

SCHEMA = """
PRAGMA journal_mode=WAL;

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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    hash         TEXT NOT NULL UNIQUE,
    fecha        TEXT NOT NULL,
    mes          TEXT NOT NULL,
    tipo         TEXT,
    categoria    TEXT,
    subcategoria TEXT,
    descripcion  TEXT,
    monto        REAL NOT NULL DEFAULT 0,
    validacion   TEXT,
    source_row   INTEGER
);
CREATE INDEX IF NOT EXISTS ix_exp_fecha ON expenses(fecha);
CREATE INDEX IF NOT EXISTS ix_exp_mes   ON expenses(mes);
CREATE INDEX IF NOT EXISTS ix_exp_cat   ON expenses(categoria);

CREATE TABLE IF NOT EXISTS sales (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    hash        TEXT NOT NULL UNIQUE,
    fecha       TEXT NOT NULL,
    mes         TEXT NOT NULL,
    semana      TEXT NOT NULL,
    categoria   TEXT,
    subcategoria TEXT,
    producto    TEXT,
    cantidad    REAL NOT NULL DEFAULT 0,
    ventas      REAL NOT NULL DEFAULT 0,
    cmv         REAL NOT NULL DEFAULT 0,
    cmv_pct     REAL,
    costo_unit  REAL,
    import_batch TEXT,
    source      TEXT DEFAULT 'sheet',
    source_row  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sales_fecha ON sales(fecha);
CREATE INDEX IF NOT EXISTS ix_sales_semana ON sales(semana);
CREATE INDEX IF NOT EXISTS ix_sales_cat ON sales(categoria);
CREATE INDEX IF NOT EXISTS ix_sales_prod ON sales(producto);

CREATE TABLE IF NOT EXISTS weekly_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    hash          TEXT NOT NULL UNIQUE,
    mes           TEXT,
    semana        TEXT NOT NULL,
    categoria     TEXT NOT NULL,
    cantidad      REAL DEFAULT 0,
    ventas        REAL DEFAULT 0,
    cmv           REAL DEFAULT 0,
    ganancia      REAL,
    cmv_pct       REAL,
    participacion REAL,
    observaciones TEXT,
    source_row    INTEGER
);
CREATE INDEX IF NOT EXISTS ix_wh_semana ON weekly_history(semana);

CREATE TABLE IF NOT EXISTS monthly_history (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    hash      TEXT NOT NULL UNIQUE,
    mes       TEXT NOT NULL,
    ventas    REAL DEFAULT 0,
    cmv       REAL DEFAULT 0,
    bruto     REAL,
    cmv_pct   REAL,
    gastos    REAL DEFAULT 0,
    resultado REAL,
    margen    REAL,
    snapshot  INTEGER DEFAULT 0,
    source_row INTEGER
);

CREATE TABLE IF NOT EXISTS entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL,
    fecha        TEXT NOT NULL,
    mes          TEXT NOT NULL,
    tipo         TEXT,
    categoria    TEXT,
    subcategoria TEXT,
    descripcion  TEXT,
    monto        REAL NOT NULL DEFAULT 0,
    estado       TEXT NOT NULL DEFAULT 'pendiente',
    pushed_at    TEXT,
    error        TEXT
);
CREATE INDEX IF NOT EXISTS ix_entries_estado ON entries(estado);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()


def _migrate(conn: sqlite3.Connection) -> None:
    """Cambios de esquema para bases que ya existían."""
    cols = [r[1] for r in conn.execute("PRAGMA table_info(sales)").fetchall()]
    if "source" not in cols:
        conn.execute("ALTER TABLE sales ADD COLUMN source TEXT DEFAULT 'sheet'")


@contextmanager
def db():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ------------------------------------------------------------------ settings


def get_setting(conn, key: str, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if not row:
        return default
    try:
        return json.loads(row["value"])
    except Exception:
        return row["value"]


def set_setting(conn, key: str, value) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def log_sync(conn, tab: str, status: str, rows: int, message: str, ms: int) -> None:
    conn.execute(
        "INSERT INTO sync_log(ts, tab, status, rows, message, ms) VALUES(?,?,?,?,?,?)",
        (datetime.now().isoformat(timespec="seconds"), tab, status, rows, message, ms),
    )


def last_sync(conn) -> dict | None:
    row = conn.execute("SELECT * FROM sync_log WHERE tab = '_all' ORDER BY id DESC LIMIT 1").fetchone()
    return dict(row) if row else None


def counts(conn) -> dict:
    out = {}
    for table in ("expenses", "sales", "weekly_history", "monthly_history", "entries"):
        out[table] = conn.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"]
    return out
