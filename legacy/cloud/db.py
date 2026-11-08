"""Conexión a Postgres (Neon) y utilidades comunes."""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parent.parent
SCHEMA_PATH = ROOT / "docs" / "schema-postgres.sql"


def load_env(path: str | Path = ".env") -> None:
    """Carga variables desde un .env sin dependencias externas."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def database_url(direct: bool = False) -> str:
    if direct:
        url = (os.environ.get("DATABASE_URL_DIRECT") or "").strip()
        if url:
            return url
    url = os.environ.get("DATABASE_URL", "").strip()
    if not url:
        raise SystemExit(
            "Falta DATABASE_URL.\n"
            "Copiá .env.example a .env, pegá la cadena de conexión de Neon y volvé a correr.\n"
            "Si vas a correr migraciones, agregá también DATABASE_URL_DIRECT (la cadena sin -pooler)."
        )
    return url


@contextmanager
def connect(direct: bool = False):
    # prepare_threshold=None: necesario con el pooler de Neon (PgBouncer, modo transacción)
    with psycopg.connect(
        database_url(direct), row_factory=dict_row, connect_timeout=20, prepare_threshold=None
    ) as conn:
        yield conn


def split_sql(sql: str) -> list[str]:
    """Parte un script en sentencias (nuestro esquema no tiene bloques con ; internos)."""
    stmts: list[str] = []
    buf: list[str] = []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        buf.append(line)
        if line.rstrip().endswith(";"):
            stmt = "\n".join(buf).strip()
            if stmt:
                stmts.append(stmt)
            buf = []
    rest = "\n".join(buf).strip()
    if rest:
        stmts.append(rest)
    return stmts


def apply_schema(conn) -> int:
    sql = SCHEMA_PATH.read_text(encoding="utf-8")
    stmts = split_sql(sql)
    with conn.cursor() as cur:
        for stmt in stmts:
            cur.execute(stmt)
    return len(stmts)


def ensure_venue(conn, slug: str = "bois") -> int:
    row = conn.execute("SELECT id FROM venues WHERE slug = %s", (slug,)).fetchone()
    if row:
        return row["id"]
    row = conn.execute(
        "INSERT INTO venues (name, slug) VALUES (%s, %s) RETURNING id",
        (slug.capitalize(), slug),
    ).fetchone()
    return row["id"]


def upsert_category(conn, venue_id: int, name: str, fudo_id: str | None = None) -> int:
    row = conn.execute(
        """
        INSERT INTO product_categories (venue_id, fudo_id, name)
        VALUES (%s, %s, %s)
        ON CONFLICT (venue_id, name) DO UPDATE
          SET fudo_id = COALESCE(product_categories.fudo_id, EXCLUDED.fudo_id)
        RETURNING id
        """,
        (venue_id, fudo_id, name.strip() or "Sin categoría"),
    ).fetchone()
    return row["id"]


def upsert_product(
    conn,
    venue_id: int,
    name: str,
    category_id: int | None,
    fudo_id: str | None = None,
    cost: float | None = None,
    price: float | None = None,
) -> int:
    row = conn.execute(
        """
        INSERT INTO products (venue_id, fudo_id, name, category_id, cost, price)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (venue_id, name) DO UPDATE
          SET fudo_id = COALESCE(products.fudo_id, EXCLUDED.fudo_id),
              category_id = COALESCE(EXCLUDED.category_id, products.category_id),
              cost = COALESCE(EXCLUDED.cost, products.cost),
              price = COALESCE(EXCLUDED.price, products.price),
              updated_at = now()
        RETURNING id
        """,
        (venue_id, fudo_id, name.strip() or "Sin producto", category_id, cost, price),
    ).fetchone()
    return row["id"]


def upsert_provider(conn, venue_id: int, name: str, fudo_id: str | None = None) -> int:
    row = conn.execute(
        """
        INSERT INTO providers (venue_id, fudo_id, name)
        VALUES (%s, %s, %s)
        ON CONFLICT (venue_id, name) DO UPDATE
          SET fudo_id = COALESCE(providers.fudo_id, EXCLUDED.fudo_id)
        RETURNING id
        """,
        (venue_id, fudo_id, (name or "").strip() or "Sin proveedor"),
    ).fetchone()
    return row["id"]


def upsert_expense_category(conn, venue_id: int, name: str, fudo_id: str | None = None) -> int:
    row = conn.execute(
        """
        INSERT INTO expense_categories (venue_id, fudo_id, name)
        VALUES (%s, %s, %s)
        ON CONFLICT (venue_id, name) DO UPDATE
          SET fudo_id = COALESCE(expense_categories.fudo_id, EXCLUDED.fudo_id)
        RETURNING id
        """,
        (venue_id, fudo_id, (name or "").strip() or "Sin categoría"),
    ).fetchone()
    return row["id"]


def upsert_ingredient(conn, venue_id: int, name: str, unit: str | None, cost: float | None, fudo_id: str | None = None) -> int:
    row = conn.execute(
        """
        INSERT INTO ingredients (venue_id, fudo_id, name, unit, cost)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (venue_id, name) DO UPDATE
          SET fudo_id = COALESCE(ingredients.fudo_id, EXCLUDED.fudo_id),
              unit = COALESCE(EXCLUDED.unit, ingredients.unit),
              cost = COALESCE(EXCLUDED.cost, ingredients.cost),
              updated_at = now()
        RETURNING id
        """,
        (venue_id, fudo_id, (name or "").strip() or "Sin insumo", unit, cost),
    ).fetchone()
    return row["id"]
