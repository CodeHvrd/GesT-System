"""Recalcula los agregados semanales y diarios a partir de las ventas.

Uso:
    python -m cloud.recompute
"""

from __future__ import annotations

import argparse

from . import db


def recompute(pg, venue_id: int) -> dict:
    pg.execute("DELETE FROM weekly_category_stats WHERE venue_id = %s", (venue_id,))
    pg.execute(
        """
        INSERT INTO weekly_category_stats (venue_id, week_key, category_id, cantidad, ventas, cmv)
        SELECT s.venue_id,
               to_char(s.business_date, 'YYYY-MM') || '-S' ||
                 (((extract(day from s.business_date)::int - 1) / 7) + 1)::text AS week_key,
               COALESCE(p.category_id, 0) AS category_id,
               SUM(si.quantity),
               SUM(si.line_total),
               SUM(si.line_cost)
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.venue_id = %s
          AND s.state = 'CLOSED'
          AND si.canceled = false
        GROUP BY 1, 2, 3
        """,
        (venue_id,),
    )
    pg.execute("DELETE FROM daily_category_stats WHERE venue_id = %s", (venue_id,))
    pg.execute(
        """
        INSERT INTO daily_category_stats (venue_id, business_date, category_id, cantidad, ventas, cmv)
        SELECT s.venue_id,
               s.business_date,
               COALESCE(p.category_id, 0),
               SUM(si.quantity),
               SUM(si.line_total),
               SUM(si.line_cost)
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        WHERE s.venue_id = %s
          AND s.state = 'CLOSED'
          AND si.canceled = false
        GROUP BY 1, 2, 3
        """,
        (venue_id,),
    )
    weeks = pg.execute(
        "SELECT COUNT(DISTINCT week_key) AS n FROM weekly_category_stats WHERE venue_id = %s",
        (venue_id,),
    ).fetchone()["n"]
    return {"semanas": weeks}


def main() -> None:
    ap = argparse.ArgumentParser(description="Recalcula agregados")
    ap.add_argument("--venue", default="bois")
    ap.add_argument("--env", default=".env")
    args = ap.parse_args()
    db.load_env(args.env)
    with db.connect(direct=True) as pg:
        db.apply_schema(pg)
        venue_id = db.ensure_venue(pg, args.venue)
        print(recompute(pg, venue_id))


if __name__ == "__main__":
    main()
