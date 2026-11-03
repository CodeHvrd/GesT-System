"""Ingesta de Fudo directo a Postgres (ventas, gastos e insumos).

Uso:
    python -m cloud.ingest --what all --from 2026-10-01 --to 2026-10-24
    python -m cloud.ingest --what sales --from 2026-10-15 --to 2026-10-21

Es idempotente: cada venta/gasto se identifica por su id de Fudo y se actualiza,
nunca se duplica. Cada corrida queda registrada en `sync_runs`.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from psycopg.types.json import Jsonb

from . import db

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.fudo import FudoClient, FudoError  # noqa: E402

PAGE_SIZE = 500
MAX_PAGES = 60
TZ_OFFSET = timedelta(hours=-3)


# ------------------------------------------------------------------ helpers


def load_env(path: Path = Path(".env")) -> None:
    db.load_env(path)


def local_date(value) -> date | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return (dt + TZ_OFFSET).date()


def rel_id(obj: dict, name: str):
    rel = (obj.get("relationships") or {}).get(name) or {}
    data = rel.get("data")
    if isinstance(data, list):
        return [str(d.get("id")) for d in data if isinstance(d, dict)]
    if isinstance(data, dict):
        return str(data.get("id"))
    return None


def index_included(rows) -> dict[tuple[str, str], dict]:
    return {(str(r.get("type")), str(r.get("id"))): r for r in (rows or [])}


def _close(a: float, b: float, tol: float = 0.02) -> bool:
    if not b:
        return abs(a) < 1
    return abs(a - b) / abs(b) <= tol


def _mode(items: list[dict], total: float) -> str:
    """¿El price de los ítems es por línea o por unidad?"""
    def qty(i: dict) -> float:
        return float(i.get("quantity", i.get("qty", 0)) or 0)

    line = sum(float(i.get("price") or 0) for i in items)
    unit = sum(float(i.get("price") or 0) * qty(i) for i in items)
    if not items:
        return "linea"
    if _close(line, total) or not _close(unit, total):
        return "linea"
    return "unidad"


def client_from_env() -> FudoClient:
    cfg = {
        "fudo": {
            "api_key": os.environ.get("FUDO_API_KEY", ""),
            "api_secret": os.environ.get("FUDO_API_SECRET", ""),
        }
    }
    client = FudoClient(cfg)
    if not client.configured:
        raise SystemExit("Faltan FUDO_API_KEY y FUDO_API_SECRET (ponelas en .env).")
    return client


# ------------------------------------------------------------------ sync runs


def start_run(pg, venue_id: int, kind: str, d0: date, d1: date) -> int:
    row = pg.execute(
        """
        INSERT INTO sync_runs (venue_id, kind, range_start, range_end, status)
        VALUES (%s, %s, %s, %s, 'running') RETURNING id
        """,
        (venue_id, kind, d0, d1),
    ).fetchone()
    return row["id"]


def finish_run(pg, run_id: int, status: str, read: int, written: int, message: str = "") -> None:
    pg.execute(
        """
        UPDATE sync_runs
           SET status = %s, rows_read = %s, rows_written = %s, message = %s, finished_at = now()
         WHERE id = %s
        """,
        (status, read, written, message[:1000], run_id),
    )


# ------------------------------------------------------------------ ventas


def fetch_product_catalog(client: FudoClient) -> dict[str, dict]:
    """Catálogo de productos con costo: directo o calculado desde la receta.

    Fudo no devuelve el costo en los ítems de venta. El costo por producto sale de
    `cost` (si está cargado) o de la receta: proporción × costo del insumo × merma.
    """
    out: dict[str, dict] = {}
    page = 1
    while page <= 10:
        data = client.get(
            "/products",
            {
                "page[size]": 500,
                "page[number]": page,
                "include": "proportions.ingredient",
                "fields[product]": "name,cost,price,active,proportions",
                "fields[proportion]": "amount,appliedShrinkage,ingredient",
            },
        )
        rows = data.get("data") or []
        inc = index_included(data.get("included"))
        for p in rows:
            a = p.get("attributes") or {}
            direct = a.get("cost")
            computed = None
            refs = ((p.get("relationships") or {}).get("proportions") or {}).get("data") or []
            if refs:
                total = 0.0
                found = False
                for ref in refs:
                    pr = inc.get(("Proportion", str(ref.get("id"))))
                    if not pr:
                        continue
                    pa = pr.get("attributes") or {}
                    ing_ref = ((pr.get("relationships") or {}).get("ingredient") or {}).get("data") or {}
                    ing = inc.get(("Ingredient", str(ing_ref.get("id"))))
                    ia = (ing or {}).get("attributes") or {}
                    if ia.get("cost") is None:
                        continue
                    found = True
                    shrink = float(pa.get("appliedShrinkage") or 0)
                    total += float(pa.get("amount") or 0) * (1 + shrink / 100) * float(ia["cost"])
                if found:
                    computed = round(total, 4)
            cost = float(direct) if direct is not None else computed
            out[str(p.get("id"))] = {
                "name": a.get("name") or "",
                "cost": cost,
                "price": float(a["price"]) if a.get("price") is not None else None,
            }
        if len(rows) < 500:
            break
        page += 1
    return out


def sync_sales(pg, venue_id: int, client: FudoClient, d0: date, d1: date) -> dict:
    run_id = start_run(pg, venue_id, "fudo_sales", d0, d1)
    # Argentina es UTC-3: el día local empieza a las 03:00Z
    start = f"{d0.isoformat()}T03:00:00Z"
    end = f"{(d1 + timedelta(days=1)).isoformat()}T03:00:00Z"
    params = {
        "filter[closedAt]": f"and(gte.{start},lt.{end})",
        "include": "items.product,items.product.productCategory,orders",
        "page[size]": PAGE_SIZE,
        "sort": "id",
        "fields[sale]": "closedAt,createdAt,total,saleType,saleState,items,orders",
        "fields[product]": "name,productCategory",
        "fields[productCategory]": "name",
        "fields[order]": "origin",
    }
    catalog = fetch_product_catalog(client)
    read = written = 0
    page = 1
    try:
        while page <= MAX_PAGES:
            q = dict(params)
            q["page[number]"] = page
            data = client.get("/sales", q)
            sales = data.get("data") or []
            inc = index_included(data.get("included"))
            for sale in sales:
                attrs = sale.get("attributes") or {}
                state = str(attrs.get("saleState") or "")
                bdate = local_date(attrs.get("closedAt") or attrs.get("createdAt"))
                if not bdate:
                    continue
                read += 1
                if state.upper() != "CLOSED":
                    continue
                total = float(attrs.get("total") or 0)
                stype = str(attrs.get("saleType") or "").upper()
                origin = ""
                for oid in rel_id(sale, "orders") or []:
                    order = inc.get(("Order", str(oid)))
                    origin = ((order or {}).get("attributes") or {}).get("origin") or origin
                if stype == "DELIVERY" or origin:
                    channel, channel_detail = "delivery", (origin or "delivery")
                elif stype == "TAKEAWAY":
                    channel, channel_detail = "takeaway", "takeaway"
                else:
                    channel, channel_detail = "salon", "salon"
                item_ids = rel_id(sale, "items") or []
                parsed = []
                for iid in item_ids:
                    item = inc.get(("Item", str(iid)))
                    if not item:
                        continue
                    ia = item.get("attributes") or {}
                    if ia.get("canceled"):
                        continue
                    qty = float(ia.get("quantity") or 0)
                    price = float(ia.get("price") or 0)
                    pid = rel_id(item, "product")
                    prod = inc.get(("Product", str(pid))) if pid else None
                    entry = catalog.get(str(pid)) if pid else None
                    pname = (entry or {}).get("name") or ((prod or {}).get("attributes") or {}).get("name") or "Sin producto"
                    cid = rel_id(prod, "productCategory") if prod else None
                    cat = inc.get(("ProductCategory", str(cid))) if cid else None
                    cname = ((cat or {}).get("attributes") or {}).get("name") or "Sin categoría"
                    unit_cost = float(ia.get("cost") or 0) or float((entry or {}).get("cost") or 0)
                    parsed.append(
                        {
                            "qty": qty,
                            "price": price,
                            "cost": unit_cost,
                            "product": pname,
                            "category": cname,
                            "catalog_cost": (entry or {}).get("cost"),
                            "catalog_price": (entry or {}).get("price"),
                        }
                    )
                mode = _mode(parsed, total)
                sale_row = pg.execute(
                    """
                    INSERT INTO sales (venue_id, source, external_id, closed_at, business_date,
                                       sale_type, state, total, channel, channel_detail, payload)
                    VALUES (%s, 'fudo', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (venue_id, source, external_id) DO UPDATE
                      SET closed_at = EXCLUDED.closed_at,
                          business_date = EXCLUDED.business_date,
                          sale_type = EXCLUDED.sale_type,
                          state = EXCLUDED.state,
                          total = EXCLUDED.total,
                          channel = EXCLUDED.channel,
                          channel_detail = EXCLUDED.channel_detail,
                          payload = EXCLUDED.payload,
                          fetched_at = now()
                    RETURNING id
                    """,
                    (
                        venue_id,
                        str(sale.get("id")),
                        attrs.get("closedAt"),
                        bdate,
                        attrs.get("saleType"),
                        state,
                        total,
                        channel,
                        channel_detail,
                        Jsonb(sale),
                    ),
                ).fetchone()
                sale_id = sale_row["id"]
                pg.execute("DELETE FROM sale_items WHERE sale_id = %s", (sale_id,))
                for it in parsed:
                    cat_id = db.upsert_category(pg, venue_id, it["category"])
                    prod_id = db.upsert_product(
                        pg,
                        venue_id,
                        it["product"],
                        cat_id,
                        cost=it.get("catalog_cost"),
                        price=it.get("catalog_price"),
                    )
                    if mode == "unidad":
                        line_total = it["price"] * it["qty"]
                        line_cost = it["cost"] * it["qty"]
                        unit_price, unit_cost = it["price"], it["cost"]
                    else:
                        line_total = it["price"]
                        line_cost = it["cost"]
                        unit_price = (it["price"] / it["qty"]) if it["qty"] else None
                        unit_cost = (it["cost"] / it["qty"]) if it["qty"] else None
                    pg.execute(
                        """
                        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, line_total,
                                                unit_cost, line_cost, canceled)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, false)
                        """,
                        (sale_id, prod_id, it["qty"], unit_price, line_total, unit_cost, line_cost),
                    )
                written += 1
            if len(sales) < PAGE_SIZE:
                break
            page += 1
        finish_run(pg, run_id, "ok", read, written)
        return {"run": run_id, "read": read, "written": written, "status": "ok"}
    except Exception as exc:  # noqa: BLE001
        finish_run(pg, run_id, "error", read, written, str(exc))
        raise


# ------------------------------------------------------------------ gastos


def sync_expenses(pg, venue_id: int, client: FudoClient, d0: date, d1: date) -> dict:
    run_id = start_run(pg, venue_id, "fudo_expenses", d0, d1)
    params = {
        "filter[date]": f"and(gte.{d0.isoformat()},lte.{d1.isoformat()})",
        "include": "provider,expenseCategory,expenseItems.ingredient,expenseItems.product",
        "page[size]": PAGE_SIZE,
        "sort": "id",
        "fields[expense]": "amount,date,description,status,canceled,createdAt,receiptNumber,expenseItems,provider,expenseCategory",
        "fields[expenseCategory]": "name",
        "fields[expenseItem]": "quantity,price,detail,canceled",
        "fields[ingredient]": "name,cost",
        "fields[provider]": "name",
    }
    read = written = 0
    page = 1
    try:
        while page <= MAX_PAGES:
            q = dict(params)
            q["page[number]"] = page
            data = client.get("/expenses", q)
            expenses = data.get("data") or []
            inc = index_included(data.get("included"))
            for exp in expenses:
                attrs = exp.get("attributes") or {}
                if attrs.get("canceled"):
                    continue
                edate = attrs.get("date")
                if not edate:
                    continue
                try:
                    ed = date.fromisoformat(str(edate)[:10])
                except ValueError:
                    continue
                read += 1
                amount = float(attrs.get("amount") or 0)
                prov_obj = inc.get(("Provider", str(rel_id(exp, "provider")))) if rel_id(exp, "provider") else None
                prov_name = ((prov_obj or {}).get("attributes") or {}).get("name") or ""
                prov_id = db.upsert_provider(pg, venue_id, prov_name) if prov_name else None
                cat_obj = inc.get(("ExpenseCategory", str(rel_id(exp, "expenseCategory")))) if rel_id(exp, "expenseCategory") else None
                cat_name = ((cat_obj or {}).get("attributes") or {}).get("name") or ""
                cat_id = db.upsert_expense_category(pg, venue_id, cat_name) if cat_name else None

                item_ids = rel_id(exp, "expenseItems") or []
                parsed = []
                for iid in item_ids:
                    item = inc.get(("ExpenseItem", str(iid)))
                    if not item:
                        continue
                    ia = item.get("attributes") or {}
                    if ia.get("canceled"):
                        continue
                    detail = ia.get("detail") or ""
                    qty = float(ia.get("quantity") or 0)
                    price = float(ia.get("price") or 0)
                    ing = inc.get(("Ingredient", str(rel_id(item, "ingredient")))) if rel_id(item, "ingredient") else None
                    ing_attrs = (ing or {}).get("attributes") or {}
                    ing_name = ing_attrs.get("name") or detail or ""
                    unit = ing_attrs.get("unit")
                    parsed.append({"detail": detail, "qty": qty, "price": price, "ing": ing_name, "unit": unit})

                mode = _mode(parsed, amount)
                row = pg.execute(
                    """
                    INSERT INTO expenses (venue_id, source, external_id, expense_date, amount, description,
                                          provider_id, category_id, category_name, status, payload)
                    VALUES (%s, 'fudo', %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (venue_id, source, external_id) DO UPDATE
                      SET expense_date = EXCLUDED.expense_date,
                          amount = EXCLUDED.amount,
                          description = EXCLUDED.description,
                          provider_id = EXCLUDED.provider_id,
                          category_id = EXCLUDED.category_id,
                          category_name = EXCLUDED.category_name,
                          status = EXCLUDED.status,
                          payload = EXCLUDED.payload,
                          fetched_at = now()
                    RETURNING id
                    """,
                    (
                        venue_id,
                        str(exp.get("id")),
                        ed,
                        amount,
                        attrs.get("description") or attrs.get("receiptNumber") or "",
                        prov_id,
                        cat_id,
                        cat_name,
                        attrs.get("status"),
                        Jsonb(exp),
                    ),
                ).fetchone()
                exp_id = row["id"]
                pg.execute("DELETE FROM expense_items WHERE expense_id = %s", (exp_id,))
                for it in parsed:
                    ing_id = db.upsert_ingredient(pg, venue_id, it["ing"], it["unit"], None) if it["ing"] else None
                    if mode == "unidad":
                        line_total = it["price"] * it["qty"]
                        unit_price = it["price"]
                    else:
                        line_total = it["price"]
                        unit_price = (it["price"] / it["qty"]) if it["qty"] else None
                    pg.execute(
                        """
                        INSERT INTO expense_items (expense_id, ingredient_id, detail, quantity, unit,
                                                   unit_price, line_total, canceled)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, false)
                        """,
                        (exp_id, ing_id, it["detail"], it["qty"], it["unit"], unit_price, line_total),
                    )
                written += 1
            if len(expenses) < PAGE_SIZE:
                break
            page += 1
        finish_run(pg, run_id, "ok", read, written)
        return {"run": run_id, "read": read, "written": written, "status": "ok"}
    except Exception as exc:  # noqa: BLE001
        finish_run(pg, run_id, "error", read, written, str(exc))
        raise


# ------------------------------------------------------------------ insumos


def sync_ingredients(pg, venue_id: int, client: FudoClient) -> dict:
    run_id = start_run(pg, venue_id, "fudo_ingredients", None, None)
    read = written = 0
    page = 1
    try:
        while page <= MAX_PAGES:
            data = client.get("/ingredients", {"page[size]": PAGE_SIZE, "page[number]": page})
            rows = data.get("data") or []
            for ing in rows:
                read += 1
                a = ing.get("attributes") or {}
                if not a.get("name"):
                    continue
                db.upsert_ingredient(
                    pg,
                    venue_id,
                    a["name"],
                    a.get("unit"),
                    float(a["cost"]) if a.get("cost") is not None else None,
                    str(ing.get("id")),
                )
                written += 1
            if len(rows) < PAGE_SIZE:
                break
            page += 1
        finish_run(pg, run_id, "ok", read, written)
        return {"run": run_id, "read": read, "written": written, "status": "ok"}
    except Exception as exc:  # noqa: BLE001
        finish_run(pg, run_id, "error", read, written, str(exc))
        raise


# ------------------------------------------------------------------ CLI


def main() -> None:
    ap = argparse.ArgumentParser(description="Ingesta de Fudo a Postgres")
    ap.add_argument("--what", choices=["sales", "expenses", "ingredients", "all"], default="all")
    ap.add_argument("--from", dest="d0", default=None)
    ap.add_argument("--to", dest="d1", default=None)
    ap.add_argument("--venue", default="bois")
    ap.add_argument("--env", default=".env")
    args = ap.parse_args()

    load_env(Path(args.env))
    client = client_from_env()

    d1 = date.fromisoformat(args.d1) if args.d1 else date.today()
    d0 = date.fromisoformat(args.d0) if args.d0 else (d1 - timedelta(days=7))
    if d0 > d1:
        d0, d1 = d1, d0

    with db.connect(direct=True) as pg:
        db.apply_schema(pg)
        venue_id = db.ensure_venue(pg, args.venue)
        print(f"Local {args.venue} (id {venue_id}) · rango {d0} → {d1}")
        if args.what in ("sales", "all"):
            print("Ventas:", sync_sales(pg, venue_id, client, d0, d1))
            from . import recompute as rec

            print("Agregados:", rec.recompute(pg, venue_id))
        if args.what in ("expenses", "all"):
            print("Gastos:", sync_expenses(pg, venue_id, client, d0, d1))
        if args.what in ("ingredients", "all"):
            print("Insumos:", sync_ingredients(pg, venue_id, client))


if __name__ == "__main__":
    main()
