"""Consultas del portal web sobre Postgres (Neon).

Devuelve la misma información que necesita el dashboard de clientes:
resumen del período, comparación, categorías, serie diaria, gastos y revisión.

Reglas:
- Ventas de menú = todo menos el canal delivery (las apps se muestran aparte).
- CMV se calcula sobre el menú.
- Gastos: si el período tiene planilla, manda la planilla; si no, Fudo.
"""

from __future__ import annotations

import calendar
import unicodedata
from datetime import date, datetime, timedelta, timezone

from app.config import load_config

# Argentina no usa horario de verano: UTC-3 fijo. Render corre en UTC.
ART = timezone(timedelta(hours=-3))


def today_ar() -> date:
    return datetime.now(ART).date()

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
    ext = _external_totals(conn, venue_id, d0, d1)
    prev_ext = _external_totals(conn, venue_id, p0, p1)
    gastos_total = r(exp["total"] + ext["excepcional"] + ext["fijo"])
    prev_gastos_total = r(prev_exp["total"] + prev_ext["excepcional"] + prev_ext["fijo"])

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
            "gastos": gastos_total,
            "gastos_fudo": exp["total"],
            "gastos_fudo_fuente": exp["fuente"],
            "gastos_externos": ext["excepcional"],
            "gastos_fijos": ext["fijo"],
            "resultado": r(cur["ganancia"] - gastos_total),
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
            "gastos_pct": pct(gastos_total, prev_gastos_total),
            "ganancia_pct": pct(cur["ganancia"], prev["ganancia"]),
            "cmv_pp": r(cur["cmv_pct"] - prev["cmv_pct"], 1),
            "anterior": {
                "ventas": prev["ventas"],
                "ventas_menu": prev["ventas_menu"],
                "ventas_delivery": prev["ventas_delivery"],
                "gastos": prev_gastos_total,
                "cmv_pct": prev["cmv_pct"],
                "ganancia": prev["ganancia"],
            },
        },
    }


def categories(conn, venue_id: int, d0: date, d1: date, with_products: bool = False) -> list[dict]:
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

    productos: dict[str, list[dict]] = {}
    if with_products:
        prod_rows = conn.execute(
            """
            SELECT COALESCE(c.name, 'Sin categoría') AS categoria,
                   COALESCE(p.name, 'Sin producto') AS producto,
                   SUM(si.quantity) AS cantidad,
                   SUM(si.line_total) AS ventas
              FROM sales s
              JOIN sale_items si ON si.sale_id = s.id
              LEFT JOIN products p ON p.id = si.product_id
              LEFT JOIN product_categories c ON c.id = p.category_id
             WHERE s.venue_id = %s AND s.state = 'CLOSED' AND si.canceled = false
               AND s.channel <> 'delivery'
               AND s.business_date BETWEEN %s AND %s
             GROUP BY 1, 2
             ORDER BY 3 DESC, 4 DESC
            """,
            (venue_id, d0, d1),
        ).fetchall()
        for x in prod_rows:
            lst = productos.setdefault(x["categoria"], [])
            if len(lst) < 10:
                lst.append({"producto": x["producto"], "cantidad": r(x["cantidad"], 0), "ventas": r(x["ventas"])})

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
                "productos": productos.get(x["categoria"], []),
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
        "SELECT kind, status, finished_at FROM sync_runs WHERE venue_id = %s AND finished_at IS NOT NULL "
        "ORDER BY id DESC LIMIT 1",
        (venue_id,),
    ).fetchone()
    return {
        "local": venue["name"] if venue else "Mi local",
        "meses": [x["m"] for x in meses if x["m"]],
        "ultima_sync": {
            "tipo": last["kind"], "estado": last["status"],
            "cuando": last["finished_at"].isoformat() if last and last["finished_at"] else None,
        } if last else None,
        "hoy": today_ar().isoformat(),
    }


