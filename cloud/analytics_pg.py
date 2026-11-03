"""Consultas del portal web sobre Postgres (Neon).

Devuelve la misma información que necesita el dashboard de clientes:
resumen del período, comparación, categorías, serie diaria, gastos y revisión.

Reglas:
- Ventas de menú = todo menos el canal delivery (las apps se muestran aparte).
- CMV se calcula sobre el menú.
- Gastos: si el período tiene planilla, manda la planilla; si no, Fudo.
"""

from __future__ import annotations

import unicodedata
from datetime import date, timedelta

from app.config import load_config

MESES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]


def norm(text: str) -> str:
    t = unicodedata.normalize("NFKD", (text or "").strip().lower())
    t = "".join(c for c in t if not unicodedata.combining(c))
    return " ".join(t.split())


def f(v) -> float:
    return float(v or 0)


def r(v, n: int = 2) -> float:
    return round(float(v or 0), n)


def targets() -> dict[str, tuple[float, float]]:
    cfg = load_config()
    out = {}
    for k, v in (cfg.get("cmv_targets") or {}).items():
        try:
            out[norm(k)] = (float(v[0]), float(v[1]))
        except Exception:  # noqa: BLE001
            continue
    return out


def label_period(d0: date, d1: date) -> str:
    if d0.day == 1 and (d1 + timedelta(days=1)).day == 1 and d0.month == d1.month:
        return f"{MESES[d0.month - 1].capitalize()} {d0.year}"
    if d0.year == d1.year:
        return f"{d0.day}–{d1.day} {MESES[d1.month - 1][:3]} {d1.year}"
    return f"{d0.isoformat()} → {d1.isoformat()}"


def previous_range(d0: date, d1: date) -> tuple[date, date]:
    # período mensual completo -> mes anterior completo
    if d0.day == 1 and (d1 + timedelta(days=1)).day == 1 and d0.month == d1.month:
        prev_end = d0 - timedelta(days=1)
        prev_start = prev_end.replace(day=1)
        return prev_start, prev_end
    days = (d1 - d0).days + 1
    prev_end = d0 - timedelta(days=1)
    return prev_end - timedelta(days=days - 1), prev_end


# ------------------------------------------------------------------ consultas


def _totals(conn, venue_id: int, d0: date, d1: date) -> dict:
    row = conn.execute(
        """
        SELECT COALESCE(SUM(CASE WHEN s.channel <> 'delivery' THEN si.line_total ELSE 0 END), 0) AS menu_ventas,
               COALESCE(SUM(CASE WHEN s.channel <> 'delivery' THEN si.line_cost  ELSE 0 END), 0) AS menu_cmv,
               COALESCE(SUM(CASE WHEN s.channel  = 'delivery' THEN si.line_total ELSE 0 END), 0) AS delivery_ventas,
               COALESCE(SUM(si.line_total), 0) AS ventas,
               COALESCE(SUM(si.line_cost), 0)  AS cmv,
               COUNT(DISTINCT s.id) AS ventas_n
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
         WHERE s.venue_id = %s
           AND s.state = 'CLOSED'
           AND si.canceled = false
           AND s.business_date BETWEEN %s AND %s
        """,
        (venue_id, d0, d1),
    ).fetchone()
    menu_v, menu_c = f(row["menu_ventas"]), f(row["menu_cmv"])
    return {
        "ventas": r(row["ventas"]),
        "ventas_menu": r(menu_v),
        "ventas_delivery": r(row["delivery_ventas"]),
        "cmv": r(menu_c),
        "cmv_pct": r(menu_c / menu_v * 100, 1) if menu_v else 0.0,
        "ganancia": r(menu_v - menu_c),
        "ventas_n": int(row["ventas_n"] or 0),
        "ticket": r(menu_v / row["ventas_n"], 0) if row["ventas_n"] else 0,
    }


