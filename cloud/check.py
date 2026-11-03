"""Chequeo rápido de la base: conteos, semanas y meses."""

from __future__ import annotations

import argparse

from . import db


def main() -> None:
    ap = argparse.ArgumentParser(description="Estado de la base Postgres")
    ap.add_argument("--venue", default="bois")
    ap.add_argument("--env", default=".env")
    args = ap.parse_args()
    db.load_env(args.env)

    with db.connect(direct=True) as pg:
        venue = pg.execute("SELECT id, name FROM venues WHERE slug = %s", (args.venue,)).fetchone()
        if not venue:
            raise SystemExit("No existe el local. Corré la migración primero.")
        vid = venue["id"]
        print(f"Local: {venue['name']} (id {vid})\n")

        counts = {
            "ventas": "SELECT COUNT(*) n FROM sales WHERE venue_id = %s",
            "ítems de venta": "SELECT COUNT(*) n FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.venue_id = %s",
            "gastos": "SELECT COUNT(*) n FROM expenses WHERE venue_id = %s",
            "ítems de gasto": "SELECT COUNT(*) n FROM expense_items ei JOIN expenses e ON e.id = ei.expense_id WHERE e.venue_id = %s",
            "productos": "SELECT COUNT(*) n FROM products WHERE venue_id = %s",
            "categorías": "SELECT COUNT(*) n FROM product_categories WHERE venue_id = %s",
            "proveedores": "SELECT COUNT(*) n FROM providers WHERE venue_id = %s",
            "insumos": "SELECT COUNT(*) n FROM ingredients WHERE venue_id = %s",
            "semanas histórico": "SELECT COUNT(*) n FROM weekly_history WHERE venue_id = %s",
            "cierres mensuales": "SELECT COUNT(*) n FROM monthly_closes WHERE venue_id = %s",
        }
        for label, sql in counts.items():
            n = pg.execute(sql, (vid,)).fetchone()["n"]
            print(f"  {label:20} {n:>8}")

        print("\nÚltimas semanas (ventas / CMV):")
        rows = pg.execute(
            """
            SELECT week_key, SUM(ventas) AS ventas, SUM(cmv) AS cmv
            FROM weekly_category_stats
            WHERE venue_id = %s
            GROUP BY week_key
            ORDER BY week_key DESC
            LIMIT 6
            """,
            (vid,),
        ).fetchall()
        for r in rows:
            cmv_pct = (r["cmv"] / r["ventas"] * 100) if r["ventas"] else 0
            print(f"  {r['week_key']}  ${r['ventas']:>14,.0f}  CMV {cmv_pct:5.1f}%")

        print("\nMeses (ventas / gastos):")
        rows = pg.execute(
            """
            SELECT COALESCE(s.month_key, e.month_key) AS month_key,
                   COALESCE(s.ventas, 0) AS ventas,
                   COALESCE(e.gastos, 0) AS gastos
            FROM v_monthly_sales s
            FULL JOIN v_monthly_expenses e ON e.venue_id = s.venue_id AND e.month_key = s.month_key
            WHERE COALESCE(s.venue_id, e.venue_id) = %s
            ORDER BY 1 DESC
            LIMIT 8
            """,
            (vid,),
        ).fetchall()
        for r in rows:
            print(f"  {r['month_key']}  ventas ${r['ventas']:>14,.0f}  gastos ${r['gastos']:>14,.0f}")


if __name__ == "__main__":
    main()
