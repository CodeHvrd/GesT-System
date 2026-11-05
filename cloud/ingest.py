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
import time
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

# Cache en memoria del catálogo de productos: (base_url, api_key) -> (epoch, catalog_dict)
_CATALOG_CACHE: dict[tuple[str, str], tuple[float, dict[str, dict]]] = {}
CATALOG_TTL = 600.0


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


def save_credentials(pg, venue_id: int, api_key: str, api_secret: str) -> None:
    pg.execute(
        """
        CREATE TABLE IF NOT EXISTS fudo_credentials (
            venue_id       bigint PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
            api_key_enc    text NOT NULL,
            api_secret_enc text NOT NULL,
            updated_at     timestamptz NOT NULL DEFAULT now()
        )
        """
    )
    pg.execute(
        """
        INSERT INTO fudo_credentials (venue_id, api_key_enc, api_secret_enc, updated_at)
        VALUES (%s, %s, %s, now())
        ON CONFLICT (venue_id) DO UPDATE
          SET api_key_enc = EXCLUDED.api_key_enc,
              api_secret_enc = EXCLUDED.api_secret_enc,
              updated_at = now()
        """,
        (venue_id, api_key.strip(), api_secret.strip()),
    )


def client_from_env(pg=None, venue_id: int | None = None) -> FudoClient:
    api_key = (os.environ.get("FUDO_API_KEY") or "").strip()
    api_secret = (os.environ.get("FUDO_API_SECRET") or "").strip()
    if (not api_key or not api_secret) and pg is not None and venue_id is not None:
        try:
            row = pg.execute(
                "SELECT api_key_enc, api_secret_enc FROM fudo_credentials WHERE venue_id = %s",
                (venue_id,),
            ).fetchone()
            if row:
                api_key = api_key or (row["api_key_enc"] or "").strip()
                api_secret = api_secret or (row["api_secret_enc"] or "").strip()
        except Exception:  # noqa: BLE001
            pg.rollback()
    cfg = {"fudo": {"api_key": api_key, "api_secret": api_secret}}
    client = FudoClient(cfg)
    if not client.configured:
        raise SystemExit("Faltan FUDO_API_KEY y FUDO_API_SECRET.")
    return client


# ------------------------------------------------------------------ sync runs


def start_run(pg, venue_id: int, kind: str, d0: date | None, d1: date | None) -> int:
    row = pg.execute(
        """
        INSERT INTO sync_runs (venue_id, kind, range_start, range_end, started_at, status)
        VALUES (%s, %s, %s, %s, clock_timestamp(), 'running') RETURNING id
        """,
        (venue_id, kind, d0, d1),
    ).fetchone()
    return row["id"]


def finish_run(pg, run_id: int, status: str, read: int, written: int, message: str = "") -> None:
    pg.execute(
        """
        UPDATE sync_runs
           SET status = %s, rows_read = %s, rows_written = %s, message = %s, finished_at = clock_timestamp()
         WHERE id = %s
        """,
        (status, read, written, message[:1000], run_id),
    )


# ------------------------------------------------------------------ ventas