def dashboard(conn, venue_id: int, d0: date, d1: date) -> dict:
    ensure_external_schema(conn)
    return {
        "meta": meta(conn, venue_id),
        "summary": summary(conn, venue_id, d0, d1),
        "progress": progress(conn, venue_id, d0, d1),
        "categories": categories(conn, venue_id, d0, d1, with_products=True),
        "daily": daily(conn, venue_id, d0, d1),
        "expenses": expenses_detail(conn, venue_id, d0, d1),
        "cross": expenses_cross(conn, venue_id),
        "external": external_list(conn, venue_id, d0, d1),
        "review": review(conn, venue_id, d0, d1),
    }


# ------------------------------------------------------------------ gastos externos
# Gastos que no pasan por Fudo y se cargan en GesT:
#   fijo        -> se repite (alquiler, sueldos...); se prorratea por día en cada período
#   excepcional -> un gasto puntual en una fecha

EXTERNAL_DDL = """
CREATE TABLE IF NOT EXISTS external_expenses (
    id           bigserial PRIMARY KEY,
    venue_id     bigint NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
    kind         text NOT NULL CHECK (kind IN ('fijo', 'excepcional')),
    name         text NOT NULL,
    amount       numeric(12,2) NOT NULL CHECK (amount >= 0),
    expense_date date,
    frequency    text,
    start_date   date,
    end_date     date,
    created_at   timestamptz NOT NULL DEFAULT now()
)
"""
EXTERNAL_INDEX = (
    "CREATE INDEX IF NOT EXISTS external_expenses_ix ON external_expenses (venue_id, kind, expense_date)"
)
_external_ready = False


def ensure_external_schema(conn) -> None:
    """Crea la tabla si falta (el servidor no corre el esquema completo)."""
    global _external_ready
    if _external_ready:
        return
    conn.execute(EXTERNAL_DDL)
    conn.execute(EXTERNAL_INDEX)
    conn.commit()
    _external_ready = True


def _daily_rate(row: dict, day: date) -> float:
    amount = f(row["amount"])
    if row["frequency"] == "semanal":
        return amount / 7
    return amount / calendar.monthrange(day.year, day.month)[1]


def _external_totals(conn, venue_id: int, d0: date, d1: date) -> dict:
    ensure_external_schema(conn)
    rows = conn.execute(
        """
        SELECT kind, amount, expense_date, frequency, start_date, end_date
          FROM external_expenses
         WHERE venue_id = %s
           AND ((kind = 'excepcional' AND expense_date BETWEEN %s AND %s)
             OR (kind = 'fijo'))
        """,
        (venue_id, d0, d1),
    ).fetchall()
    exc = 0.0
    fijo = 0.0
    for row in rows:
        if row["kind"] == "excepcional":
            exc += f(row["amount"])
            continue
        a = max(d0, row["start_date"] or d0)
        b = min(d1, row["end_date"] or d1)
        day = a
        while day <= b:
            fijo += _daily_rate(row, day)
            day += timedelta(days=1)
    return {"excepcional": r(exc), "fijo": r(fijo)}


def external_list(conn, venue_id: int, d0: date, d1: date) -> dict:
    ensure_external_schema(conn)
    today = today_ar()
    fijos = conn.execute(
        """
        SELECT id, name, amount, frequency, start_date, end_date
          FROM external_expenses
         WHERE venue_id = %s AND kind = 'fijo' AND (end_date IS NULL OR end_date >= %s)
         ORDER BY amount DESC
        """,
        (venue_id, today),
    ).fetchall()
    exc = conn.execute(
        """
        SELECT id, name, amount, expense_date
          FROM external_expenses
         WHERE venue_id = %s AND kind = 'excepcional' AND expense_date BETWEEN %s AND %s
         ORDER BY expense_date DESC, id DESC
        """,
        (venue_id, d0, d1),
    ).fetchall()
    return {
        "fijos": [
            {"id": x["id"], "nombre": x["name"], "monto": r(x["amount"]), "frecuencia": x["frequency"] or "mensual",
             "desde": x["start_date"].isoformat() if x["start_date"] else None}
            for x in fijos
        ],
        "excepcionales": [
            {"id": x["id"], "nombre": x["name"], "monto": r(x["amount"]), "fecha": x["expense_date"].isoformat()}
            for x in exc
        ],
    }