def _expenses(conn, venue_id: int, d0: date, d1: date) -> dict:
    row = conn.execute(
        """
        WITH b AS (
            SELECT source, SUM(amount) t, COUNT(*) n
              FROM expenses
             WHERE venue_id = %s AND expense_date BETWEEN %s AND %s
             GROUP BY source
        )
        SELECT COALESCE((SELECT t FROM b WHERE source = 'sheet'), (SELECT t FROM b WHERE source = 'fudo'), 0) AS gastos,
               COALESCE((SELECT n FROM b WHERE source = 'sheet'), (SELECT n FROM b WHERE source = 'fudo'), 0) AS gastos_n,
               COALESCE((SELECT t FROM b WHERE source = 'sheet'), 0) AS planilla,
               COALESCE((SELECT t FROM b WHERE source = 'fudo'), 0) AS fudo,
               (SELECT source FROM b ORDER BY CASE source WHEN 'sheet' THEN 1 WHEN 'fudo' THEN 2 ELSE 3 END LIMIT 1) AS fuente
        """,
        (venue_id, d0, d1),
    ).fetchone()
    return {
        "total": r(row["gastos"]),
        "n": int(row["gastos_n"] or 0),
        "planilla": r(row["planilla"]),
        "fudo": r(row["fudo"]),
        "fuente": row["fuente"] or "sin datos",
    }


def _top_category(conn, venue_id: int, d0: date, d1: date) -> dict | None:
    row = conn.execute(
        """
        SELECT COALESCE(c.name, 'Sin categoría') AS categoria,
               SUM(si.line_total) AS ventas,
               SUM(si.line_cost) AS cmv
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          LEFT JOIN products p ON p.id = si.product_id
          LEFT JOIN product_categories c ON c.id = p.category_id
         WHERE s.venue_id = %s AND s.state = 'CLOSED' AND si.canceled = false
           AND s.channel <> 'delivery'
           AND s.business_date BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 2 DESC LIMIT 1
        """,
        (venue_id, d0, d1),
    ).fetchone()
    if not row:
        return None
    v, c = f(row["ventas"]), f(row["cmv"])
    return {"categoria": row["categoria"], "ventas": r(v), "cmv_pct": r(c / v * 100, 1) if v else 0}


def summary(conn, venue_id: int, d0: date, d1: date) -> dict:
    cur = _totals(conn, venue_id, d0, d1)
    p0, p1 = previous_range(d0, d1)
    prev = _totals(conn, venue_id, p0, p1)
    exp = _expenses(conn, venue_id, d0, d1)
    prev_exp = _expenses(conn, venue_id, p0, p1)
    top = _top_category(conn, venue_id, d0, d1)

    def pct(a, b):
        return r((a - b) / b * 100, 1) if b else None

    return {
        "periodo": {"desde": d0.isoformat(), "hasta": d1.isoformat(), "etiqueta": label_period(d0, d1),
                    "dias": (d1 - d0).days + 1},
        "anterior": {"desde": p0.isoformat(), "hasta": p1.isoformat(), "etiqueta": label_period(p0, p1)},
        "kpis": {
            "ventas": cur["ventas"],
            "ventas_menu": cur["ventas_menu"],
            "ventas_delivery": cur["ventas_delivery"],
            "gastos": exp["total"],
            "cmv": cur["cmv"],
            "cmv_pct": cur["cmv_pct"],
            "ganancia": cur["ganancia"],
            "ticket": cur["ticket"],
            "ventas_n": cur["ventas_n"],
            "top_categoria": top,
        },
        "gastos_detalle": exp,
        "comparacion": {
            "ventas_pct": pct(cur["ventas"], prev["ventas"]),
            "ventas_menu_pct": pct(cur["ventas_menu"], prev["ventas_menu"]),
            "delivery_pct": pct(cur["ventas_delivery"], prev["ventas_delivery"]),
            "gastos_pct": pct(exp["total"], prev_exp["total"]),
            "ganancia_pct": pct(cur["ganancia"], prev["ganancia"]),
            "cmv_pp": r(cur["cmv_pct"] - prev["cmv_pct"], 1),
            "anterior": {
                "ventas": prev["ventas"],
                "ventas_menu": prev["ventas_menu"],
                "ventas_delivery": prev["ventas_delivery"],
                "gastos": prev_exp["total"],
                "cmv_pct": prev["cmv_pct"],
                "ganancia": prev["ganancia"],
            },
        },
    }


