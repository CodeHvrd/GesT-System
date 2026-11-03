"""Importación de ventas desde la API de Fudo.

Toma las ventas cerradas de un rango de fechas, con sus ítems y productos, y arma
las mismas líneas que hoy se pegan a mano en `Import_Fudo_Detalle`:
fecha · categoría · producto · cantidad · ventas · CMV.

La API no documenta si `price`/`cost` de un ítem son por unidad o por línea, así que
se detecta solo comparando la suma de ítems contra el `total` de cada venta.
"""

from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta, timezone

from . import util

PAGE_SIZE = 500
MAX_PAGES = 60
TZ_OFFSET = timedelta(hours=-3)  # Argentina, sin horario de verano


def _local_date(value) -> date | None:
    """closedAt/createdAt vienen en UTC; el local está en UTC-3."""
    if not value:
        return None
    s = str(value).replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return (dt + TZ_OFFSET).date()


def _index_included(rows: list[dict]) -> dict[tuple[str, str], dict]:
    idx = {}
    for r in rows or []:
        idx[(str(r.get("type")), str(r.get("id")))] = r
    return idx


def _rel_id(obj: dict, name: str):
    rel = (obj.get("relationships") or {}).get(name) or {}
    data = rel.get("data")
    if isinstance(data, list):
        return [str(d.get("id")) for d in data if isinstance(d, dict)]
    if isinstance(data, dict):
        return str(data.get("id"))
    return None


def fetch_sales(client, d0: date, d1: date) -> dict:
    """Devuelve {'items': [...], 'salidas': {...}} con los ítems crudos del rango."""
    start = f"{d0.isoformat()}T00:00:00Z"
    end = f"{(d1 + timedelta(days=1)).isoformat()}T00:00:00Z"
    params = {
        "filter[closedAt]": f"and(gte.{start},lt.{end})",
        "include": "items.product,items.product.productCategory",
        "page[size]": PAGE_SIZE,
        "sort": "id",
    }
    raw_items: list[dict] = []
    totals = {"fudo": 0.0, "linea": 0.0, "unidad": 0.0}
    sales_n = 0
    days: set[str] = set()
    page = 1
    while page <= MAX_PAGES:
        q = dict(params)
        q["page[number]"] = page
        data = client.get("/sales", q)
        sales = data.get("data") or []
        idx = _index_included(data.get("included") or [])
        for sale in sales:
            attrs = sale.get("attributes") or {}
            if str(attrs.get("saleState") or "").upper() != "CLOSED":
                continue
            when = _local_date(attrs.get("closedAt") or attrs.get("createdAt"))
            if not when:
                continue
            total = float(attrs.get("total") or 0)
            item_ids = _rel_id(sale, "items") or []
            line_sum = 0.0
            unit_sum = 0.0
            for iid in item_ids:
                item = idx.get(("Item", str(iid)))
                if not item:
                    continue
                ia = item.get("attributes") or {}
                if ia.get("canceled"):
                    continue
                qty = float(ia.get("quantity") or 0)
                price = float(ia.get("price") or 0)
                cost = float(ia.get("cost") or 0)
                pid = _rel_id(item, "product")
                prod = idx.get(("Product", str(pid))) if pid else None
                pname = ((prod or {}).get("attributes") or {}).get("name") or "Sin producto"
                cid = _rel_id(prod, "productCategory") if prod else None
                cat = idx.get(("ProductCategory", str(cid))) if cid else None
                cname = ((cat or {}).get("attributes") or {}).get("name") or "Sin categoría"
                raw_items.append(
                    {
                        "fecha": when.isoformat(),
                        "categoria": cname,
                        "producto": pname,
                        "cantidad": qty,
                        "precio": price,
                        "costo": cost,
                    }
                )
                line_sum += price
                unit_sum += price * qty
            totals["fudo"] += total
            totals["linea"] += line_sum
            totals["unidad"] += unit_sum
            sales_n += 1
            days.add(when.isoformat())
        if len(sales) < PAGE_SIZE:
            break
        page += 1

    # ¿price es por línea o por unidad?
    dif_linea = abs(totals["linea"] - totals["fudo"])
    dif_unidad = abs(totals["unidad"] - totals["fudo"])
    modo = "linea" if dif_linea <= dif_unidad else "unidad"
    total_items = totals["linea"] if modo == "linea" else totals["unidad"]
    diff_pct = (abs(total_items - totals["fudo"]) / totals["fudo"] * 100) if totals["fudo"] else 0.0
    return {
        "items": raw_items,
        "modo": modo,
        "control": {
            "ventas_fudo": round(totals["fudo"], 2),
            "ventas_items": round(total_items, 2),
            "diferencia_pct": round(diff_pct, 3),
            "ventas_line": round(totals["linea"], 2),
            "ventas_unit": round(totals["unidad"], 2),
            "ventas_count": sales_n,
            "dias": sorted(days),
        },
    }


def build_lines(raw: dict) -> list[dict]:
    """Agrupa por fecha+producto+categoría y arma las filas para la tabla `sales`."""
    modo = raw.get("modo") or "unidad"
    agg: dict[tuple, dict] = {}
    for it in raw.get("items") or []:
        qty = it["cantidad"]
        precio = it["precio"] if modo == "linea" else it["precio"] * qty
        costo = it["costo"] if modo == "linea" else it["costo"] * qty
        k = (it["fecha"], it["categoria"], it["producto"])
        a = agg.setdefault(
            k,
            {
                "fecha": it["fecha"],
                "categoria": it["categoria"],
                "subcategoria": "",
                "producto": it["producto"],
                "cantidad": 0.0,
                "ventas": 0.0,
                "cmv": 0.0,
            },
        )
        a["cantidad"] += qty
        a["ventas"] += precio
        a["cmv"] += costo
    out = []
    for a in agg.values():
        d = date.fromisoformat(a["fecha"])
        a["mes"] = d.strftime("%Y-%m")
        a["semana"] = util.week_key(d)
        a["ventas"] = round(a["ventas"], 2)
        a["cmv"] = round(a["cmv"], 2)
        a["cmv_pct"] = round((a["cmv"] / a["ventas"] * 100), 4) if a["ventas"] else 0.0
        a["costo_unit"] = round(a["cmv"] / a["cantidad"], 4) if a["cantidad"] else None
        a["hash"] = hashlib.sha1(
            "|".join([a["fecha"], a["categoria"], a["producto"]]).encode("utf-8")
        ).hexdigest()
        a["source_row"] = None
        out.append(a)
    out.sort(key=lambda x: (x["fecha"], x["categoria"], x["producto"]))
    return out


def preview(client, d0: date, d1: date) -> dict:
    raw = fetch_sales(client, d0, d1)
    lines = build_lines(raw)
    control = raw["control"]
    ventas = sum(l["ventas"] for l in lines)
    cmv = sum(l["cmv"] for l in lines)
    return {
        "from": d0.isoformat(),
        "to": d1.isoformat(),
        "modo": raw["modo"],
        "control": control,
        "lineas": len(lines),
        "productos": len({l["producto"] for l in lines}),
        "dias": len({l["fecha"] for l in lines}),
        "ventas": round(ventas, 2),
        "cmv": round(cmv, 2),
        "cmv_pct": round(cmv / ventas * 100, 2) if ventas else 0.0,
        "semanas": sorted({l["semana"] for l in lines}),
        "muestra": lines[:12],
    }
