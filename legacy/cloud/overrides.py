"""Costos de respaldo (overrides) para productos que Fudo no costea.

Origen: la planilla, semana 2026-10-08..2026-10-14 (S2), donde cada producto tiene
cantidad, ventas y CMV. El costo unitario sale de CMV / cantidad.

Uso:
    python -m cloud.overrides                 # informe, no escribe nada
    python -m cloud.overrides --apply         # aplica solo los casos claros
    python -m cloud.overrides --apply --all   # aplica también los dudosos (no recomendado)
"""

from __future__ import annotations

import argparse
import sqlite3
import unicodedata
from datetime import date
from pathlib import Path

from . import db

DELIVERY_CATEGORIES = {"pedidos ya", "productos", "delivery", "apps", "uber eats", "rappi"}
DELIVERY_WORDS = ("pedidos ya", "pedidosya", "uber", "delivery", "envio", "rappi", "mercado libre")


def norm(name: str) -> str:
    text = unicodedata.normalize("NFKD", (name or "").strip().lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return " ".join(text.split())


def is_delivery(name: str, category: str) -> bool:
    n, c = norm(name), norm(category)
    return c in DELIVERY_CATEGORIES or any(w in n for w in DELIVERY_WORDS)


def load_s2(sqlite_path: Path, d0: str, d1: str) -> list[dict]:
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT producto, categoria, SUM(cantidad) q, SUM(ventas) v, SUM(cmv) c
        FROM sales
        WHERE fecha BETWEEN ? AND ?
        GROUP BY producto, categoria
        """,
        (d0, d1),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        q = float(r["q"] or 0)
        v = float(r["v"] or 0)
        c = float(r["c"] or 0)
        if not (r["producto"] or "").strip() or q <= 0:
            continue
        out.append(
            {
                "name": r["producto"].strip(),
                "category": (r["categoria"] or "").strip(),
                "qty": q,
                "ventas": v,
                "cmv": c,
                "unit_cost": (c / q) if q else None,
                "unit_price": (v / q) if q else None,
            }
        )
    return out


def build(conn, venue_id: int, s2: list[dict]) -> dict:
    prods = conn.execute(
        """
        SELECT p.id, p.name, p.cost, c.name AS category
        FROM products p LEFT JOIN product_categories c ON c.id = p.category_id
        WHERE p.venue_id = %s
        """,
        (venue_id,),
    ).fetchall()
    by_name = {norm(p["name"]): p for p in prods}

    clear, doubtful, unmatched, excluded = [], [], [], []
    con_costo = 0
    for row in s2:
        if is_delivery(row["name"], row["category"]):
            excluded.append(row)
            continue
        p = by_name.get(norm(row["name"]))
        if not p:
            unmatched.append(row)
            continue
        if p["cost"] is not None:
            con_costo += 1
            continue
        flags = []
        if row["qty"] < 3:
            flags.append("pocas unidades")
        if row["unit_cost"] is None or row["unit_cost"] <= 0:
            flags.append("costo cero")
        elif row["unit_price"] and row["unit_cost"] > row["unit_price"]:
            flags.append("costo > precio")
        item = dict(row)
        item["product_id"] = p["id"]
        item["product_name"] = p["name"]
        item["category_db"] = p["category"]
        item["flags"] = flags
        (doubtful if flags else clear).append(item)
    return {
        "clear": clear,
        "doubtful": doubtful,
        "unmatched": unmatched,
        "excluded": excluded,
        "con_costo": con_costo,
    }


def apply_overrides(conn, venue_id: int, rows: list[dict]) -> int:
    n = 0
    for r in rows:
        conn.execute(
            """
            INSERT INTO product_cost_overrides (venue_id, product_id, cost, source, note)
            VALUES (%s, %s, %s, 'sheet_s2', %s)
            ON CONFLICT (venue_id, product_id) DO UPDATE
              SET cost = EXCLUDED.cost,
                  source = EXCLUDED.source,
                  note = EXCLUDED.note,
                  updated_at = now()
            """,
            (
                venue_id,
                r["product_id"],
                round(r["unit_cost"], 4),
                f"planilla S2 · {r['qty']:.0f} u. · {r['category'] or 'sin categoría'}",
            ),
        )
        n += 1
    conn.execute(
        """
        UPDATE sale_items si
           SET line_cost = ROUND(si.quantity * o.cost, 2),
               unit_cost = o.cost
          FROM product_cost_overrides o, sales s
         WHERE si.sale_id = s.id
           AND o.venue_id = s.venue_id
           AND si.product_id = o.product_id
           AND s.venue_id = %s
           AND s.source = 'fudo'
        """,
        (venue_id,),
    )
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description="Costos de respaldo desde la planilla S2")
    ap.add_argument("--sqlite", default="data/gestion.db")
    ap.add_argument("--from", dest="d0", default="2026-10-08")
    ap.add_argument("--to", dest="d1", default="2026-10-14")
    ap.add_argument("--venue", default="bois")
    ap.add_argument("--env", default=".env")
    ap.add_argument("--apply", action="store_true", help="escribe en la base")
    ap.add_argument("--all", action="store_true", help="aplica también los dudosos")
    args = ap.parse_args()

    db.load_env(args.env)
    s2 = load_s2(Path(args.sqlite), args.d0, args.d1)
    with db.connect(direct=True) as pg:
        db.apply_schema(pg)
        vid = db.ensure_venue(pg, args.venue)
        res = build(pg, vid, s2)

        print(f"Productos en la planilla S2: {len(s2)}")
        print(f"  ya tienen costo en Fudo:   {res['con_costo']}")
        print(f"  candidatos claros:         {len(res['clear'])}")
        print(f"  candidatos dudosos:        {len(res['doubtful'])}")
        print(f"  no están en la base:       {len(res['unmatched'])}")
        print(f"  excluidos (delivery):      {len(res['excluded'])}\n")

        def show(title: str, rows: list[dict], limit: int = 30) -> None:
            if not rows:
                return
            print(title)
            print(f"  {'producto':32} {'u.':>6} {'costo u.':>10} {'precio u.':>10}  {'flags'}")
            for r in sorted(rows, key=lambda x: -x["ventas"])[:limit]:
                flags = ", ".join(r.get("flags") or [])
                print(
                    f"  {r['name'][:32]:32} {r['qty']:>6.0f} {r['unit_cost'] or 0:>10,.0f} "
                    f"{r['unit_price'] or 0:>10,.0f}  {flags}"
                )
            if len(rows) > limit:
                print(f"  … y {len(rows) - limit} más")
            print()

        show("CLAROS (se aplicarían)", res["clear"])
        show("DUDOSOS (consultar)", res["doubtful"])
        show("NO ESTÁN EN LA BASE (no se tocan)", res["unmatched"], 10)
        show("EXCLUIDOS: delivery (no se costean)", res["excluded"], 10)

        if args.apply:
            rows = res["clear"] + (res["doubtful"] if args.all else [])
            n = apply_overrides(pg, vid, rows)
            print(f"Aplicados {n} overrides.")
            from . import recompute

            print("Agregados:", recompute.recompute(pg, vid))
        else:
            print("Informe solamente. Para aplicar los claros: --apply")


if __name__ == "__main__":
    main()