def categories(conn, venue_id: int, d0: date, d1: date) -> list[dict]:
    p0, p1 = previous_range(d0, d1)
    rows = conn.execute(
        """
        SELECT COALESCE(c.name, 'Sin categoría') AS categoria,
               SUM(si.line_total) AS ventas,
               SUM(si.line_cost) AS cmv,
               SUM(si.quantity) AS cantidad
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          LEFT JOIN products p ON p.id = si.product_id
          LEFT JOIN product_categories c ON c.id = p.category_id
         WHERE s.venue_id = %s AND s.state = 'CLOSED' AND si.canceled = false
           AND s.channel <> 'delivery'
           AND s.business_date BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 2 DESC
        """,
        (venue_id, d0, d1),
    ).fetchall()
    prev_rows = conn.execute(
        """
        SELECT COALESCE(c.name, 'Sin categoría') AS categoria, SUM(si.line_total) AS ventas
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          LEFT JOIN products p ON p.id = si.product_id
          LEFT JOIN product_categories c ON c.id = p.category_id
         WHERE s.venue_id = %s AND s.state = 'CLOSED' AND si.canceled = false
           AND s.channel <> 'delivery'
           AND s.business_date BETWEEN %s AND %s
         GROUP BY 1
        """,
        (venue_id, p0, p1),
    ).fetchall()
    prev = {norm(x["categoria"]): f(x["ventas"]) for x in prev_rows}
    tgt = targets()
    total = sum(f(x["ventas"]) for x in rows) or 1

    out = []
    for x in rows:
        v, c = f(x["ventas"]), f(x["cmv"])
        key = norm(x["categoria"])
        t = tgt.get(key)
        pv = prev.get(key, 0.0)
        out.append(
            {
                "categoria": x["categoria"],
                "ventas": r(v),
                "cmv": r(c),
                "cmv_pct": r(c / v * 100, 1) if v else 0,
                "cantidad": r(x["cantidad"], 0),
                "participacion": r(v / total * 100, 1),
                "objetivo": {"min": t[0], "max": t[1]} if t else None,
                "estado_cmv": (
                    "sobre" if t and v and c / v * 100 > t[1]
                    else "bajo" if t and v and c / v * 100 < t[0]
                    else "ok" if t else "sin objetivo"
                ),
                "anterior": r(pv),
                "delta_pct": r((v - pv) / pv * 100, 1) if pv else None,
            }
        )
    return out


def daily(conn, venue_id: int, d0: date, d1: date) -> list[dict]:
    rows = conn.execute(
        """
        SELECT s.business_date AS fecha,
               SUM(CASE WHEN s.channel <> 'delivery' THEN si.line_total ELSE 0 END) AS menu,
               SUM(CASE WHEN s.channel  = 'delivery' THEN si.line_total ELSE 0 END) AS delivery,
               SUM(CASE WHEN s.channel <> 'delivery' THEN si.line_cost ELSE 0 END) AS cmv
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
         WHERE s.venue_id = %s AND s.state = 'CLOSED' AND si.canceled = false
           AND s.business_date BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 1
        """,
        (venue_id, d0, d1),
    ).fetchall()
    by_date = {r["fecha"]: r for r in rows}
    out = []
    d = d0
    while d <= d1:
        row = by_date.get(d)
        if row:
            m, dl, c = f(row["menu"]), f(row["delivery"]), f(row["cmv"])
            out.append({"fecha": d.isoformat(), "menu": r(m), "delivery": r(dl), "total": r(m + dl),
                        "cmv_pct": r(c / m * 100, 1) if m else 0})
        else:
            out.append({"fecha": d.isoformat(), "menu": 0, "delivery": 0, "total": 0, "cmv_pct": 0})
        d += timedelta(days=1)
    return out


