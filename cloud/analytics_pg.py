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

try:
    from app.config import load_config
except ImportError:
    from legacy.app.config import load_config

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


def _norm_provider(name: str) -> str:
    """Normaliza nombres de proveedor para cruzar Planilla vs Fudo API."""
    t = norm(name)
    for drop in ("carniceria", "frigorifico", "distribuidora", "srl", "sa", "s.a.", "proveedor"):
        t = t.replace(drop, " ")
    return "".join(t.split())


def _totals(conn, venue_id: int, d0: date, d1: date) -> dict:
    row = conn.execute(
        """
        SELECT COALESCE(SUM(CASE WHEN s.channel = 'salon'    THEN si.line_total ELSE 0 END), 0) AS salon_ventas,
               COALESCE(SUM(CASE WHEN s.channel = 'takeaway' THEN si.line_total ELSE 0 END), 0) AS takeaway_ventas,
               COALESCE(SUM(CASE WHEN s.channel = 'delivery' THEN si.line_total ELSE 0 END), 0) AS apps_ventas,
               COALESCE(SUM(CASE WHEN s.channel <> 'delivery' THEN si.line_total ELSE 0 END), 0) AS menu_ventas,
               COALESCE(SUM(CASE WHEN s.channel <> 'delivery' THEN si.line_cost  ELSE 0 END), 0) AS menu_cmv,
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

    pay_row = conn.execute(
        """
        SELECT COALESCE(SUM(COALESCE(cash_amount, 0)), 0) AS efectivo,
               COALESCE(SUM(COALESCE(virtual_amount, 0)), 0) AS virtual_amt,
               COALESCE(SUM(total), 0) AS sale_total
          FROM sales
         WHERE venue_id = %s
           AND state = 'CLOSED'
           AND business_date BETWEEN %s AND %s
        """,
        (venue_id, d0, d1),
    ).fetchone()

    pm_rows = conn.execute(
        """
        SELECT m.key AS metodo, SUM((m.value)::numeric) AS monto
          FROM sales s,
               LATERAL jsonb_each_text(COALESCE(s.payload->'payments_summary'->'methods', '{}'::jsonb)) AS m
         WHERE s.venue_id = %s
           AND s.state = 'CLOSED'
           AND s.business_date BETWEEN %s AND %s
         GROUP BY 1
         ORDER BY 2 DESC
        """,
        (venue_id, d0, d1),
    ).fetchall()

    ventas_tot = f(row["ventas"])
    salon_v = f(row["salon_ventas"])
    takeaway_v = f(row["takeaway_ventas"])
    apps_v = f(row["apps_ventas"])
    delivery_total_v = takeaway_v + apps_v
    menu_v, menu_c = f(row["menu_ventas"]), f(row["menu_cmv"])

    efectivo_v = f(pay_row["efectivo"])
    virtual_v = f(pay_row["virtual_amt"])
    pay_sum = efectivo_v + virtual_v
    # Si las ventas se mide por suma de ítems, escalamos proporcionalmente para que sume igual que ventas_tot
    if pay_sum > 0 and ventas_tot > 0 and abs(pay_sum - ventas_tot) > 1:
        scale = ventas_tot / pay_sum
        efectivo_v *= scale
        virtual_v *= scale
    elif pay_sum == 0 and ventas_tot > 0:
        virtual_v = apps_v
        efectivo_v = max(0.0, ventas_tot - virtual_v)

    pm_total = sum(f(x["monto"]) for x in pm_rows) or 1.0
    medios_pago = []
    for x in pm_rows:
        m_name = str(x["metodo"] or "Otro")
        m_val = f(x["monto"])
        is_cash = "efectivo" in m_name.lower() or m_name.lower() == "cash"
        medios_pago.append({
            "metodo": m_name,
            "monto": r(m_val),
            "pct": r(m_val / pm_total * 100, 1),
            "tipo": "efectivo" if is_cash else "virtual",
        })

    return {
        "ventas": r(ventas_tot),
        "ventas_salon": r(salon_v),
        "ventas_delivery": r(delivery_total_v),
        "ventas_delivery_propio": r(takeaway_v),
        "ventas_delivery_apps": r(apps_v),
        "ventas_menu": r(menu_v),
        "salon_pct": r(salon_v / ventas_tot * 100, 1) if ventas_tot else 0.0,
        "delivery_pct": r(delivery_total_v / ventas_tot * 100, 1) if ventas_tot else 0.0,
        "efectivo": r(efectivo_v),
        "virtual": r(virtual_v),
        "efectivo_pct": r(efectivo_v / (efectivo_v + virtual_v) * 100, 1) if (efectivo_v + virtual_v) else 0.0,
        "virtual_pct": r(virtual_v / (efectivo_v + virtual_v) * 100, 1) if (efectivo_v + virtual_v) else 0.0,
        "medios_pago": medios_pago,
        "cmv": r(menu_c),
        "cmv_pct": r(menu_c / menu_v * 100, 1) if menu_v else 0.0,
        "ganancia": r(menu_v - menu_c),
        "ventas_n": int(row["ventas_n"] or 0),
        "ticket": r(ventas_tot / row["ventas_n"], 0) if row["ventas_n"] else 0,
    }


def _expenses(conn, venue_id: int, d0: date, d1: date) -> dict:
    row = conn.execute(
        """
        SELECT COALESCE(SUM(CASE WHEN source = 'fudo' THEN amount ELSE 0 END), 0) AS fudo_api,
               COUNT(*) FILTER (WHERE source = 'fudo') AS fudo_n,
               COALESCE(SUM(CASE WHEN source = 'sheet' AND LOWER(COALESCE(category_name, '')) LIKE 'reposic%%'
                                 THEN amount ELSE 0 END), 0) AS sheet_repo,
               COUNT(*) FILTER (WHERE source = 'sheet' AND LOWER(COALESCE(category_name, '')) LIKE 'reposic%%') AS sheet_repo_n,
               COALESCE(SUM(CASE WHEN source = 'sheet' AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
                                  AND LOWER(COALESCE(payload->>'tipo', 'variable')) <> 'fijo'
                                 THEN amount ELSE 0 END), 0) AS sheet_ext_var,
               COUNT(*) FILTER (WHERE source = 'sheet' AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
                                  AND LOWER(COALESCE(payload->>'tipo', 'variable')) <> 'fijo') AS sheet_ext_var_n,
               COALESCE(SUM(CASE WHEN source = 'sheet' AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
                                  AND LOWER(COALESCE(payload->>'tipo', '')) = 'fijo'
                                 THEN amount ELSE 0 END), 0) AS sheet_fijos,
               COUNT(*) FILTER (WHERE source = 'sheet' AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
                                  AND LOWER(COALESCE(payload->>'tipo', '')) = 'fijo') AS sheet_fijos_n
          FROM expenses
         WHERE venue_id = %s AND expense_date BETWEEN %s AND %s
        """,
        (venue_id, d0, d1),
    ).fetchone()
    fudo_api = f(row["fudo_api"])
    sheet_repo = f(row["sheet_repo"])
    sheet_ext_var = f(row["sheet_ext_var"])
    sheet_fijos = f(row["sheet_fijos"])

    # En gastos Fudo/Contable: si hay reposiciones en planilla usamos el mayor/planilla y exponemos ambos para comparar
    fudo_efectivo = max(sheet_repo, fudo_api) if sheet_repo > 0 else fudo_api
    fuente = "sheet" if sheet_repo >= fudo_api and sheet_repo > 0 else ("fudo" if fudo_api > 0 else "sin datos")
    diff_fudo_planilla = r(sheet_repo - fudo_api) if (sheet_repo or fudo_api) else 0.0

    return {
        "total": r(fudo_efectivo),
        "n": int((row["sheet_repo_n"] if fuente == "sheet" else row["fudo_n"]) or 0),
        "planilla": r(sheet_repo),
        "planilla_n": int(row["sheet_repo_n"] or 0),
        "fudo": r(fudo_api),
        "fudo_n": int(row["fudo_n"] or 0),
        "diferencia_fudo_planilla": diff_fudo_planilla,
        "sheet_externos": r(sheet_ext_var),
        "sheet_externos_n": int(row["sheet_ext_var_n"] or 0),
        "sheet_fijos": r(sheet_fijos),
        "sheet_fijos_n": int(row["sheet_fijos_n"] or 0),
        "fuente": fuente,
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

    gastos_externos_tot = r(exp["sheet_externos"] + ext["excepcional"])
    gastos_fijos_tot = r(exp["sheet_fijos"] + (ext["fijo"] if exp["sheet_fijos"] == 0 else 0.0))
    gastos_total = r(exp["total"] + gastos_externos_tot + gastos_fijos_tot)

    prev_externos_tot = r(prev_exp["sheet_externos"] + prev_ext["excepcional"])
    prev_fijos_tot = r(prev_exp["sheet_fijos"] + (prev_ext["fijo"] if prev_exp["sheet_fijos"] == 0 else 0.0))
    prev_gastos_total = r(prev_exp["total"] + prev_externos_tot + prev_fijos_tot)

    def pct(a, b):
        return r((a - b) / b * 100, 1) if b else None

    resultado_neto = r(cur["ganancia"] - gastos_total)
    margen_bruto_pct = r(100.0 - cur["cmv_pct"], 1) if cur["ventas_menu"] else 0.0

    return {
        "periodo": {"desde": d0.isoformat(), "hasta": d1.isoformat(), "etiqueta": label_period(d0, d1),
                    "dias": (d1 - d0).days + 1},
        "anterior": {"desde": p0.isoformat(), "hasta": p1.isoformat(), "etiqueta": label_period(p0, p1)},
        "kpis": {
            "ventas": cur["ventas"],
            "ventas_salon": cur["ventas_salon"],
            "ventas_delivery": cur["ventas_delivery"],
            "ventas_delivery_propio": cur["ventas_delivery_propio"],
            "ventas_delivery_apps": cur["ventas_delivery_apps"],
            "ventas_menu": cur["ventas_menu"],
            "salon_pct": cur["salon_pct"],
            "delivery_pct": cur["delivery_pct"],
            "efectivo": cur["efectivo"],
            "virtual": cur["virtual"],
            "efectivo_pct": cur["efectivo_pct"],
            "virtual_pct": cur["virtual_pct"],
            "medios_pago": cur["medios_pago"],
            "gastos": gastos_total,
            "gastos_fudo": exp["total"],
            "gastos_fudo_api": exp["fudo"],
            "gastos_planilla_contable": exp["planilla"],
            "gastos_fudo_dif": exp["diferencia_fudo_planilla"],
            "gastos_fudo_fuente": exp["fuente"],
            "gastos_externos": gastos_externos_tot,
            "gastos_fijos": gastos_fijos_tot,
            "resultado": resultado_neto,
            "cmv": cur["cmv"],
            "cmv_pct": cur["cmv_pct"],
            "margen_bruto_pct": margen_bruto_pct,
            "ganancia": cur["ganancia"],
            "ecuacion_ganancia": {
                "formula": "Ganancia Bruta = Ventas Costeadas (Carta) − Costo de Mercadería Vendida (CMV)",
                "ventas_totales": cur["ventas"],
                "ventas_costeadas": cur["ventas_menu"],
                "cmv": cur["cmv"],
                "cmv_pct": cur["cmv_pct"],
                "ganancia_bruta": cur["ganancia"],
                "margen_bruto_pct": margen_bruto_pct,
                "gastos_totales": gastos_total,
                "resultado_neto": resultado_neto,
            },
            "ticket": cur["ticket"],
            "ventas_n": cur["ventas_n"],
            "top_categoria": top,
        },
        "gastos_detalle": exp,
        "comparacion": {
            "ventas_pct": pct(cur["ventas"], prev["ventas"]),
            "ventas_menu_pct": pct(cur["ventas_salon"], prev["ventas_salon"]),
            "delivery_pct": pct(cur["ventas_delivery"], prev["ventas_delivery"]),
            "gastos_pct": pct(gastos_total, prev_gastos_total),
            "ganancia_pct": pct(cur["ganancia"], prev["ganancia"]),
            "cmv_pp": r(cur["cmv_pct"] - prev["cmv_pct"], 1),
            "anterior": {
                "ventas": prev["ventas"],
                "ventas_salon": prev["ventas_salon"],
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
               SUM(CASE WHEN s.channel = 'salon' THEN si.line_total ELSE 0 END) AS salon,
               SUM(CASE WHEN s.channel IN ('delivery', 'takeaway') THEN si.line_total ELSE 0 END) AS delivery,
               SUM(CASE WHEN s.channel = 'takeaway' THEN si.line_total ELSE 0 END) AS delivery_propio,
               SUM(CASE WHEN s.channel = 'delivery' THEN si.line_total ELSE 0 END) AS delivery_apps,
               SUM(CASE WHEN s.channel <> 'delivery' THEN si.line_total ELSE 0 END) AS costeadas,
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
            sal = f(row["salon"])
            dl = f(row["delivery"])
            cost_v = f(row["costeadas"])
            c = f(row["cmv"])
            out.append({
                "fecha": d.isoformat(),
                "salon": r(sal),
                "menu": r(sal),
                "delivery": r(dl),
                "delivery_propio": r(row["delivery_propio"]),
                "delivery_apps": r(row["delivery_apps"]),
                "total": r(sal + dl),
                "cmv_pct": r(c / cost_v * 100, 1) if cost_v else 0,
            })
        else:
            out.append({
                "fecha": d.isoformat(),
                "salon": 0,
                "menu": 0,
                "delivery": 0,
                "delivery_propio": 0,
                "delivery_apps": 0,
                "total": 0,
                "cmv_pct": 0,
            })
        d += timedelta(days=1)
    return out


def _reconcile_providers(conn, venue_id: int, d0: date, d1: date) -> list[dict]:
    """Cruza proveedores entre Planilla (Reposiciones) y Fudo API en el período."""
    fudo_rows = conn.execute(
        """
        SELECT COALESCE(p.name, NULLIF(e.description, ''), 'Sin proveedor') AS prov,
               COUNT(*) AS n, SUM(e.amount) AS total
          FROM expenses e
          LEFT JOIN providers p ON p.id = e.provider_id
         WHERE e.venue_id = %s AND e.source = 'fudo' AND e.expense_date BETWEEN %s AND %s
         GROUP BY 1
        """,
        (venue_id, d0, d1),
    ).fetchall()
    sheet_rows = conn.execute(
        """
        SELECT COALESCE(NULLIF(e.description, ''), NULLIF(e.payload->>'subcategoria', ''), 'Sin proveedor') AS prov,
               COUNT(*) AS n, SUM(e.amount) AS total
          FROM expenses e
         WHERE e.venue_id = %s AND e.source = 'sheet'
           AND LOWER(COALESCE(e.category_name, '')) LIKE 'reposic%%'
           AND e.expense_date BETWEEN %s AND %s
         GROUP BY 1
        """,
        (venue_id, d0, d1),
    ).fetchall()

    by_key: dict[str, dict] = {}
    for x in sheet_rows:
        raw_name = str(x["prov"] or "Sin proveedor").strip()
        k = _norm_provider(raw_name) or norm(raw_name)
        entry = by_key.setdefault(k, {"proveedor": raw_name, "planilla": 0.0, "planilla_n": 0, "fudo": 0.0, "fudo_n": 0})
        entry["planilla"] += f(x["total"])
        entry["planilla_n"] += int(x["n"] or 0)
    for x in fudo_rows:
        raw_name = str(x["prov"] or "Sin proveedor").strip()
        k = _norm_provider(raw_name) or norm(raw_name)
        entry = by_key.setdefault(k, {"proveedor": raw_name, "planilla": 0.0, "planilla_n": 0, "fudo": 0.0, "fudo_n": 0})
        # Preferir el nombre con espacios/acentos más legible
        if " " in raw_name and " " not in entry["proveedor"]:
            entry["proveedor"] = raw_name
        entry["fudo"] += f(x["total"])
        entry["fudo_n"] += int(x["n"] or 0)

    out = []
    for entry in by_key.values():
        dif = entry["planilla"] - entry["fudo"]
        out.append({
            "proveedor": entry["proveedor"],
            "planilla": r(entry["planilla"]),
            "planilla_n": entry["planilla_n"],
            "fudo": r(entry["fudo"]),
            "fudo_n": entry["fudo_n"],
            "diferencia": r(dif),
            "abs_dif": abs(dif),
        })
    out.sort(key=lambda x: (-x["abs_dif"], -x["planilla"]))
    return out


def expenses_detail(conn, venue_id: int, d0: date, d1: date) -> dict:
    exp = _expenses(conn, venue_id, d0, d1)
    ext = _external_totals(conn, venue_id, d0, d1)

    # Categorías de Fudo API
    fudo_cat_rows = conn.execute(
        """
        SELECT COALESCE(NULLIF(category_name, ''), 'Compras y proveedores') AS categoria,
               SUM(amount) AS total, COUNT(*) AS n
          FROM expenses
         WHERE venue_id = %s AND source = 'fudo' AND expense_date BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 2 DESC
        """,
        (venue_id, d0, d1),
    ).fetchall()
    fudo_cat_tot = sum(f(x["total"]) for x in fudo_cat_rows) or 1.0

    # Categorías Externas (Planilla Gestión sin Reposición - Variables)
    ext_cat_rows = conn.execute(
        """
        SELECT COALESCE(NULLIF(category_name, ''), 'Otros externos') AS categoria,
               SUM(amount) AS total, COUNT(*) AS n
          FROM expenses
         WHERE venue_id = %s AND source = 'sheet'
           AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
           AND LOWER(COALESCE(payload->>'tipo', 'variable')) <> 'fijo'
           AND expense_date BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 2 DESC
        """,
        (venue_id, d0, d1),
    ).fetchall()
    ext_cat_tot = (sum(f(x["total"]) for x in ext_cat_rows) + ext["excepcional"]) or 1.0
    categorias_externos = [
        {"categoria": x["categoria"], "total": r(x["total"]), "n": int(x["n"]),
         "participacion": r(f(x["total"]) / ext_cat_tot * 100, 1)}
        for x in ext_cat_rows
    ]
    if ext["excepcional"] > 0:
        categorias_externos.append({
            "categoria": "Cargados en el portal",
            "total": r(ext["excepcional"]),
            "n": 1,
            "participacion": r(ext["excepcional"] / ext_cat_tot * 100, 1),
        })

    # Categorías Fijos (Planilla Gestión - Fijos)
    fijos_cat_rows = conn.execute(
        """
        SELECT COALESCE(NULLIF(category_name, ''), 'Fijos') AS categoria,
               SUM(amount) AS total, COUNT(*) AS n
          FROM expenses
         WHERE venue_id = %s AND source = 'sheet'
           AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
           AND LOWER(COALESCE(payload->>'tipo', '')) = 'fijo'
           AND expense_date BETWEEN %s AND %s
         GROUP BY 1 ORDER BY 2 DESC
        """,
        (venue_id, d0, d1),
    ).fetchall()
    fijos_cat_tot = sum(f(x["total"]) for x in fijos_cat_rows) or 1.0
    categorias_fijos = [
        {"categoria": x["categoria"], "total": r(x["total"]), "n": int(x["n"]),
         "participacion": r(f(x["total"]) / fijos_cat_tot * 100, 1)}
        for x in fijos_cat_rows
    ]

    # Movimientos detallados (todos los gastos del período para visualización y descripción)
    mov_rows = conn.execute(
        """
        SELECT e.id, e.expense_date, e.source, e.amount,
               COALESCE(NULLIF(e.category_name, ''), 'Sin categoría') AS categoria,
               COALESCE(NULLIF(e.payload->>'subcategoria', ''), p.name, '') AS subcategoria,
               COALESCE(NULLIF(e.description, ''), p.name, '') AS descripcion,
               COALESCE(e.payload->>'tipo', 'Variable') AS tipo,
               COALESCE(e.payload->>'celda_ref', '') AS celda_ref,
               COALESCE(e.payload->>'sheet_cell_url', '') AS sheet_cell_url,
               COALESCE(e.payload->>'hoja_mes', '') AS hoja_mes
          FROM expenses e
          LEFT JOIN providers p ON p.id = e.provider_id
         WHERE e.venue_id = %s AND e.expense_date BETWEEN %s AND %s
         ORDER BY e.expense_date DESC, e.amount DESC
         LIMIT 350
        """,
        (venue_id, d0, d1),
    ).fetchall()
    movimientos = []
    for m in mov_rows:
        src = m["source"]
        cat = str(m["categoria"] or "")
        tipo = str(m["tipo"] or "Variable")
        if src == "fudo":
            grupo = "fudo"
            origen_lbl = "Fudo API"
        elif cat.lower().startswith("reposic"):
            grupo = "reposicion"
            origen_lbl = "Planilla (Proveedores Varios)" if m["hoja_mes"] else "Planilla (Reposición)"
        elif tipo.lower() == "fijo":
            grupo = "fijo"
            origen_lbl = "Planilla (Gasto Fijo)"
        else:
            grupo = "externo"
            origen_lbl = "Planilla (Gasto Externo)"
        movimientos.append({
            "id": m["id"],
            "fecha": m["expense_date"].isoformat(),
            "origen": origen_lbl,
            "grupo": grupo,
            "tipo": tipo,
            "categoria": cat,
            "subcategoria": m["subcategoria"] or "",
            "descripcion": m["descripcion"] or "",
            "monto": r(m["amount"]),
            "celda_ref": m["celda_ref"] or "",
            "sheet_cell_url": m["sheet_cell_url"] or "",
            "hoja_mes": m["hoja_mes"] or "",
        })

    # Estado de la planilla contable en settings + filtrado de revisión bidireccional al período
    contable_setting = None
    contable_reconciliation = None
    try:
        srow = conn.execute(
            "SELECT value FROM settings WHERE venue_id = %s AND key = 'contable_sheet'",
            (venue_id,),
        ).fetchone()
        if srow and srow["value"]:
            contable_setting = srow["value"]
            if isinstance(contable_setting, dict) and contable_setting.get("status") == "ok":
                d0_s, d1_s = d0.isoformat(), d1.isoformat()
                all_disc = contable_setting.get("discrepancias_pendientes") or []
                all_fudo_only = contable_setting.get("fudo_sin_contable") or []
                disc_period = [x for x in all_disc if d0_s <= str(x.get("fecha") or "") <= d1_s]
                fudo_period = [x for x in all_fudo_only if d0_s <= str(x.get("fecha") or "") <= d1_s]
                contable_reconciliation = {
                    "discrepancias_pendientes": disc_period if (disc_period or fudo_period) else all_disc[:60],
                    "fudo_sin_contable": fudo_period if (disc_period or fudo_period) else all_fudo_only[:60],
                    "conciliados_fudo": contable_setting.get("conciliados_fudo", 0),
                    "externos_auto_guardados": contable_setting.get("externos_auto_guardados", 0),
                }
    except Exception:  # noqa: BLE001
        pass

    reconciliacion = _reconcile_providers(conn, venue_id, d0, d1)
    gastos_externos_tot = r(exp["sheet_externos"] + ext["excepcional"])
    gastos_fijos_tot = r(exp["sheet_fijos"] + (ext["fijo"] if exp["sheet_fijos"] == 0 else 0.0))
    gastos_totales = r(exp["total"] + gastos_externos_tot + gastos_fijos_tot)

    return {
        **exp,
        "gastos_totales": gastos_totales,
        "gastos_externos_total": gastos_externos_tot,
        "gastos_fijos_total": gastos_fijos_tot,
        "categorias": [
            {"categoria": x["categoria"], "total": r(x["total"]), "n": int(x["n"]),
             "participacion": r(f(x["total"]) / fudo_cat_tot * 100, 1)}
            for x in fudo_cat_rows
        ],
        "categorias_externos": categorias_externos,
        "categorias_fijos": categorias_fijos,
        "reconciliacion_proveedores": reconciliacion[:25],
        "contable_sheet": contable_setting,
        "contable_reconciliation": contable_reconciliation,
        "movimientos": movimientos,
    }


# ------------------------------------------------------------------ revisión


def _finding(id_, nivel, tipo, titulo, detalle, accion, items=None, peso=0.0, seccion="dashboard") -> dict:
    return {"id": id_, "nivel": nivel, "tipo": tipo, "titulo": titulo, "detalle": detalle,
            "accion": accion, "items": items or [], "peso": r(peso, 1), "seccion": seccion}


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

    # 1. Diferencia entre Gastos Fudo (API) y Planilla Contable / Reposiciones
    if exp_cur["planilla"] > 0 or exp_cur["fudo"] > 0:
        diff_fp = exp_cur["planilla"] - exp_cur["fudo"]
        if abs(diff_fp) > 5000:
            reconc = _reconcile_providers(conn, venue_id, d0, d1)
            top_diffs = [
                f"{p['proveedor']} · Planilla ${p['planilla']:,.0f} ({p['planilla_n']}) vs Fudo ${p['fudo']:,.0f} ({p['fudo_n']}) → Dif. ${p['diferencia']:+,.0f}"
                for p in reconc[:10]
                if p["abs_dif"] > 1000
            ]
            nivel_fp = "critico" if abs(diff_fp) > 1_000_000 else "atencion"
            target_list = critico if nivel_fp == "critico" else atencion
            target_list.append(
                _finding(
                    "diff-fudo-planilla",
                    nivel_fp,
                    "gastos",
                    "Diferencia entre Gastos Fudo y Planilla Contable / Reposición",
                    f"En el período: Planilla (Reposiciones) registra ${exp_cur['planilla']:,.0f} ({exp_cur['planilla_n']} movs) "
                    f"y Fudo API registra ${exp_cur['fudo']:,.0f} ({exp_cur['fudo_n']} movs) · Diferencia: ${diff_fp:+,.0f}.",
                    "Revisar comprobantes de proveedores pendientes de carga en Fudo o en la Planilla.",
                    top_diffs,
                    peso=abs(diff_fp),
                    seccion="gastos",
                )
            )

    # 1b. Estado de acceso y revisión bidireccional de la Planilla Contable ("Proveedores Varios" <-> Fudo)
    try:
        srow = conn.execute(
            "SELECT value FROM settings WHERE venue_id = %s AND key = 'contable_sheet'",
            (venue_id,),
        ).fetchone()
        if srow and isinstance(srow["value"], dict):
            cs_val = srow["value"]
            if cs_val.get("status") == "needs_access":
                atencion.append(
                    _finding(
                        "contable-acceso",
                        "atencion",
                        "gastos",
                        "Planilla Contable con acceso restringido en Google Drive",
                        "El archivo contable compartido aún requiere permiso de lectura pública. "
                        "Actualmente se corroboran los Gastos de Fudo contra la categoría 'Reposiciones' de la Planilla Gestión.",
                        "En Google Drive → Compartir Planilla Contable → 'Cualquier persona con el enlace (Lector)' y tocar Sincronizar.",
                        seccion="gastos",
                    )
                )
            elif cs_val.get("status") == "ok":
                d0_s, d1_s = d0.isoformat(), d1.isoformat()
                disc_p = [x for x in (cs_val.get("discrepancias_pendientes") or []) if d0_s <= str(x.get("fecha") or "") <= d1_s]
                fudo_p = [x for x in (cs_val.get("fudo_sin_contable") or []) if d0_s <= str(x.get("fecha") or "") <= d1_s]
                total_rev = len(disc_p) + len(fudo_p)
                if total_rev > 0:
                    items_txt = [
                        f"[En Sheets · Celda {x.get('celda_ref', 'B')} · Falta en Fudo] {x.get('fecha')} · {x.get('proveedor')} · ${f(x.get('monto')):,.0f}"
                        for x in disc_p[:8]
                    ] + [
                        f"[En Fudo · Falta en Proveedores Varios] {x.get('fecha')} · {x.get('proveedor')} · ${f(x.get('monto')):,.0f}"
                        for x in fudo_p[:8]
                    ]
                    atencion.append(
                        _finding(
                            "reconciliacion-contable-fudo",
                            "atencion",
                            "gastos",
                            f"{total_rev} gasto(s) no coinciden entre 'Proveedores Varios' (Sheets) y Gastos Fudo",
                            f"{len(disc_p)} en 'Proveedores Varios' sin cargar en Fudo y {len(fudo_p)} en Fudo sin pasar a 'Proveedores Varios'. "
                            "Los demás gastos contables ya fueron guardados automáticamente como Externos.",
                            "Abrí la sección Gastos → Revisión para ir directo a la celda de Google Sheets o conciliar en Neon DB.",
                            items_txt,
                            peso=total_rev * 10000,
                            seccion="gastos",
                        )
                    )
    except Exception:  # noqa: BLE001
        pass

    # 2. productos de menú vendidos sin costo
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
                f"Se vendieron ${pes:,.0f} sin costo cargado ({share:.1f} % de las ventas de carta).",
                "Cargar la receta o el costo en Fudo (o un costo de respaldo).",
                [f"{x['producto']} · ${f(x['ventas']):,.0f} ({f(x['cantidad']):.0f} u.)" for x in rows],
                share,
                seccion="ganancias",
            )
        )

    # 3. gastos duplicados
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
                [f"{x['expense_date']} · ${f(x['amount']):,.0f} · {x['n']} veces ({x['d'] or ''})" for x in rows],
                seccion="gastos",
            )
        )

    # 4. cierre mensual vs ventas
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
                    "El cierre mensual de la planilla no coincide con las ventas reales",
                    f"Cierre en planilla ${float(close['ventas']):,.0f} · ventas en Fudo "
                    f"${month_tot['ventas']:,.0f} ({pct:+.1f} %).",
                    "Actualizar la pestaña de cierre mensual en la planilla con el total de Fudo.",
                    seccion="ventas",
                )
            )

    # 5. caída de ventas
    if prev["ventas"] and cur["ventas"] < prev["ventas"] * 0.85:
        pct = (cur["ventas"] - prev["ventas"]) / prev["ventas"] * 100
        critico.append(
            _finding(
                "caida-ventas", "critico", "ventas",
                f"Las ventas cayeron {abs(pct):.0f} %",
                f"${cur['ventas']:,.0f} contra ${prev['ventas']:,.0f} del período anterior.",
                "Revisar días flojos, faltantes de stock o cambios de carta.",
                peso=pct,
                seccion="ventas",
            )
        )

    # 6. caída de gastos (sospechosa)
    if exp_prev["total"] and exp_cur["total"] < exp_prev["total"] * 0.7:
        pct = (exp_cur["total"] - exp_prev["total"]) / exp_prev["total"] * 100
        atencion.append(
            _finding(
                "gastos-caen", "atencion", "gastos",
                f"Los gastos registrados cayeron {abs(pct):.0f} %",
                f"${exp_cur['total']:,.0f} contra ${exp_prev['total']:,.0f} del período anterior. "
                "Una caída así suele ser un gasto sin cargar, no un ahorro.",
                "Revisar alquiler, sueldos, servicios y proveedores fijos del período.",
                peso=pct,
                seccion="gastos",
            )
        )

    # 7. CMV por categoría sobre el objetivo
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
                seccion="ganancias",
            )
        )

    # 8. aumentos de insumos
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
                seccion="gastos",
            )
        )

    # 9. categorías que caen
    caen = [c for c in cats if c["delta_pct"] is not None and c["delta_pct"] < -15 and c["ventas"] > 2000]
    if caen:
        atencion.append(
            _finding(
                "categorias-caen", "atencion", "ventas",
                f"{_plural(len(caen), 'categoría cae', 'categorías caen')} más de 15 %",
                "Comparado con el período anterior equivalente.",
                "Revisar surtido, precios o visibilidad de esas categorías.",
                [f"{c['categoria']} · ${c['ventas']:,.0f} ({c['delta_pct']:+.0f} %)" for c in caen],
                seccion="ventas",
            )
        )

    # 10. categorías que suben (info)
    suben = [c for c in cats if c["delta_pct"] is not None and c["delta_pct"] > 10 and c["ventas"] > 2000]
    if suben:
        info.append(
            _finding(
                "categorias-suben", "info", "ventas",
                f"{_plural(len(suben), 'categoría crece', 'categorías crecen')} más de 10 %",
                "Buen desempeño contra el período anterior.",
                "Mantener el surtido y revisar si conviene ampliar.",
                [f"{c['categoria']} · ${c['ventas']:,.0f} ({c['delta_pct']:+.0f} %)" for c in suben],
                seccion="ventas",
            )
        )

    # 11. participación de canales (delivery vs salón)
    if cur["ventas_delivery"]:
        info.append(
            _finding(
                "canal-delivery", "info", "canal",
                f"Delivery y Take Away: {cur['delivery_pct']:.1f} % de las ventas vs Salón {cur['salon_pct']:.1f} %",
                f"Fuera de salón ${cur['ventas_delivery']:,.0f} (Delivery propio/Mostrador ${cur['ventas_delivery_propio']:,.0f} "
                f"+ Apps ${cur['ventas_delivery_apps']:,.0f}) · Salón ${cur['ventas_salon']:,.0f}.",
                "Ver desglose completo de canales y medios de pago en la sección Ventas.",
                seccion="ventas",
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
    """Por mes: gastos de Fudo vs. Reposiciones de Planilla Contable/Gestión, más Externos y Fijos."""
    today = today_ar()
    first = today.replace(day=1)
    for _ in range(months - 1):
        first = (first - timedelta(days=1)).replace(day=1)
    rows = conn.execute(
        """
        SELECT to_char(expense_date, 'YYYY-MM') AS m,
               COALESCE(SUM(CASE WHEN source = 'fudo' THEN amount ELSE 0 END), 0) AS fudo,
               COALESCE(SUM(CASE WHEN source = 'sheet' AND LOWER(COALESCE(category_name, '')) LIKE 'reposic%%'
                                 THEN amount ELSE 0 END), 0) AS planilla_repo,
               COALESCE(SUM(CASE WHEN source = 'sheet' AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
                                  AND LOWER(COALESCE(payload->>'tipo', 'variable')) <> 'fijo'
                                 THEN amount ELSE 0 END), 0) AS sheet_ext,
               COALESCE(SUM(CASE WHEN source = 'sheet' AND LOWER(COALESCE(category_name, '')) NOT LIKE 'reposic%%'
                                  AND LOWER(COALESCE(payload->>'tipo', '')) = 'fijo'
                                 THEN amount ELSE 0 END), 0) AS sheet_fijos
          FROM expenses
         WHERE venue_id = %s AND source IN ('fudo', 'sheet') AND expense_date >= %s
         GROUP BY 1
        """,
        (venue_id, first),
    ).fetchall()
    by_m = {x["m"]: x for x in rows}
    out = []
    cursor = today.replace(day=1)
    for _ in range(months):
        key = cursor.strftime("%Y-%m")
        end = min(today, cursor.replace(day=calendar.monthrange(cursor.year, cursor.month)[1]))
        ext = _external_totals(conn, venue_id, cursor, end)
        row = by_m.get(key) or {}
        fudo = f(row.get("fudo"))
        sheet_repo = f(row.get("planilla_repo"))
        sheet_ext = f(row.get("sheet_ext"))
        sheet_fijos = f(row.get("sheet_fijos"))
        externos_tot = sheet_ext + ext["excepcional"]
        fijos_tot = sheet_fijos + (ext["fijo"] if sheet_fijos == 0 else 0.0)
        base_fudo = max(sheet_repo, fudo) if sheet_repo > 0 else fudo
        out.append(
            {
                "mes": key,
                "etiqueta": f"{MESES[cursor.month - 1].capitalize()} {cursor.year}",
                "fudo": r(fudo),
                "planilla": r(sheet_repo),
                "diferencia": r(sheet_repo - fudo) if (fudo or sheet_repo) else None,
                "externos": r(externos_tot),
                "fijos": r(fijos_tot),
                "total": r(base_fudo + externos_tot + fijos_tot),
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
            planillas = {}
            if hasattr(_ingest, "sync_sheets"):
                try:
                    planillas = _ingest.sync_sheets(pg, vid)
                    pg.commit()
                except Exception as exc:  # noqa: BLE001
                    pg.rollback()
                    planillas = {"status": "error", "error": str(exc)}
            agregados = _recompute.recompute(pg, vid)
            pg.commit()
        return {
            "ok": True,
            "data": {
                "rango": f"{d0.isoformat()} → {d1.isoformat()}",
                "ventas": ventas,
                "gastos": gastos,
                "planillas": planillas,
                "agregados": agregados,
            },
        }
    finally:
        _fudo_sync_lock.release()


def resolve_contable_item(payload: dict) -> dict:
    """Permite conciliar o confirmar en Neon DB un ítem de la revisión Proveedores Varios <-> Fudo."""
    from psycopg.types.json import Jsonb
    from . import db as _db, ingest as _ingest

    row_hash = str(payload.get("row_hash") or "").strip()
    estado = str(payload.get("estado") or "conciliado_fudo").strip()
    if not row_hash:
        return {"ok": False, "error": "row_hash es obligatorio"}
    if estado not in ("conciliado_fudo", "confirmado_externo", "ignorado", "pendiente_revision"):
        return {"ok": False, "error": "estado inválido"}

    with _db.connect() as pg:
        vid = _db.ensure_venue(pg, "bois")
        res_map: dict = {}
        r_row = pg.execute(
            "SELECT value FROM settings WHERE venue_id = %s AND key = 'contable_resolutions'",
            (vid,),
        ).fetchone()
        if r_row and isinstance(r_row["value"], dict):
            res_map = dict(r_row["value"])
        res_map[row_hash] = {
            "estado": estado,
            "fudo_expense_id": str(payload.get("fudo_expense_id") or "").strip() or None,
            "notas": str(payload.get("notas") or "").strip(),
            "updated_at": datetime.now(ART).isoformat(),
        }
        pg.execute(
            """
            INSERT INTO settings (venue_id, key, value)
            VALUES (%s, 'contable_resolutions', %s)
            ON CONFLICT (venue_id, key) DO UPDATE SET value = EXCLUDED.value
            """,
            (vid, Jsonb(res_map)),
        )
        pg.commit()
        if hasattr(_ingest, "sync_sheets"):
            try:
                _ingest.sync_sheets(pg, vid)
                pg.commit()
            except Exception:  # noqa: BLE001
                pg.rollback()
    return {"ok": True, "data": {"row_hash": row_hash, "estado": estado}}


def _start_fudo_scheduler_daemon() -> None:
    """Programa sincronización automática de Fudo a las 02:00 hs ARG y 16:00 hs ARG."""
    if getattr(_db_mod, "_fudo_cron_started", False):
        return
    _db_mod._fudo_cron_started = True

    def _cron_loop():
        import time as _time
        last_slot = ""
        while True:
            try:
                now_ar = datetime.now(ART)
                if now_ar.hour in (2, 16) and now_ar.minute < 10:
                    slot = f"{now_ar.date().isoformat()}-{now_ar.hour:02d}"
                    if slot != last_slot:
                        last_slot = slot
                        sync_fudo_live({"days": 7})
            except Exception:  # noqa: BLE001
                pass
            _time.sleep(60)

    t = _threading.Thread(target=_cron_loop, name="fudo-scheduler-02-16-arg", daemon=True)
    t.start()


def _patch_live_handler() -> None:
    """Inyecta /api/sync y /api/reconcile en el Handler en ejecución cuando se recarga analytics_pg en caliente."""
    try:
        from . import ingest as _ing_mod, recompute as _rec_mod
        _importlib.reload(_ing_mod)
        _importlib.reload(_rec_mod)
    except Exception:  # noqa: BLE001
        pass
    _start_fudo_scheduler_daemon()
    for mod in list(_sys.modules.values()):
        cls = getattr(mod, "Handler", None)
        if cls is None or not hasattr(cls, "do_POST"):
            continue
        orig_post = getattr(cls, "_orig_do_post", cls.do_POST)
        cls._orig_do_post = orig_post

        def _patched_do_post(self, _orig=orig_post):
            path = _urlparse(self.path).path
            if path == "/api/sync":
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
            if path == "/api/reconcile":
                if not self._write_guard():
                    return
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                    body = _json.loads(self.rfile.read(length).decode("utf-8")) if 0 < length <= 10_000 else {}
                    res = resolve_contable_item(body if isinstance(body, dict) else {})
                    self._json(res, 200 if res.get("ok") else 400)
                except Exception as exc:  # noqa: BLE001
                    self._error(500, f"error conciliando ítem: {exc}")
                return
            return _orig(self)

        cls.do_POST = _patched_do_post


_patch_live_handler()