def external_add(conn, venue_id: int, data: dict) -> int:
    ensure_external_schema(conn)
    kind = str(data.get("tipo") or "").strip()
    if kind not in ("fijo", "excepcional"):
        raise ValueError("tipo debe ser fijo o excepcional")
    name = str(data.get("nombre") or "").strip()
    if not name or len(name) > 80:
        raise ValueError("el nombre es obligatorio (máx. 80 caracteres)")
    try:
        amount = float(str(data.get("monto")).replace(",", "."))
    except ValueError:
        raise ValueError("monto inválido") from None
    if not (0 < amount < 1e9):
        raise ValueError("el monto debe ser mayor a 0")

    def d(key):
        v = str(data.get(key) or "").strip()
        return date.fromisoformat(v) if v else None

    if kind == "excepcional":
        row = conn.execute(
            "INSERT INTO external_expenses (venue_id, kind, name, amount, expense_date) "
            "VALUES (%s, 'excepcional', %s, %s, %s) RETURNING id",
            (venue_id, name, amount, d("fecha") or today_ar()),
        ).fetchone()
    else:
        freq = str(data.get("frecuencia") or "mensual")
        if freq not in ("mensual", "semanal"):
            raise ValueError("frecuencia debe ser mensual o semanal")
        # por defecto cuenta desde el 1 del mes actual, así no altera meses cerrados
        start = d("fecha") or today_ar().replace(day=1)
        row = conn.execute(
            "INSERT INTO external_expenses (venue_id, kind, name, amount, frequency, start_date) "
            "VALUES (%s, 'fijo', %s, %s, %s, %s) RETURNING id",
            (venue_id, name, amount, freq, start),
        ).fetchone()
    return row["id"]


def external_remove(conn, venue_id: int, ext_id: int) -> bool:
    """Excepcional: se borra. Fijo: se da de baja (queda en el historial pasado)."""
    ensure_external_schema(conn)
    row = conn.execute(
        "SELECT kind, start_date FROM external_expenses WHERE id = %s AND venue_id = %s", (ext_id, venue_id)
    ).fetchone()
    if not row:
        return False
    yesterday = today_ar() - timedelta(days=1)
    if row["kind"] == "fijo" and row["start_date"] and row["start_date"] <= yesterday:
        conn.execute("UPDATE external_expenses SET end_date = %s WHERE id = %s", (yesterday, ext_id))
    else:
        conn.execute("DELETE FROM external_expenses WHERE id = %s", (ext_id,))
    return True


# ------------------------------------------------------------------ progreso y cruce


def progress(conn, venue_id: int, d0: date, d1: date) -> dict | None:
    """Avance del período en curso y ritmo de ventas contra el período anterior."""
    today = today_ar()
    if not (d0 <= today <= d1):
        return None
    total_days = (d1 - d0).days + 1
    elapsed = (today - d0).days + 1
    p0, p1 = previous_range(d0, d1)
    same_end = min(p1, p0 + timedelta(days=elapsed - 1))
    cur = _totals(conn, venue_id, d0, today)
    prev_same = _totals(conn, venue_id, p0, same_end)
    prev_full = _totals(conn, venue_id, p0, p1)

    ritmo = r((cur["ventas"] - prev_same["ventas"]) / prev_same["ventas"] * 100, 1) if prev_same["ventas"] else None
    if ritmo is None:
        nivel, label = "neutral", "Sin período anterior para comparar"
    elif ritmo >= 5:
        nivel, label = "good", "Por encima del ritmo anterior"
    elif ritmo >= -5:
        nivel, label = "good", "En línea con el período anterior"
    elif ritmo >= -15:
        nivel, label = "warn", "Algo por debajo del período anterior"
    else:
        nivel, label = "bad", "Por debajo del período anterior"
    return {
        "dias_total": total_days,
        "dias_transcurridos": elapsed,
        "pct_tiempo": r(elapsed / total_days * 100, 0),
        "ventas_acumuladas": cur["ventas"],
        "ventas_anterior_mismos_dias": prev_same["ventas"],
        "ventas_anterior_total": prev_full["ventas"],
        "pct_vs_anterior_total": r(cur["ventas"] / prev_full["ventas"] * 100, 0) if prev_full["ventas"] else None,
        "proyeccion": r(cur["ventas"] / elapsed * total_days, 0),
        "ritmo_pct": ritmo,
        "nivel": nivel,
        "estado": label,
        "anterior": {"desde": p0.isoformat(), "hasta": p1.isoformat(), "etiqueta": label_period(p0, p1)},
    }


