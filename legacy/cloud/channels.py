"""Clasificación de ventas por canal: salón, take away y delivery (apps).

Fudo manda `saleType` (EAT-IN / TAKEAWAY / DELIVERY) y, en delivery, `orders.origin`
(pedidos_ya, uber_eats, …). Las ventas viejas importadas de la planilla se clasifican
por la categoría del producto (Pedidos Ya / Productos).

Uso:
    python -m cloud.channels            # reclasifica y muestra el reporte
    python -m cloud.channels --report   # solo muestra
"""

from __future__ import annotations

import argparse

from . import db

DELIVERY_CATEGORIES = ("pedidos ya", "productos", "delivery")


def backfill(conn, venue_id: int) -> dict:
    conn.execute(
        """
        UPDATE sales
           SET channel = CASE
                 WHEN UPPER(COALESCE(sale_type, '')) = 'DELIVERY' THEN 'delivery'
                 WHEN UPPER(COALESCE(sale_type, '')) = 'TAKEAWAY' THEN 'takeaway'
                 ELSE 'salon'
               END,
               channel_detail = LOWER(COALESCE(sale_type, 'salon'))
         WHERE venue_id = %s AND source = 'fudo'
        """,
        (venue_id,),
    )
    conn.execute(
        """
        UPDATE sales s
           SET channel = 'delivery', channel_detail = 'pedidos_ya'
         WHERE s.venue_id = %s
           AND s.source = 'sheet'
           AND EXISTS (
               SELECT 1
                 FROM sale_items si
                 JOIN products p ON p.id = si.product_id
                 JOIN product_categories c ON c.id = p.category_id
                WHERE si.sale_id = s.id
                  AND LOWER(c.name) IN ('pedidos ya', 'productos', 'delivery')
           )
        """,
        (venue_id,),
    )
    conn.execute(
        """
        UPDATE sales
           SET channel = 'salon', channel_detail = 'planilla'
         WHERE venue_id = %s AND source = 'sheet' AND channel <> 'delivery'
        """,
        (venue_id,),
    )
    rows = conn.execute(
        "SELECT channel, COUNT(*) n, SUM(total) t FROM sales WHERE venue_id = %s GROUP BY 1 ORDER BY 1",
        (venue_id,),
    ).fetchall()
    return {r["channel"]: {"n": r["n"], "total": float(r["t"] or 0)} for r in rows}


def report(conn, venue_id: int) -> None:
    rows = conn.execute(
        "SELECT week_key, channel, ventas, cmv FROM v_weekly_channel WHERE venue_id = %s ORDER BY 1, 2",
        (venue_id,),
    ).fetchall()
    weeks: dict[str, dict] = {}
    for r in rows:
        weeks.setdefault(r["week_key"], {})[r["channel"]] = r

    print(f"{'semana':12} {'menú ventas':>14} {'CMV menú':>9} {'delivery':>13} {'% del.':>8}")
    for wk in sorted(weeks):
        canales = weeks[wk]
        menu_v = sum(float(canales[c]["ventas"]) for c in ("salon", "takeaway") if c in canales)
        menu_c = sum(float(canales[c]["cmv"]) for c in ("salon", "takeaway") if c in canales)
        del_v = float(canales["delivery"]["ventas"]) if "delivery" in canales else 0.0
        total = menu_v + del_v
        cmv_pct = (menu_c / menu_v * 100) if menu_v else 0
        share = (del_v / total * 100) if total else 0
        print(f"{wk:12} {menu_v:>14,.0f} {cmv_pct:>8.1f}% {del_v:>13,.0f} {share:>7.1f}%")

    print(f"\n{'mes':9} {'menú ventas':>14} {'CMV menú':>9} {'delivery':>13} {'% del.':>8}")
    rows = conn.execute(
        "SELECT month_key, channel, ventas, cmv FROM v_monthly_channel WHERE venue_id = %s ORDER BY 1, 2",
        (venue_id,),
    ).fetchall()
    months: dict[str, dict] = {}
    for r in rows:
        months.setdefault(r["month_key"], {})[r["channel"]] = r
    for mk in sorted(months):
        canales = months[mk]
        menu_v = sum(float(canales[c]["ventas"]) for c in ("salon", "takeaway") if c in canales)
        menu_c = sum(float(canales[c]["cmv"]) for c in ("salon", "takeaway") if c in canales)
        del_v = float(canales["delivery"]["ventas"]) if "delivery" in canales else 0.0
        total = menu_v + del_v
        cmv_pct = (menu_c / menu_v * 100) if menu_v else 0
        share = (del_v / total * 100) if total else 0
        print(f"{mk:9} {menu_v:>14,.0f} {cmv_pct:>8.1f}% {del_v:>13,.0f} {share:>7.1f}%")


def main() -> None:
    ap = argparse.ArgumentParser(description="Canales de venta")
    ap.add_argument("--venue", default="bois")
    ap.add_argument("--env", default=".env")
    ap.add_argument("--report", action="store_true", help="solo reporte, sin reclasificar")
    args = ap.parse_args()
    db.load_env(args.env)
    with db.connect(direct=True) as pg:
        db.apply_schema(pg)
        vid = db.ensure_venue(pg, args.venue)
        if not args.report:
            print("Reclasificando…", backfill(pg, vid))
        report(pg, vid)


if __name__ == "__main__":
    main()
