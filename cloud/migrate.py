"""Migra la base local (SQLite) a Postgres.

Uso:
    python -m cloud.migrate --sqlite data/gestion.db

Es idempotente: se puede correr varias veces y no duplica (unique por external_id).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from datetime import date
from pathlib import Path

from psycopg.types.json import Jsonb

from . import db


def _connect_sqlite(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def _hash(*parts) -> str:
    return hashlib.sha1("|".join("" if p is None else str(p) for p in parts).encode("utf-8")).hexdigest()


def migrate(sqlite_path: Path, slug: str = "bois") -> dict:
    src = _connect_sqlite(sqlite_path)
    stats = {"expenses": 0, "sales": 0, "sale_items": 0, "weekly": 0, "closes": 0}
    with db.connect(direct=True) as pg:
        db.apply_schema(pg)
        venue_id = db.ensure_venue(pg, slug)

        # ---------------------------------------------------------- gastos
        rows = src.execute("SELECT * FROM expenses ORDER BY fecha, id").fetchall()
        providers: dict[str, int] = {}
        categories: dict[str, int] = {}
        for r in rows:
            cat_name = (r["categoria"] or "Sin categoría").strip()
            if cat_name not in categories:
                categories[cat_name] = db.upsert_expense_category(pg, venue_id, cat_name)
            prov_name = (r["descripcion"] or "").strip()
            prov_id = None
            if prov_name:
                if prov_name not in providers:
                    providers[prov_name] = db.upsert_provider(pg, venue_id, prov_name)
                prov_id = providers[prov_name]
            payload = {k: r[k] for k in r.keys()}
            pg.execute(
                """
                INSERT INTO expenses (venue_id, source, external_id, expense_date, amount,
                                      description, provider_id, category_id, category_name, status, payload)
                VALUES (%s, 'sheet', %s, %s, %s, %s, %s, %s, %s, 'cargado', %s)
                ON CONFLICT (venue_id, source, external_id) DO UPDATE
                  SET expense_date = EXCLUDED.expense_date,
                      amount = EXCLUDED.amount,
                      description = EXCLUDED.description,
                      provider_id = EXCLUDED.provider_id,
                      category_id = EXCLUDED.category_id,
                      category_name = EXCLUDED.category_name,
                      payload = EXCLUDED.payload
                """,
                (
                    venue_id,
                    r["hash"],
                    r["fecha"],
                    r["monto"],
                    r["descripcion"],
                    prov_id,
                    categories[cat_name],
                    cat_name,
                    Jsonb(payload),
                ),
            )
            stats["expenses"] += 1

        # ---------------------------------------------------------- ventas
        cols = {row["name"] for row in src.execute("PRAGMA table_info(sales)")}
        has_source = "source" in cols
        sales_rows = src.execute("SELECT * FROM sales ORDER BY fecha, categoria, producto").fetchall()
        products: dict[str, int] = {}
        pcats: dict[str, int] = {}
        for r in sales_rows:
            cat_name = (r["categoria"] or "Sin categoría").strip()
            prod_name = (r["producto"] or "Sin producto").strip()
            if cat_name not in pcats:
                pcats[cat_name] = db.upsert_category(pg, venue_id, cat_name)
            pkey = f"{cat_name}|{prod_name}"
            if pkey not in products:
                products[pkey] = db.upsert_product(pg, venue_id, prod_name, pcats[cat_name])

            source = (r["source"] if has_source and r["source"] else "sheet")
            external_id = r["hash"] or _hash(r["fecha"], r["categoria"], r["producto"])
            sale = pg.execute(
                """
                INSERT INTO sales (venue_id, source, external_id, business_date, state, total, payload)
                VALUES (%s, %s, %s, %s, 'CLOSED', %s, %s)
                ON CONFLICT (venue_id, source, external_id) DO UPDATE
                  SET business_date = EXCLUDED.business_date,
                      total = EXCLUDED.total,
                      payload = EXCLUDED.payload
                RETURNING id
                """,
                (
                    venue_id,
                    source,
                    external_id,
                    r["fecha"],
                    r["ventas"],
                    Jsonb({k: r[k] for k in r.keys()}),
                ),
            ).fetchone()
            sale_id = sale["id"]
            pg.execute("DELETE FROM sale_items WHERE sale_id = %s", (sale_id,))
            qty = r["cantidad"] or 0
            pg.execute(
                """
                INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, line_total,
                                        unit_cost, line_cost, canceled)
                VALUES (%s, %s, %s, %s, %s, %s, %s, false)
                """,
                (
                    sale_id,
                    products[pkey],
                    qty,
                    (r["ventas"] / qty) if qty else None,
                    r["ventas"] or 0,
                    (r["cmv"] / qty) if qty else None,
                    r["cmv"] or 0,
                ),
            )
            stats["sales"] += 1
            stats["sale_items"] += 1

        # ---------------------------------------------------------- histórico semanal
        for r in src.execute("SELECT * FROM weekly_history").fetchall():
            pg.execute(
                """
                INSERT INTO weekly_history (venue_id, week_key, category_name, cantidad, ventas, cmv,
                                            ganancia, cmv_pct, participacion, observaciones)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (venue_id, week_key, category_name) DO UPDATE
                  SET cantidad = EXCLUDED.cantidad,
                      ventas = EXCLUDED.ventas,
                      cmv = EXCLUDED.cmv,
                      ganancia = EXCLUDED.ganancia,
                      cmv_pct = EXCLUDED.cmv_pct,
                      participacion = EXCLUDED.participacion,
                      observaciones = EXCLUDED.observaciones
                """,
                (
                    venue_id,
                    r["semana"],
                    r["categoria"],
                    r["cantidad"] or 0,
                    r["ventas"] or 0,
                    r["cmv"] or 0,
                    r["ganancia"],
                    r["cmv_pct"],
                    r["participacion"],
                    r["observaciones"],
                ),
            )
            stats["weekly"] += 1

        # ---------------------------------------------------------- cierres mensuales
        for r in src.execute("SELECT * FROM monthly_history WHERE snapshot = 0").fetchall():
            pg.execute(
                """
                INSERT INTO monthly_closes (venue_id, month_key, ventas, cmv, resultado_bruto,
                                            gastos, resultado_final, margen_pct, source)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'sheet')
                ON CONFLICT (venue_id, month_key) DO UPDATE
                  SET ventas = EXCLUDED.ventas,
                      cmv = EXCLUDED.cmv,
                      resultado_bruto = EXCLUDED.resultado_bruto,
                      gastos = EXCLUDED.gastos,
                      resultado_final = EXCLUDED.resultado_final,
                      margen_pct = EXCLUDED.margen_pct,
                      updated_at = now()
                """,
                (
                    venue_id,
                    r["mes"],
                    r["ventas"] or 0,
                    r["cmv"] or 0,
                    r["bruto"] or 0,
                    r["gastos"] or 0,
                    r["resultado"] or 0,
                    r["margen"],
                ),
            )
            stats["closes"] += 1

    src.close()
    return stats


def main() -> None:
    ap = argparse.ArgumentParser(description="Migra la base SQLite local a Postgres")
    ap.add_argument("--sqlite", default="data/gestion.db")
    ap.add_argument("--venue", default="bois")
    ap.add_argument("--env", default=".env", help="archivo .env con DATABASE_URL")
    args = ap.parse_args()

    env_path = Path(args.env)
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                import os

                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

    path = Path(args.sqlite)
    if not path.exists():
        raise SystemExit(f"No encuentro {path}")
    print(f"Migrando {path} → Postgres…")
    stats = migrate(path, args.venue)
    print(json.dumps(stats, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