def expenses_cross(conn, venue_id: int, months: int = 6) -> list[dict]:
    """Por mes: gastos de Fudo vs. los de la planilla, más los externos cargados en GesT."""
    today = today_ar()
    first = today.replace(day=1)
    for _ in range(months - 1):
        first = (first - timedelta(days=1)).replace(day=1)
    rows = conn.execute(
        """
        SELECT to_char(expense_date, 'YYYY-MM') AS m, source, SUM(amount) AS t
          FROM expenses
         WHERE venue_id = %s AND source IN ('fudo', 'sheet') AND expense_date >= %s
         GROUP BY 1, 2
        """,
        (venue_id, first),
    ).fetchall()
    by = {(x["m"], x["source"]): f(x["t"]) for x in rows}
    out = []
    cursor = today.replace(day=1)
    for _ in range(months):
        key = cursor.strftime("%Y-%m")
        end = min(today, cursor.replace(day=calendar.monthrange(cursor.year, cursor.month)[1]))
        ext = _external_totals(conn, venue_id, cursor, end)
        fudo, sheet = by.get((key, "fudo"), 0.0), by.get((key, "sheet"), 0.0)
        out.append(
            {
                "mes": key,
                "etiqueta": f"{MESES[cursor.month - 1].capitalize()} {cursor.year}",
                "fudo": r(fudo),
                "planilla": r(sheet),
                "diferencia": r(sheet - fudo) if fudo and sheet else None,
                "externos": r(ext["excepcional"] + ext["fijo"]),
            }
        )
        cursor = (cursor - timedelta(days=1)).replace(day=1)
    return out


# ------------------------------------------------------------------ sync Fudo en vivo y hot-patch
import importlib as _importlib
import json as _json
import os as _os
import sys as _sys
import threading as _threading
import urllib.request as _urlreq
from pathlib import Path as _Path
from urllib.parse import urlparse as _urlparse

from . import db as _db_mod

_fudo_sync_lock = getattr(_db_mod, "_fudo_sync_lock", None) or _threading.Lock()
_db_mod._fudo_sync_lock = _fudo_sync_lock


def _resolve_sync_range(payload: dict, default_days: int = 10) -> tuple[date, date]:
    today = today_ar()
    days = max(1, min(62, int(payload.get("days") or default_days)))
    d1 = today
    d0 = today - timedelta(days=days)
    try:
        if payload.get("from"):
            req_d0 = date.fromisoformat(str(payload["from"])[:10])
            d0 = min(d0, req_d0)
        if payload.get("to"):
            req_d1 = date.fromisoformat(str(payload["to"])[:10])
            d1 = max(d1, min(today, req_d1))
    except ValueError:
        pass
    if d0 > d1:
        d0, d1 = d1, d0
    if (d1 - d0).days > 62:
        d0 = d1 - timedelta(days=62)
    return d0, d1