def fetch_product_catalog(client: FudoClient, use_cache: bool = True) -> dict[str, dict]:
    """Catálogo de productos con costo: directo o calculado desde la receta.

    Fudo no devuelve el costo en los ítems de venta. El costo por producto sale de
    `cost` (si está cargado) o de la receta: proporción × costo del insumo × merma.
    """
    cache_key = (client.base_url, client.api_key)
    now = time.time()
    if use_cache:
        cached = _CATALOG_CACHE.get(cache_key)
        if cached and (now - cached[0]) < CATALOG_TTL:
            return cached[1]

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
    _CATALOG_CACHE[cache_key] = (now, out)
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
    overrides: dict[str, float] = {}
    try:
        for r in pg.execute(
            "SELECT lower(p.name) AS name, o.cost FROM product_cost_overrides o "
            "JOIN products p ON p.id = o.product_id WHERE o.venue_id = %s",
            (venue_id,),
        ).fetchall():
            if r["cost"] is not None:
                overrides[r["name"]] = float(r["cost"])
    except Exception:  # noqa: BLE001
        pg.rollback()
        run_id = start_run(pg, venue_id, "fudo_sales", d0, d1)

    read = written = 0
    page = 1
    try:
        categories_set: set[str] = set()
        products_map: dict[str, dict] = {}
        sales_records: list[dict] = []
        items_by_ext: dict[str, list[dict]] = {}
        synced_dates: set[date] = set()

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
                    pname = (
                        (entry or {}).get("name")
                        or ((prod or {}).get("attributes") or {}).get("name")
                        or "Sin producto"
                    ).strip() or "Sin producto"
                    cid = rel_id(prod, "productCategory") if prod else None
                    cat = inc.get(("ProductCategory", str(cid))) if cid else None
                    cname = (((cat or {}).get("attributes") or {}).get("name") or "Sin categoría").strip() or "Sin categoría"

                    raw_item_cost = ia.get("cost")
                    cat_cost = (entry or {}).get("cost")
                    ovr_cost = overrides.get(pname.lower())
                    if raw_item_cost is not None and float(raw_item_cost) > 0:
                        cost_val = float(raw_item_cost)
                        cost_is_unit = False
                    else:
                        cost_val = float(cat_cost if cat_cost is not None else (ovr_cost or 0))
                        cost_is_unit = True

                    categories_set.add(cname)
                    p_existing = products_map.get(pname)
                    p_cost = (entry or {}).get("cost")
                    p_price = (entry or {}).get("price")
                    if not p_existing:
                        products_map[pname] = {
                            "name": pname,
                            "category": cname,
                            "cost": p_cost,
                            "price": p_price,
                        }
                    else:
                        if p_cost is not None:
                            p_existing["cost"] = p_cost
                        if p_price is not None:
                            p_existing["price"] = p_price

                    parsed.append(
                        {
                            "qty": qty,
                            "price": price,
                            "cost": cost_val,
                            "cost_is_unit": cost_is_unit,
                            "product": pname,
                            "category": cname,
                        }
                    )
                mode = _mode(parsed, total)
                ext_id = str(sale.get("id"))
                synced_dates.add(bdate)
                sales_records.append(
                    {
                        "external_id": ext_id,
                        "closed_at": attrs.get("closedAt"),
                        "business_date": bdate.isoformat(),
                        "sale_type": attrs.get("saleType"),
                        "state": state,
                        "total": total,
                        "channel": channel,
                        "channel_detail": channel_detail,
                        "payload": sale,
                    }
                )
                sale_items_list = []
                for it in parsed:
                    qty = it["qty"]
                    if mode == "unidad":
                        line_total = round(it["price"] * qty, 2)
                        unit_price = it["price"]
                    else:
                        line_total = round(it["price"], 2)
                        unit_price = round(it["price"] / qty, 4) if qty else None

                    if it["cost_is_unit"] or mode == "unidad":
                        unit_cost = round(it["cost"], 4)
                        line_cost = round(it["cost"] * qty, 2)
                    else:
                        line_cost = round(it["cost"], 2)
                        unit_cost = round(it["cost"] / qty, 4) if qty else None

                    sale_items_list.append(
                        {
                            "product": it["product"],
                            "quantity": qty,
                            "unit_price": unit_price,
                            "line_total": line_total,
                            "unit_cost": unit_cost,
                            "line_cost": line_cost,
                        }
                    )
                items_by_ext[ext_id] = sale_items_list
                written += 1

            if len(sales) < PAGE_SIZE:
                break
            page += 1

        if categories_set:
            cat_rows = pg.execute(
                """
                INSERT INTO product_categories (venue_id, name)
                SELECT %s, x.name
                  FROM jsonb_to_recordset(%s::jsonb) AS x(name text)
                ON CONFLICT (venue_id, name) DO UPDATE
                  SET name = EXCLUDED.name
                RETURNING id, name
                """,
                (venue_id, Jsonb([{"name": n} for n in categories_set])),
            ).fetchall()
            cat_id_map = {r["name"]: r["id"] for r in cat_rows}
        else:
            cat_id_map = {}

        if products_map:
            prod_payload = [
                {
                    "name": p["name"],
                    "category_id": cat_id_map.get(p["category"]),
                    "cost": p["cost"],
                    "price": p["price"],
                }
                for p in products_map.values()
            ]
            prod_rows = pg.execute(
                """
                INSERT INTO products (venue_id, name, category_id, cost, price)
                SELECT %s, x.name, x.category_id, x.cost, x.price
                  FROM jsonb_to_recordset(%s::jsonb) AS x(
                       name text, category_id bigint, cost numeric, price numeric
                  )
                ON CONFLICT (venue_id, name) DO UPDATE
                  SET category_id = COALESCE(EXCLUDED.category_id, products.category_id),
                      cost = COALESCE(EXCLUDED.cost, products.cost),
                      price = COALESCE(EXCLUDED.price, products.price),
                      updated_at = now()
                RETURNING id, name
                """,
                (venue_id, Jsonb(prod_payload)),
            ).fetchall()
            prod_id_map = {r["name"]: r["id"] for r in prod_rows}
        else:
            prod_id_map = {}

        if sales_records:
            sale_rows = pg.execute(
                """
                INSERT INTO sales (venue_id, source, external_id, closed_at, business_date,
                                   sale_type, state, total, channel, channel_detail, payload)
                SELECT %s, 'fudo', x.external_id, x.closed_at::timestamptz, x.business_date::date,
                       x.sale_type, x.state, x.total, x.channel, x.channel_detail, x.payload
                  FROM jsonb_to_recordset(%s::jsonb) AS x(
                       external_id text, closed_at text, business_date text,
                       sale_type text, state text, total numeric,
                       channel text, channel_detail text, payload jsonb
                  )
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
                RETURNING id, external_id
                """,
                (venue_id, Jsonb(sales_records)),
            ).fetchall()
            sale_id_map = {r["external_id"]: r["id"] for r in sale_rows}
            sale_ids = list(sale_id_map.values())
            pg.execute("DELETE FROM sale_items WHERE sale_id = ANY(%s)", (sale_ids,))

            flat_items = []
            for ext_id, items in items_by_ext.items():
                sid = sale_id_map.get(ext_id)
                if not sid:
                    continue
                for it in items:
                    flat_items.append(
                        {
                            "sale_id": sid,
                            "product_id": prod_id_map.get(it["product"]),
                            "quantity": it["quantity"],
                            "unit_price": it["unit_price"],
                            "line_total": it["line_total"],
                            "unit_cost": it["unit_cost"],
                            "line_cost": it["line_cost"],
                        }
                    )
            if flat_items:
                pg.execute(
                    """
                    INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, line_total,
                                            unit_cost, line_cost, canceled)
                    SELECT x.sale_id, x.product_id, x.quantity, x.unit_price, x.line_total,
                           x.unit_cost, x.line_cost, false
                      FROM jsonb_to_recordset(%s::jsonb) AS x(
                           sale_id bigint, product_id bigint, quantity numeric,
                           unit_price numeric, line_total numeric, unit_cost numeric, line_cost numeric
                      )
                    """,
                    (Jsonb(flat_items),),
                )

            if synced_dates:
                pg.execute(
                    "DELETE FROM sales WHERE venue_id = %s AND source = 'sheet' AND business_date = ANY(%s)",
                    (venue_id, list(synced_dates)),
                )

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
        providers_set: set[str] = set()
        exp_cats_set: set[str] = set()
        ingredients_map: dict[str, str | None] = {}
        expenses_records: list[dict] = []
        items_by_ext: dict[str, list[dict]] = {}

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
                prov_name = (((prov_obj or {}).get("attributes") or {}).get("name") or "").strip()
                if prov_name:
                    providers_set.add(prov_name)
                cat_obj = (
                    inc.get(("ExpenseCategory", str(rel_id(exp, "expenseCategory"))))
                    if rel_id(exp, "expenseCategory")
                    else None
                )
                cat_name = (((cat_obj or {}).get("attributes") or {}).get("name") or "").strip()
                if cat_name:
                    exp_cats_set.add(cat_name)

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
                    ing = (
                        inc.get(("Ingredient", str(rel_id(item, "ingredient"))))
                        if rel_id(item, "ingredient")
                        else None
                    )
                    ing_attrs = (ing or {}).get("attributes") or {}
                    ing_name = (ing_attrs.get("name") or detail or "").strip()
                    unit = ing_attrs.get("unit")
                    if ing_name:
                        ingredients_map.setdefault(ing_name, unit)
                    parsed.append({"detail": detail, "qty": qty, "price": price, "ing": ing_name, "unit": unit})

                mode = _mode(parsed, amount)
                ext_id = str(exp.get("id"))
                expenses_records.append(
                    {
                        "external_id": ext_id,
                        "expense_date": ed.isoformat(),
                        "amount": amount,
                        "description": attrs.get("description") or attrs.get("receiptNumber") or "",
                        "provider_name": prov_name,
                        "category_name": cat_name,
                        "status": attrs.get("status"),
                        "payload": exp,
                    }
                )
                exp_items_list = []
                for it in parsed:
                    if mode == "unidad":
                        line_total = round(it["price"] * it["qty"], 2)
                        unit_price = it["price"]
                    else:
                        line_total = round(it["price"], 2)
                        unit_price = round(it["price"] / it["qty"], 4) if it["qty"] else None
                    exp_items_list.append(
                        {
                            "ing": it["ing"],
                            "detail": it["detail"],
                            "quantity": it["qty"],
                            "unit": it["unit"],
                            "unit_price": unit_price,
                            "line_total": line_total,
                        }
                    )
                items_by_ext[ext_id] = exp_items_list
                written += 1

            if len(expenses) < PAGE_SIZE:
                break
            page += 1

        if providers_set:
            prov_rows = pg.execute(
                """
                INSERT INTO providers (venue_id, name)
                SELECT %s, x.name
                  FROM jsonb_to_recordset(%s::jsonb) AS x(name text)
                ON CONFLICT (venue_id, name) DO UPDATE
                  SET name = EXCLUDED.name
                RETURNING id, name
                """,
                (venue_id, Jsonb([{"name": n} for n in providers_set])),
            ).fetchall()
            prov_id_map = {r["name"]: r["id"] for r in prov_rows}
        else:
            prov_id_map = {}

        if exp_cats_set:
            ec_rows = pg.execute(
                """
                INSERT INTO expense_categories (venue_id, name)
                SELECT %s, x.name
                  FROM jsonb_to_recordset(%s::jsonb) AS x(name text)
                ON CONFLICT (venue_id, name) DO UPDATE
                  SET name = EXCLUDED.name
                RETURNING id, name
                """,
                (venue_id, Jsonb([{"name": n} for n in exp_cats_set])),
            ).fetchall()
            ec_id_map = {r["name"]: r["id"] for r in ec_rows}
        else:
            ec_id_map = {}

        if ingredients_map:
            ing_rows = pg.execute(
                """
                INSERT INTO ingredients (venue_id, name, unit)
                SELECT %s, x.name, x.unit
                  FROM jsonb_to_recordset(%s::jsonb) AS x(name text, unit text)
                ON CONFLICT (venue_id, name) DO UPDATE
                  SET unit = COALESCE(EXCLUDED.unit, ingredients.unit),
                      updated_at = now()
                RETURNING id, name
                """,
                (venue_id, Jsonb([{"name": k, "unit": v} for k, v in ingredients_map.items()])),
            ).fetchall()
            ing_id_map = {r["name"]: r["id"] for r in ing_rows}
        else:
            ing_id_map = {}

        if expenses_records:
            exp_payload = [
                {
                    "external_id": e["external_id"],
                    "expense_date": e["expense_date"],
                    "amount": e["amount"],
                    "description": e["description"],
                    "provider_id": prov_id_map.get(e["provider_name"]) if e["provider_name"] else None,
                    "category_id": ec_id_map.get(e["category_name"]) if e["category_name"] else None,
                    "category_name": e["category_name"],
                    "status": e["status"],
                    "payload": e["payload"],
                }
                for e in expenses_records
            ]
            exp_rows = pg.execute(
                """
                INSERT INTO expenses (venue_id, source, external_id, expense_date, amount, description,
                                      provider_id, category_id, category_name, status, payload)
                SELECT %s, 'fudo', x.external_id, x.expense_date::date, x.amount, x.description,
                       x.provider_id, x.category_id, x.category_name, x.status, x.payload
                  FROM jsonb_to_recordset(%s::jsonb) AS x(
                       external_id text, expense_date text, amount numeric, description text,
                       provider_id bigint, category_id bigint, category_name text,
                       status text, payload jsonb
                  )
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
                RETURNING id, external_id
                """,
                (venue_id, Jsonb(exp_payload)),
            ).fetchall()
            exp_id_map = {r["external_id"]: r["id"] for r in exp_rows}
            exp_ids = list(exp_id_map.values())
            pg.execute("DELETE FROM expense_items WHERE expense_id = ANY(%s)", (exp_ids,))

            flat_items = []
            for ext_id, items in items_by_ext.items():
                eid = exp_id_map.get(ext_id)
                if not eid:
                    continue
                for it in items:
                    flat_items.append(
                        {
                            "expense_id": eid,
                            "ingredient_id": ing_id_map.get(it["ing"]) if it["ing"] else None,
                            "detail": it["detail"],
                            "quantity": it["quantity"],
                            "unit": it["unit"],
                            "unit_price": it["unit_price"],
                            "line_total": it["line_total"],
                        }
                    )
            if flat_items:
                pg.execute(
                    """
                    INSERT INTO expense_items (expense_id, ingredient_id, detail, quantity, unit,
                                               unit_price, line_total, canceled)
                    SELECT x.expense_id, x.ingredient_id, x.detail, x.quantity, x.unit,
                           x.unit_price, x.line_total, false
                      FROM jsonb_to_recordset(%s::jsonb) AS x(
                           expense_id bigint, ingredient_id bigint, detail text,
                           quantity numeric, unit text, unit_price numeric, line_total numeric
                      )
                    """,
                    (Jsonb(flat_items),),
                )

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
        batch = []
        while page <= MAX_PAGES:
            data = client.get("/ingredients", {"page[size]": PAGE_SIZE, "page[number]": page})
            rows = data.get("data") or []
            for ing in rows:
                read += 1
                a = ing.get("attributes") or {}
                name = (a.get("name") or "").strip()
                if not name:
                    continue
                batch.append(
                    {
                        "fudo_id": str(ing.get("id")),
                        "name": name,
                        "unit": a.get("unit"),
                        "cost": float(a["cost"]) if a.get("cost") is not None else None,
                    }
                )
                written += 1
            if len(rows) < PAGE_SIZE:
                break
            page += 1
        if batch:
            pg.execute(
                """
                INSERT INTO ingredients (venue_id, fudo_id, name, unit, cost)
                SELECT %s, x.fudo_id, x.name, x.unit, x.cost
                  FROM jsonb_to_recordset(%s::jsonb) AS x(
                       fudo_id text, name text, unit text, cost numeric
                  )
                ON CONFLICT (venue_id, name) DO UPDATE
                  SET fudo_id = COALESCE(ingredients.fudo_id, EXCLUDED.fudo_id),
                      unit = COALESCE(EXCLUDED.unit, ingredients.unit),
                      cost = COALESCE(EXCLUDED.cost, ingredients.cost),
                      updated_at = now()
                """,
                (venue_id, Jsonb(batch)),
            )
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