def expenses_detail(conn, venue_id: int, d0: date, d1: date) -> dict:
    exp = _expenses(conn, venue_id, d0, d1)
    rows = conn.execute(
        """
        SELECT COALESCE(category_name, 'Sin categoría') AS categoria,
               SUM(amount) AS total, COUNT(*) AS n
          FROM expenses
         WHERE venue_id = %s AND expense_date BETWEEN %s AND %s
           AND source = (SELECT source FROM expenses WHERE venue_id = %s AND expense_date BETWEEN %s AND %s
                         ORDER BY CASE source WHEN 'sheet' THEN 1 WHEN 'fudo' THEN 2 ELSE 3 END LIMIT 1)
         GROUP BY 1 ORDER BY 2 DESC
        """,
        (venue_id, d0, d1, venue_id, d0, d1),
    ).fetchall()
    total = sum(f(x["total"]) for x in rows) or 1
    return {
        **exp,
        "categorias": [
            {"categoria": x["categoria"], "total": r(x["total"]), "n": int(x["n"]),
             "participacion": r(f(x["total"]) / total * 100, 1)}
            for x in rows
        ],
    }


# ------------------------------------------------------------------ revisión


def _finding(id_, nivel, tipo, titulo, detalle, accion, items=None, peso=0.0) -> dict:
    return {"id": id_, "nivel": nivel, "tipo": tipo, "titulo": titulo, "detalle": detalle,
            "accion": accion, "items": items or [], "peso": r(peso, 1)}