def sync_fudo_live(payload: dict | None = None, days: int = 10) -> dict:
    """Sincroniza ventas y gastos de Fudo hacia Postgres desde el servidor web."""
    from . import db as _db, ingest as _ingest, recompute as _recompute

    # Si ingest.py en el contenedor era de una versión previa sin _CATALOG_CACHE, lo actualiza en caliente
    if not hasattr(_ingest, "_CATALOG_CACHE"):
        try:
            repo = _os.environ.get("GITHUB_REPO", "CodeHvrd/GesT-System")
            branch = _os.environ.get("GITHUB_BRANCH", "main")
            raw_url = f"https://raw.githubusercontent.com/{repo}/{branch}/cloud/ingest.py"
            req = _urlreq.Request(raw_url, headers={"User-Agent": "gest-system"})
            with _urlreq.urlopen(req, timeout=10) as resp:
                content = resp.read()
            dest = (_Path(__file__).resolve().parent / "ingest.py").resolve()
            if content:
                dest.write_bytes(content)
                _importlib.reload(_ingest)
        except Exception:  # noqa: BLE001
            pass

    payload = payload or {}
    api_key = str(payload.get("api_key") or "").strip()
    api_secret = str(payload.get("api_secret") or "").strip()

    if not _fudo_sync_lock.acquire(timeout=30):
        return {"ok": False, "error": "Ya hay una sincronización en curso. Esperá unos segundos."}
    try:
        d0, d1 = _resolve_sync_range(payload, days)
        with _db.connect() as pg:
            vid = _db.ensure_venue(pg, "bois")
            if api_key and api_secret and hasattr(_ingest, "save_credentials"):
                _ingest.save_credentials(pg, vid, api_key, api_secret)
                pg.commit()
            try:
                client = _ingest.client_from_env(pg, vid)
            except TypeError:
                client = _ingest.client_from_env()
            except SystemExit:
                return {
                    "ok": False,
                    "needs_credentials": True,
                    "error": "Faltan las credenciales de Fudo (API Key y API Secret).",
                }
            ventas = _ingest.sync_sales(pg, vid, client, d0, d1)
            pg.commit()
            try:
                gastos = _ingest.sync_expenses(pg, vid, client, d0, d1)
                pg.commit()
            except Exception as exc:  # noqa: BLE001
                pg.rollback()
                gastos = {"status": "error", "error": str(exc)}
            agregados = _recompute.recompute(pg, vid)
            pg.commit()
        return {
            "ok": True,
            "data": {
                "rango": f"{d0.isoformat()} → {d1.isoformat()}",
                "ventas": ventas,
                "gastos": gastos,
                "agregados": agregados,
            },
        }
    finally:
        _fudo_sync_lock.release()


def _patch_live_handler() -> None:
    """Inyecta /api/sync en el Handler en ejecución cuando se recarga analytics_pg en caliente."""
    try:
        from . import ingest as _ing_mod, recompute as _rec_mod
        _importlib.reload(_ing_mod)
        _importlib.reload(_rec_mod)
    except Exception:  # noqa: BLE001
        pass
    for mod in list(_sys.modules.values()):
        cls = getattr(mod, "Handler", None)
        if cls is None or not hasattr(cls, "do_POST"):
            continue
        orig_post = getattr(cls, "_orig_do_post", cls.do_POST)
        cls._orig_do_post = orig_post

        def _patched_do_post(self, _orig=orig_post):
            if _urlparse(self.path).path == "/api/sync":
                if not self._write_guard():
                    return
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    body = _json.loads(self.rfile.read(length).decode("utf-8")) if 0 < length <= 10_000 else {}
                    res = sync_fudo_live(body if isinstance(body, dict) else {})
                    status = 200 if res.get("ok") else (428 if res.get("needs_credentials") else 400)
                    self._json(res, status)
                except Exception as exc:  # noqa: BLE001
                    self._error(500, f"error sincronizando Fudo: {exc}")
                return
            return _orig(self)

        cls.do_POST = _patched_do_post


_patch_live_handler()