def _plural(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def review(conn, venue_id: int, d0: date, d1: date) -> dict:
    critico: list[dict] = []
    atencion: list[dict] = []
    info: list[dict] = []

    cur = _totals(conn, venue_id, d0, d1)
    p0, p1 = previous_range(d0, d1)
    prev = _totals(conn, venue_id, p0, p1)
    exp_cur = _expenses(conn, venue_id, d0, d1)
    exp_prev = _expenses(conn, venue_id, p0, p1)

    # 1. productos de menú vendidos sin costo
    rows = conn.execute(
        """
        SELECT p.name AS producto, SUM(si.line_total) AS ventas, SUM(si.quantity) AS cantidad
          FROM sales s
          JOIN sale_items si ON si.sale_id = s.id
          JOIN products p ON p.id = si.product_id
         WHERE s.venue_id = %s AND s.state = 'CLOSED' AND si.canceled = false
           AND s.channel <> 'delivery'
           AND s.business_date BETWEEN %s AND %s
           AND COALESCE(p.cost, 0) = 0
           AND LOWER(p.name) NOT IN ('envio', 'envío', 'pedidos ya', 'uber eats', 'delivery', 'rappi')
         GROUP BY 1 HAVING SUM(si.line_total) > 0
         ORDER BY 2 DESC LIMIT 12
        """,
        (venue_id, d0, d1),
    ).fetchall()
    if rows:
        pes = sum(f(x["ventas"]) for x in rows)
        share = (pes / cur["ventas_menu"] * 100) if cur["ventas_menu"] else 0
        critico.append(
            _finding(
                "sin-costeo", "critico", "costos",
                f"{_plural(len(rows), 'producto sin costo', 'productos sin costo')}",
                f"Se vendieron ${pes:,.0f} sin costo cargado ({share:.1f} % de las ventas de menú).",
                "Cargar la receta o el costo en Fudo (o un costo de respaldo).",
                [f"{x['producto']} · ${f(x['ventas']):,.0f} ({f(x['cantidad']):.0f} u.)" for x in rows],
                share,
            )
        )

    # 2. gastos duplicados
    rows = conn.execute(
        """
        SELECT expense_date, amount, COUNT(*) AS n, MIN(description) AS d
          FROM expenses
         WHERE venue_id = %s AND source = 'sheet' AND expense_date BETWEEN %s AND %s
         GROUP BY 1, 2 HAVING COUNT(*) > 1
         ORDER BY 2 DESC LIMIT 8
        """,
        (venue_id, d0, d1),
    ).fetchall()
    if rows:
        atencion.append(
            _finding(
                "duplicados", "atencion", "gastos",
                f"{_plural(len(rows), 'posible gasto duplicado', 'posibles gastos duplicados')}",
                "Mismo día e importe repetido. Puede ser un duplicado real o dos compras iguales.",
                "Revisar en la planilla y borrar el duplicado.",
                [f"{x['expense_date']} · ${f(x['amount']):,.0f} · {x['n']} veces" for x in rows],
            )
        )

    # 3. cierre mensual vs ventas
    month_start = d1.replace(day=1)
    month_end = (month_start + timedelta(days=32)).replace(day=1) - timedelta(days=1)
    close = conn.execute(
        "SELECT ventas FROM monthly_closes WHERE venue_id = %s AND month_key = %s",
        (venue_id, month_start.strftime("%Y-%m")),
    ).fetchone()
    if close:
        month_tot = _totals(conn, venue_id, month_start, month_end)
        diff = float(close["ventas"] or 0) - month_tot["ventas"]
        pct = (diff / float(close["ventas"]) * 100) if close["ventas"] else 0
        if abs(pct) > 2:
            critico.append(
                _finding(
                    "cierre", "critico", "cierres",
                    "El cierre mensual no coincide con las ventas",
                    f"Cierre cargado ${float(close['ventas']):,.0f} · ventas del sistema "
                    f"${month_tot['ventas']:,.0f} ({pct:+.1f} %).",
                    "Revisar el cierre o la importación de ventas del mes.",
                )
            )

    # 4. caída de ventas
    if prev["ventas"] and cur["ventas"] < prev["ventas"] * 0.85:
        pct = (cur["ventas"] - prev["ventas"]) / prev["ventas"] * 100
        critico.append(
            _finding(
                "caida-ventas", "critico", "ventas",
                f"Las ventas cayeron {abs(pct):.0f} %",
                f"${cur['ventas']:,.0f} contra ${prev['ventas']:,.0f} del período anterior.",
                "Revisar días flojos, faltantes de stock o cambios de carta.",
                peso=pct,
            )
        )

    # 5. caída de gastos (sospechosa)
    if exp_prev["total"] and exp_cur["total"] < exp_prev["total"] * 0.7:
        pct = (exp_cur["total"] - exp_prev["total"]) / exp_prev["total"] * 100
        atencion.append(
            _finding(
                "gastos-caen", "atencion", "gastos",
                f"Los gastos cayeron {abs(pct):.0f} %",
                f"${exp_cur['total']:,.0f} contra ${exp_prev['total']:,.0f} del período anterior. "
                "Una caída así suele ser un gasto sin cargar, no un ahorro.",
                "Revisar alquiler, sueldos, servicios y proveedores fijos del período.",
                peso=pct,
            )
        )

    # 6. CMV por categoría sobre el objetivo
    cats = categories(conn, venue_id, d0, d1)
    sobre = [c for c in cats if c["objetivo"] and c["estado_cmv"] == "sobre" and c["ventas"] > 1000]
    if sobre:
        atencion.append(
            _finding(
                "cmv-objetivo", "atencion", "cmv",
                f"{_plural(len(sobre), 'categoría', 'categorías')} con CMV sobre el objetivo",
                "El costo de mercadería supera el rango definido para esas categorías.",
                "Revisar precios de venta o costos de receta.",
                [f"{c['categoria']} · CMV {c['cmv_pct']:.1f} % (objetivo {c['objetivo']['min']:.0f}–{c['objetivo']['max']:.0f} %)"
                 for c in sobre],
            )
        )

    # 6. aumentos de insumos
    rows = conn.execute(
        """
        WITH x AS (
            SELECT ingredient_id, expense_date, unit_price,
                   ROW_NUMBER() OVER (PARTITION BY ingredient_id ORDER BY expense_date) AS rn_first,
                   ROW_NUMBER() OVER (PARTITION BY ingredient_id ORDER BY expense_date DESC) AS rn_last
              FROM v_ingredient_prices
             WHERE venue_id = %s AND expense_date BETWEEN %s AND %s
        )
        SELECT i.name AS insumo, f.unit_price AS primero, l.unit_price AS ultimo,
               f.expense_date AS desde, l.expense_date AS hasta
          FROM x f
          JOIN x l ON l.ingredient_id = f.ingredient_id AND l.rn_last = 1
          JOIN ingredients i ON i.id = f.ingredient_id
         WHERE f.rn_first = 1 AND f.expense_date < l.expense_date
           AND f.unit_price > 0 AND l.unit_price > f.unit_price * 1.1
         ORDER BY (l.unit_price - f.unit_price) / f.unit_price DESC
         LIMIT 10
        """,
        (venue_id, d0, d1),
    ).fetchall()
    if rows:
        atencion.append(
            _finding(
                "insumos", "atencion", "precios",
                f"{_plural(len(rows), 'insumo aumentó', 'insumos aumentaron')} más de 10 %",
                "Comparación entre la primera y la última compra del período.",
                "Actualizar precios de venta o buscar alternativa de proveedor.",
                [f"{x['insumo']} · ${f(x['primero']):,.0f} → ${f(x['ultimo']):,.0f} "
                 f"({(f(x['ultimo'])/f(x['primero'])-1)*100:+.0f} %)" for x in rows],
            )
        )

    # 7. categorías que caen
    caen = [c for c in cats if c["delta_pct"] is not None and c["delta_pct"] < -15 and c["ventas"] > 2000]
    if caen:
        atencion.append(
            _finding(
                "categorias-caen", "atencion", "ventas",
                f"{_plural(len(caen), 'categoría cae', 'categorías caen')} más de 15 %",
                "Comparado con el período anterior equivalente.",
                "Revisar surtido, precios o visibilidad de esas categorías.",
                [f"{c['categoria']} · ${c['ventas']:,.0f} ({c['delta_pct']:+.0f} %)" for c in caen],
            )
        )

    # 8. categorías que suben (info)
    suben = [c for c in cats if c["delta_pct"] is not None and c["delta_pct"] > 10 and c["ventas"] > 2000]
    if suben:
        info.append(
            _finding(
                "categorias-suben", "info", "ventas",
                f"{_plural(len(suben), 'categoría crece', 'categorías crecen')} más de 10 %",
                "Buen desempeño contra el período anterior.",
                "Mantener el surtido y revisar si conviene ampliar.",
                [f"{c['categoria']} · ${c['ventas']:,.0f} ({c['delta_pct']:+.0f} %)" for c in suben],
            )
        )

    # 10. delivery como dato informativo (sin costo)
    if cur["ventas_delivery"]:
        share = cur["ventas_delivery"] / cur["ventas"] * 100 if cur["ventas"] else 0
        info.append(
            _finding(
                "canal-delivery", "info", "canal",
                f"Delivery: {share:.0f} % de las ventas",
                f"${cur['ventas_delivery']:,.0f} por apps, sin costo de mercadería asignado.",
                "Cuando estén ordenados los productos comodín, el canal se costea solo.",
            )
        )

    return {
        "critico": critico,
        "atencion": atencion,
        "info": info,
        "resumen": {"critico": len(critico), "atencion": len(atencion), "info": len(info)},
    }


# ------------------------------------------------------------------ meta


def meta(conn, venue_id: int) -> dict:
    venue = conn.execute("SELECT name FROM venues WHERE id = %s", (venue_id,)).fetchone()
    meses = conn.execute(
        """
        SELECT DISTINCT to_char(business_date, 'YYYY-MM') AS m FROM sales WHERE venue_id = %s
        UNION
        SELECT DISTINCT to_char(expense_date, 'YYYY-MM') FROM expenses WHERE venue_id = %s
        ORDER BY 1 DESC
        """,
        (venue_id, venue_id),
    ).fetchall()
    last = conn.execute(
        "SELECT kind, status, finished_at FROM sync_runs WHERE venue_id = %s ORDER BY id DESC LIMIT 1",
        (venue_id,),
    ).fetchone()
    return {
        "local": venue["name"] if venue else "Mi local",
        "meses": [x["m"] for x in meses if x["m"]],
        "ultima_sync": {
            "tipo": last["kind"], "estado": last["status"],
            "cuando": last["finished_at"].isoformat() if last and last["finished_at"] else None,
        } if last else None,
        "hoy": date.today().isoformat(),
    }


def dashboard(conn, venue_id: int, d0: date, d1: date) -> dict:
    return {
        "meta": meta(conn, venue_id),
        "summary": summary(conn, venue_id, d0, d1),
        "categories": categories(conn, venue_id, d0, d1),
        "daily": daily(conn, venue_id, d0, d1),
        "expenses": expenses_detail(conn, venue_id, d0, d1),
        "review": review(conn, venue_id, d0, d1),
    }
