"""Motor de análisis: resúmenes semanales, mensuales, comparaciones y alertas."""

from __future__ import annotations

import re
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta

from . import db, util
from .config import load_config

# ------------------------------------------------------------------ helpers


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").strip().lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s)


def _r(v, n=2):
    if v is None:
        return None
    return round(float(v), n)


def _merge(rows, key="categoria"):
    """Une categorías con nombres equivalentes (tildes/mayúsculas/typos menores)."""
    buckets: dict[str, dict] = {}
    for r in rows:
        k = _norm(r[key])
        b = buckets.setdefault(k, {"labels": defaultdict(float), "_rows": []})
        b["labels"][r[key]] += r.get("ventas", 0) or 0
        b["_rows"].append(r)
    out = []
    for b in buckets.values():
        label = max(b["labels"].items(), key=lambda kv: kv[1])[0] if b["labels"] else ""
        merged = {key: label}
        for r in b["_rows"]:
            for k, v in r.items():
                if k == key or isinstance(v, str):
                    if k not in merged:
                        merged[k] = v
                    continue
                if v is None:
                    continue
                merged[k] = (merged.get(k) or 0) + v
        out.append(merged)
    return out


def _q(conn, sql, params=()):
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _plural(n: int, singular: str, plural: str) -> str:
    return f"{n} {singular if n == 1 else plural}"


def _targets() -> dict[str, tuple[float, float]]:
    cfg = load_config()
    out: dict[str, tuple[float, float]] = {}
    for name, rng in (cfg.get("cmv_targets") or {}).items():
        try:
            out[_norm(name)] = (float(rng[0]), float(rng[1]))
        except (TypeError, ValueError, IndexError):
            continue
    return out


def _attach_targets(items: list[dict]) -> None:
    targets = _targets()
    for c in items:
        t = targets.get(_norm(c.get("categoria", "")))
        c["target"] = [t[0], t[1]] if t else None


# ------------------------------------------------------------------ semanas


def week_status(key: str, today: date | None = None) -> dict:
    start, end = util.week_bounds(key)
    today = today or date.today()
    if end < today:
        status = "cerrada"
    elif start <= today <= end:
        status = "en_curso"
    else:
        status = "futura"
    days_total = (end - start).days + 1
    days_elapsed = 0
    if status == "cerrada":
        days_elapsed = days_total
    elif status == "en_curso":
        days_elapsed = (today - start).days + 1
    return {
        "key": key,
        "label": util.week_label(key),
        "start": start.isoformat(),
        "end": end.isoformat(),
        "status": status,
        "days_total": days_total,
        "days_elapsed": days_elapsed,
        "month": key[:7],
    }


def available_weeks(conn) -> list[str]:
    keys = {r["semana"] for r in _q(conn, "SELECT DISTINCT semana FROM sales")}
    keys |= {r["semana"] for r in _q(conn, "SELECT DISTINCT semana FROM weekly_history")}
    keys.add(util.current_week())
    return sorted(k for k in keys if re.fullmatch(r"\d{4}-\d{2}-S\d", k))


def default_week(conn) -> str:
    rows = _q(conn, "SELECT MAX(semana) AS s FROM sales")
    if rows and rows[0]["s"]:
        return rows[0]["s"]
    rows = _q(conn, "SELECT MAX(semana) AS s FROM weekly_history")
    if rows and rows[0]["s"]:
        return rows[0]["s"]
    return util.current_week()


def week_categories(conn, key: str) -> dict:
    rows = _q(
        conn,
        "SELECT categoria, SUM(cantidad) qty, SUM(ventas) ventas, SUM(cmv) cmv "
        "FROM sales WHERE semana = ? GROUP BY categoria",
        (key,),
    )
    source = "ventas"
    origins: list[str] = []
    stored_parts: dict[str, float] = {}
    if rows:
        origins = [
            r["source"]
            for r in _q(conn, "SELECT DISTINCT source FROM sales WHERE semana = ?", (key,))
            if r["source"]
        ]
    else:
        rows = _q(
            conn,
            "SELECT categoria, cantidad qty, ventas, cmv, participacion, cmv_pct "
            "FROM weekly_history WHERE semana = ?",
            (key,),
        )
        source = "historico"
        for r in rows:
            if r.get("participacion") is not None:
                stored_parts[_norm(r["categoria"])] = r["participacion"]
    items = _merge([dict(r) for r in rows]) if rows else []
    for it in items:
        it["qty"] = it.get("qty") or 0
        it["ventas"] = it.get("ventas") or 0
        it["cmv"] = it.get("cmv") or 0
        it["cmv_pct"] = util.safe_div(it["cmv"], it["ventas"]) * 100 if it["ventas"] else None
        it["ganancia"] = it["ventas"] - it["cmv"]
        it["part"] = stored_parts.get(_norm(it["categoria"]))
    total_v = sum(i["ventas"] for i in items)
    total_c = sum(i["cmv"] for i in items)
    total_q = sum(i["qty"] for i in items)
    for it in items:
        if it["part"] is None:
            it["part"] = (it["ventas"] / total_v * 100) if total_v else None
    items.sort(key=lambda x: -(x["ventas"] or 0))
    top5 = sum(i["ventas"] for i in items[:5])
    return {
        "source": source,
        "origins": origins,
        "complete": source == "ventas",
        "items": items,
        "total_ventas": total_v,
        "total_cmv": total_c,
        "total_cantidad": total_q,
        "top5_ventas": top5,
        "top5_cmv": sum(i["cmv"] for i in items[:5]),
    }


def week_products(conn, key: str) -> dict:
    rows = _q(
        conn,
        "SELECT producto, categoria, SUM(cantidad) qty, SUM(ventas) ventas, SUM(cmv) cmv "
        "FROM sales WHERE semana = ? GROUP BY producto, categoria",
        (key,),
    )
    items = _merge(rows, key="producto")
    for it in items:
        it["cmv_pct"] = util.safe_div(it.get("cmv"), it.get("ventas")) * 100 if it.get("ventas") else None
        it["ganancia"] = (it.get("ventas") or 0) - (it.get("cmv") or 0)
        it["unit_cost"] = util.safe_div(it.get("cmv"), it.get("qty")) if it.get("qty") else None
        it["margen_unit"] = util.safe_div(it["ganancia"], it.get("qty")) if it.get("qty") else None
    for it in items:
        it.setdefault("categoria", "")
    return {
        "items": sorted(items, key=lambda x: -(x.get("ventas") or 0)),
        "total_ventas": sum(i.get("ventas") or 0 for i in items),
    }


def week_daily(conn, key: str) -> list[dict]:
    rows = _q(
        conn,
        "SELECT fecha, SUM(ventas) ventas, SUM(cmv) cmv, SUM(cantidad) qty "
        "FROM sales WHERE semana = ? GROUP BY fecha ORDER BY fecha",
        (key,),
    )
    return rows


def expenses_range(conn, start: str, end: str) -> dict:
    rows = _q(
        conn,
        "SELECT * FROM expenses WHERE fecha BETWEEN ? AND ? ORDER BY fecha",
        (start, end),
    )
    by_cat: dict[str, dict] = {}
    by_sup: dict[str, dict] = {}
    by_day: dict[str, float] = defaultdict(float)
    for r in rows:
        b = by_cat.setdefault(
            r["categoria"],
            {"categoria": r["categoria"], "monto": 0.0, "n": 0, "fijo": 0.0, "variable": 0.0},
        )
        b["monto"] += r["monto"] or 0
        b["n"] += 1
        if r["tipo"] == "Fijo":
            b["fijo"] += r["monto"] or 0
        else:
            b["variable"] += r["monto"] or 0
        s = by_sup.setdefault(
            _norm(r["descripcion"] or ""),
            {"descripcion": r["descripcion"] or "", "monto": 0.0, "n": 0, "categoria": r["categoria"]},
        )
        s["monto"] += r["monto"] or 0
        s["n"] += 1
        by_day[r["fecha"]] += r["monto"] or 0
    total = sum(r["monto"] or 0 for r in rows)
    fijo = sum(r["monto"] or 0 for r in rows if r["tipo"] == "Fijo")
    return {
        "rows": rows,
        "count": len(rows),
        "total": total,
        "fijo": fijo,
        "variable": total - fijo,
        "by_cat": sorted(by_cat.values(), key=lambda x: -x["monto"]),
        "by_supplier": sorted(by_sup.values(), key=lambda x: -x["monto"]),
        "by_day": [{"fecha": k, "monto": v} for k, v in sorted(by_day.items())],
    }


# ------------------------------------------------------------------ meses


def month_keys(conn) -> list[str]:
    keys = {r["mes"] for r in _q(conn, "SELECT DISTINCT mes FROM expenses")}
    keys |= {r["mes"] for r in _q(conn, "SELECT DISTINCT mes FROM monthly_history WHERE snapshot = 0")}
    keys |= {r["semana"][:7] for r in _q(conn, "SELECT DISTINCT semana FROM weekly_history")}
    keys.add(date.today().strftime("%Y-%m"))
    return sorted(k for k in keys if re.fullmatch(r"\d{4}-\d{2}", k or ""))


def month_week_keys(month: str) -> list[str]:
    import calendar

    last = calendar.monthrange(int(month[:4]), int(month[5:7]))[1]
    n = (last - 1) // 7 + 1
    return [f"{month}-S{i}" for i in range(1, n + 1)]


def month_totals(conn, month: str) -> dict:
    hist = _q(
        conn,
        "SELECT * FROM monthly_history WHERE mes = ? AND snapshot = 0 ORDER BY id DESC LIMIT 1",
        (month,),
    )
    weeks = month_week_keys(month)
    sales_weeks = {r["semana"] for r in _q(conn, "SELECT DISTINCT semana FROM sales")}
    hist_weeks = {r["semana"] for r in _q(conn, "SELECT DISTINCT semana FROM weekly_history")}
    exp = expenses_range(conn, f"{month}-01", f"{month}-31")
    if hist:
        h = hist[0]
        return {
            "source": "cierre",
            "complete": True,
            "ventas": h["ventas"],
            "cmv": h["cmv"],
            "cmv_pct": h["cmv_pct"] if h["cmv_pct"] is not None else (util.safe_div(h["cmv"], h["ventas"]) or 0) * 100,
            "bruto": h["bruto"] if h["bruto"] is not None else h["ventas"] - h["cmv"],
            "gastos_cierre": h["gastos"],
            "resultado_cierre": h["resultado"],
            "margen_cierre": h["margen"],
            "gastos": exp["total"],
            "fijo": exp["fijo"],
            "variable": exp["variable"],
            "expenses": exp,
            "weeks_available": sorted(sales_weeks & set(weeks)),
        }
    # mes sin cierre: se calcula con lo que haya
    covered = [w for w in weeks if w in sales_weeks]
    if covered:
        agg = _q(
            conn,
            "SELECT SUM(ventas) v, SUM(cmv) c, SUM(cantidad) q FROM sales WHERE mes = ?",
            (month,),
        )[0]
        ventas, cmv = agg["v"] or 0, agg["c"] or 0
        source = "ventas"
    else:
        agg = _q(
            conn,
            "SELECT SUM(ventas) v, SUM(cmv) c, SUM(cantidad) q FROM weekly_history WHERE semana LIKE ?",
            (f"{month}-%",),
        )[0]
        ventas, cmv = agg["v"] or 0, agg["c"] or 0
        source = "historico"
    return {
        "source": source,
        "complete": len(covered) == len(weeks) and bool(covered),
        "ventas": ventas,
        "cmv": cmv,
        "cmv_pct": (util.safe_div(cmv, ventas) or 0) * 100,
        "bruto": ventas - cmv,
        "gastos": exp["total"],
        "fijo": exp["fijo"],
        "variable": exp["variable"],
        "gastos_cierre": None,
        "resultado_cierre": None,
        "margen_cierre": None,
        "expenses": exp,
        "weeks_available": covered,
        "weeks_expected": [w for w in weeks if w <= util.current_week()],
    }


def month_categories(conn, month: str) -> dict:
    rows = _q(
        conn,
        "SELECT categoria, SUM(cantidad) qty, SUM(ventas) ventas, SUM(cmv) cmv "
        "FROM sales WHERE mes = ? GROUP BY categoria",
        (month,),
    )
    source = "ventas"
    if not rows:
        rows = _q(
            conn,
            "SELECT categoria, SUM(cantidad) qty, SUM(ventas) ventas, SUM(cmv) cmv "
            "FROM weekly_history WHERE semana LIKE ? GROUP BY categoria",
            (f"{month}-%",),
        )
        source = "historico"
    items = _merge([dict(r) for r in rows])
    total_v = sum(i["ventas"] for i in items)
    for it in items:
        it["cmv_pct"] = (util.safe_div(it["cmv"], it["ventas"]) or 0) * 100 if it["ventas"] else None
        it["ganancia"] = it["ventas"] - it["cmv"]
        it["part"] = (it["ventas"] / total_v * 100) if total_v else None
    items.sort(key=lambda x: -x["ventas"])
    return {"source": source, "items": items, "total_ventas": total_v}


# ------------------------------------------------------------------ comparaciones


def compare(current: list[dict], previous: list[dict], current_total=None, previous_total=None, include_missing=True) -> list[dict]:
    prev_by = {_norm(p["categoria"]): p for p in previous}
    cur_keys = set()
    out = []
    for c in current:
        k = _norm(c["categoria"])
        cur_keys.add(k)
        p = prev_by.get(k)
        item = dict(c)
        item["prev"] = (
            {"ventas": p.get("ventas"), "part": p.get("part"), "cmv_pct": p.get("cmv_pct")} if p else None
        )
        item["delta_ventas_pct"] = (
            util.safe_div((c["ventas"] - p["ventas"]), p["ventas"]) * 100 if p and p.get("ventas") else None
        )
        item["delta_ventas"] = (c["ventas"] - p["ventas"]) if p else None
        item["delta_part"] = (c["part"] - p["part"]) if p and p.get("part") is not None and c.get("part") is not None else None
        item["delta_cmv_pts"] = (
            (c["cmv_pct"] - p["cmv_pct"]) if p and p.get("cmv_pct") is not None and c.get("cmv_pct") is not None else None
        )
        out.append(item)
    for p in previous:
        if _norm(p["categoria"]) not in cur_keys and (p.get("ventas") or 0) > 0 and include_missing:
            out.append(
                {
                    "categoria": p["categoria"],
                    "qty": 0,
                    "ventas": 0,
                    "cmv": 0,
                    "cmv_pct": None,
                    "ganancia": 0,
                    "part": 0,
                    "prev": {"ventas": p.get("ventas"), "part": p.get("part"), "cmv_pct": p.get("cmv_pct")},
                    "delta_ventas": -(p.get("ventas") or 0),
                    "delta_ventas_pct": -100.0,
                    "delta_part": (0 - p["part"]) if p.get("part") is not None else None,
                    "delta_cmv_pts": None,
                    "desaparecida": True,
                }
            )
    out.sort(key=lambda x: -(x.get("ventas") or 0))
    return out


# ------------------------------------------------------------------ series


def weekly_series(conn, n: int = 12) -> list[dict]:
    keys = sorted({r["semana"] for r in _q(conn, "SELECT DISTINCT semana FROM weekly_history")})
    keys = keys[-n:]
    if not keys:
        return []
    qs = ",".join("?" for _ in keys)
    rows = _q(
        conn,
        f"SELECT semana, SUM(ventas) ventas, SUM(cmv) cmv FROM weekly_history WHERE semana IN ({qs}) GROUP BY semana",
        tuple(keys),
    )
    by = {r["semana"]: r for r in rows}
    exp = _q(
        conn,
        f"SELECT semana, SUM(ventas) ventas FROM sales WHERE semana IN ({qs}) GROUP BY semana",
        tuple(keys),
    )
    sales_by = {r["semana"]: r["ventas"] for r in exp}
    out = []
    for k in keys:
        r = by.get(k, {})
        start, end = util.week_bounds(k)
        g = _q(conn, "SELECT SUM(monto) m FROM expenses WHERE fecha BETWEEN ? AND ?", (start.isoformat(), end.isoformat()))[0]["m"] or 0
        out.append(
            {
                "key": k,
                "label": f"S{k[-1]}",
                "month": k[:7],
                "month_label": util.month_label(k[:7], short=True),
                "ventas": r.get("ventas"),
                "ventas_full": sales_by.get(k),
                "cmv": r.get("cmv"),
                "cmv_pct": (util.safe_div(r.get("cmv"), r.get("ventas")) or 0) * 100 if r.get("ventas") else None,
                "gastos": g,
                "resultado": (r.get("ventas") or 0) - g if r.get("ventas") is not None else None,
            }
        )
    return out


def monthly_series(conn, n: int = 8) -> list[dict]:
    rows = _q(conn, "SELECT * FROM monthly_history WHERE snapshot = 0 ORDER BY mes")
    by = {r["mes"]: r for r in rows}
    months = sorted(set(by) | {r["mes"] for r in _q(conn, "SELECT DISTINCT mes FROM expenses")})
    out = []
    for m in months[-n:]:
        h = by.get(m)
        g = _q(conn, "SELECT SUM(monto) m FROM expenses WHERE mes = ?", (m,))[0]["m"] or 0
        ventas = h["ventas"] if h else None
        out.append(
            {
                "mes": m,
                "label": util.month_label(m, short=True),
                "ventas": ventas,
                "cmv": h["cmv"] if h else None,
                "cmv_pct": h["cmv_pct"] if h else None,
                "gastos": g,
                "resultado": h["resultado"] if h else None,
                "margen": h["margen"] if h else None,
                "cierre": bool(h),
            }
        )
    return out


def sales_weeks(conn) -> list[str]:
    return [r["semana"] for r in _q(conn, "SELECT DISTINCT semana FROM sales ORDER BY semana")]


def last_sales_week(conn) -> str | None:
    weeks = sales_weeks(conn)
    return weeks[-1] if weeks else None


def _fmt_date(d: str) -> str:
    dd = date.fromisoformat(d)
    return f"{dd.day:02d}/{dd.month:02d}"


def _days(start: str, end: str) -> list[str]:
    a, b = date.fromisoformat(start), date.fromisoformat(end)
    return [(a + timedelta(days=i)).isoformat() for i in range((b - a).days + 1)]


# ------------------------------------------------------------------ alertas


def build_alerts(conn, today: date | None = None) -> list[dict]:
    today = today or date.today()
    alerts: list[dict] = []
    today_key = util.current_week(today)

    n_exp = conn.execute("SELECT COUNT(*) n FROM expenses").fetchone()["n"]
    n_sales = conn.execute("SELECT COUNT(*) n FROM sales").fetchone()["n"]
    if not n_exp and not n_sales:
        return [
            {
                "id": "sin-datos",
                "nivel": "info",
                "tipo": "datos",
                "titulo": "Todavía no hay datos sincronizados",
                "detalle": "La app está conectada pero todavía no leyó la planilla.",
                "accion": "Tocá Sincronizar para traer los gastos y las ventas.",
                "meta": {},
            }
        ]

    def add(id_, nivel, tipo, titulo, detalle, accion="", meta=None, items=None):
        alerts.append(
            {
                "id": id_,
                "nivel": nivel,
                "tipo": tipo,
                "titulo": titulo,
                "detalle": detalle,
                "accion": accion,
                "meta": meta or {},
                "items": items or [],
            }
        )

    # 1. problemas de importación
    rep = db.get_setting(conn, "last_sync") or {}
    warns: list[str] = []
    for t in rep.get("tabs", []) or []:
        for w in (t.get("warnings") or []):
            warns.append(f"{t.get('name')}: {w}")
        if t.get("status") == "error":
            warns.append(f"{t.get('name')}: {t.get('message')}")
    if warns:
        add(
            "datos-importacion",
            "atencion",
            "datos",
            f"{len(warns)} aviso{'s' if len(warns) != 1 else ''} al importar la planilla",
            " · ".join(warns[:4]) + (" …" if len(warns) > 4 else ""),
            "Revisar las filas indicadas en la pestaña Gastos y volver a sincronizar.",
            {"warnings": warns},
            items=warns,
        )

    # 2. ventas de la semana en curso
    st = week_status(today_key, today)
    if st["days_elapsed"] > 0:
        days_with = {r["fecha"] for r in _q(conn, "SELECT DISTINCT fecha FROM sales WHERE semana = ?", (today_key,))}
        expected = _days(st["start"], min(st["end"], today.isoformat()))
        missing = [d for d in expected if d not in days_with]
        if not days_with:
            add(
                "ventas-semana",
                "atencion" if st["days_elapsed"] > 1 else "info",
                "ventas",
                f"Ventas de la semana en curso sin cargar ({st['label']})",
                f"No hay ventas importadas para {today_key}. Se esperaban {len(expected)} día(s) a la fecha.",
                "Importá el detalle de Fudo de la semana para poder cerrar el resumen.",
                {"week": today_key},
                items=[f"{_fmt_date(d)} · sin ventas cargadas" for d in expected],
            )
        elif missing:
            add(
                "ventas-dias",
                "atencion",
                "ventas",
                f"Faltan {len(missing)} día(s) de ventas en {st['label']}",
                "Sin ventas registradas: " + ", ".join(_fmt_date(d) for d in missing) + ".",
                "Completá los días faltantes en la importación de Fudo.",
                {"week": today_key, "days": missing},
                items=[f"{_fmt_date(d)} · sin ventas cargadas" for d in missing],
            )

    # 3. productos sin costear (última semana con ventas)
    lw = last_sales_week(conn)
    if lw:
        unc = _q(
            conn,
            "SELECT producto, categoria, SUM(cantidad) qty, SUM(ventas) ventas "
            "FROM sales WHERE semana = ? GROUP BY producto, categoria HAVING SUM(cmv) = 0 AND SUM(ventas) > 0 "
            "ORDER BY ventas DESC",
            (lw,),
        )
        if unc:
            total_w = _q(conn, "SELECT SUM(ventas) v FROM sales WHERE semana = ?", (lw,))[0]["v"] or 0
            lost = sum(r["ventas"] for r in unc)
            pct = (lost / total_w * 100) if total_w else 0
            top = ", ".join(f"{r['producto']} ({util.money(r['ventas'])})" for r in unc[:4])
            add(
                "sin-costear",
                "critico" if pct >= 3 else "atencion",
                "costeo",
                f"{_plural(len(unc), 'producto sin costear', 'productos sin costear')}",
                f"{util.money(lost)} de ventas sin CMV ({util.pct(pct)} del total). "
                f"Semana {util.week_label(lw)}: {top}{' …' if len(unc) > 4 else ''}.",
                "Cargar el costo de esos productos en Fudo para que el CMV y la ganancia sean reales.",
                {"week": lw, "products": unc[:12], "ventas_sin_costo": lost},
                items=[f"{p['producto']} · {p['categoria']} · {util.number(p['qty'])} u · {util.money(p['ventas'])}" for p in unc[:20]],
            )

    # 4-6. categorías: desaparecidas, CMV en alza, caídas y subas
    if lw:
        cur = week_categories(conn, lw)
        prev_weeks = [w for w in available_weeks(conn) if w < lw][-4:]
        prevs = {w: week_categories(conn, w) for w in prev_weeks}
        prev1 = week_categories(conn, util.prev_week(lw)) if prev_weeks else {"items": []}
        cmp1 = compare(cur["items"], prev1["items"])
        total_cur = sum(i["ventas"] for i in cur["items"]) or 1

        missing = []
        # categorías presentes en todas las 4 semanas previas y ausentes ahora
        if prevs:
            sets = [{_norm(c["categoria"]): c for c in p["items"] if (c["ventas"] or 0) > 0} for p in prevs.values()]
            common = set(sets[0])
            for s in sets[1:]:
                common &= set(s)
            cur_set = {_norm(c["categoria"]) for c in cur["items"] if (c["ventas"] or 0) > 0}
            for k in common - cur_set:
                label = sets[0][k]["categoria"]
                avg = sum(s[k]["ventas"] for s in sets) / len(sets)
                if avg >= total_cur * 0.01:
                    missing.append({"categoria": label, "promedio": avg})
            if missing:
                add(
                    "cats-desaparecidas",
                    "atencion",
                    "tendencia",
                    "Categorías que no salieron esta semana",
                    "; ".join(f"{m['categoria']} (promediaba {util.money(m['promedio'])})" for m in missing),
                    "Verificar si es un cambio real de demanda o un problema de carga en Fudo.",
                    {"week": lw, "cats": missing},
                    items=[f"{m['categoria']} · promediaba {util.money(m['promedio'])} por semana" for m in missing],
                )

        # CMV en alza vs promedio ponderado de las 4 semanas previas
        if prevs:
            agg: dict[str, list] = defaultdict(lambda: [0, 0])
            for p in prevs.values():
                for c in p["items"]:
                    agg[_norm(c["categoria"])][0] += c["ventas"]
                    agg[_norm(c["categoria"])][1] += c["cmv"]
            subas = []
            for c in cur["items"]:
                k = _norm(c["categoria"])
                if k not in agg:
                    continue
                v, cm = agg[k]
                if v <= 0 or c["ventas"] < total_cur * 0.03:
                    continue
                avg_pct = cm / v * 100
                if c["cmv_pct"] is not None and c["cmv_pct"] - avg_pct >= 3:
                    subas.append({"categoria": c["categoria"], "cmv_pct": c["cmv_pct"], "promedio": avg_pct})
            if subas:
                add(
                    "cmv-alza",
                    "atencion",
                    "costeo",
                    "CMV en alza en " + ", ".join(s["categoria"] for s in subas[:3]),
                    "; ".join(
                        f"{s['categoria']}: {util.pct(s['cmv_pct'])} vs {util.pct(s['promedio'])} de las 4 semanas previas"
                        for s in subas
                    ),
                    "Revisar precios de proveedores y costeos de esos productos.",
                    {"week": lw, "items": subas},
                    items=[
                        f"{s['categoria']} · {util.pct(s['cmv_pct'])} vs {util.pct(s['promedio'])} de las 4 semanas previas "
                        f"(+{util.number(s['cmv_pct'] - s['promedio'], 1)} pts)"
                        for s in subas
                    ],
                )

        # CMV por encima (o muy por debajo) del objetivo propio de cada categoría
        targets = _targets()
        over, under = [], []
        for c in cur["items"]:
            t = targets.get(_norm(c["categoria"]))
            if not t or c.get("cmv_pct") is None or (c["ventas"] or 0) < total_cur * 0.01:
                continue
            if c["cmv_pct"] > t[1]:
                over.append({"categoria": c["categoria"], "cmv_pct": c["cmv_pct"], "target": list(t), "ventas": c["ventas"]})
            elif c["cmv_pct"] < t[0] - 5:
                under.append({"categoria": c["categoria"], "cmv_pct": c["cmv_pct"], "target": list(t), "ventas": c["ventas"]})
        if over:
            add(
                "cmv-objetivo",
                "atencion",
                "costeo",
                f"CMV por encima del objetivo en {_plural(len(over), 'categoría', 'categorías')}",
                "; ".join(
                    f"{o['categoria']}: {util.pct(o['cmv_pct'])} vs objetivo {util.pct(o['target'][0])}–{util.pct(o['target'][1])}"
                    for o in over[:4]
                ),
                "Revisar el costeo de esos productos o el precio de venta.",
                {"week": lw, "items": over},
                items=[
                    f"{o['categoria']} · {util.pct(o['cmv_pct'])} vs objetivo {util.pct(o['target'][0])}–{util.pct(o['target'][1])} · {util.money(o['ventas'])}"
                    for o in over
                ],
            )
        if under:
            add(
                "cmv-bajo",
                "info",
                "costeo",
                f"CMV muy por debajo del objetivo en {_plural(len(under), 'categoría', 'categorías')}",
                "; ".join(
                    f"{o['categoria']}: {util.pct(o['cmv_pct'])} vs objetivo {util.pct(o['target'][0])}–{util.pct(o['target'][1])}"
                    for o in under[:4]
                ),
                "Puede ser una mezcla de ventas con más margen o un costeo incompleto: conviene verificarlo.",
                {"week": lw, "items": under},
                items=[
                    f"{o['categoria']} · {util.pct(o['cmv_pct'])} vs objetivo {util.pct(o['target'][0])}–{util.pct(o['target'][1])} · {util.money(o['ventas'])}"
                    for o in under
                ],
            )

        caidas = [c for c in cmp1 if c.get("delta_ventas_pct") is not None and c["delta_ventas_pct"] <= -25 and (c.get("prev", {}) or {}).get("ventas", 0) >= total_cur * 0.03]
        if caidas:
            add(
                "cats-caida",
                "atencion",
                "tendencia",
                "Categorías en caída",
                "; ".join(f"{c['categoria']} {util.signed(c['delta_ventas_pct'], 1, '%')}" for c in caidas[:5]),
                "Comparar con promociones, clima y días operativos; revisar si falta cargar algún día.",
                {"week": lw, "items": caidas},
                items=[
                    f"{c['categoria']} · {util.signed(c['delta_ventas_pct'], 1, '%')} · "
                    f"{util.money((c.get('prev') or {}).get('ventas'))} → {util.money(c['ventas'])}"
                    for c in caidas
                ],
            )
        subas_cat = [
            c
            for c in cmp1
            if c.get("delta_ventas_pct") is not None
            and c["delta_ventas_pct"] >= 30
            and (c.get("prev", {}) or {}).get("ventas", 0) >= 50000
        ]
        if subas_cat:
            add(
                "cats-suba",
                "info",
                "tendencia",
                "Categorías que crecieron fuerte",
                "; ".join(f"{c['categoria']} {util.signed(c['delta_ventas_pct'], 1, '%')}" for c in subas_cat[:5]),
                "Buen momento para empujar esas categorías con cartelería o combos.",
                {"week": lw, "items": subas_cat},
                items=[
                    f"{c['categoria']} · {util.signed(c['delta_ventas_pct'], 1, '%')} · "
                    f"{util.money((c.get('prev') or {}).get('ventas'))} → {util.money(c['ventas'])}"
                    for c in subas_cat
                ],
            )

    # 7. proveedores habituales que no aparecen
    since = (today - timedelta(days=42)).isoformat()
    provs = _q(
        conn,
        "SELECT descripcion, COUNT(*) n, MAX(fecha) last, SUM(monto) total FROM expenses "
        "WHERE categoria = 'Reposiciones' AND fecha >= ? GROUP BY descripcion HAVING n >= 3 ORDER BY total DESC",
        (since,),
    )
    lag = (today - timedelta(days=14)).isoformat()
    missing_prov = [p for p in provs if (p["last"] or "") < lag and (p["total"] or 0) > 100000]
    if missing_prov:
        add(
            "proveedores-ausentes",
            "atencion",
            "compras",
            f"{_plural(len(missing_prov), 'proveedor habitual', 'proveedores habituales')} sin compras hace 2 semanas",
            "; ".join(f"{p['descripcion']} (últ. {_fmt_date(str(p['last']))})" for p in missing_prov[:6]),
            "Confirmar si no hubo compra o si falta cargar la factura en Gastos.",
            {"items": missing_prov},
            items=[
                f"{p['descripcion']} · última compra {_fmt_date(str(p['last']))} · {util.money(p['total'])} en 6 semanas"
                for p in missing_prov
            ],
        )

    # 8. gastos fijos del mes
    month = today.strftime("%Y-%m")
    fixed_cats = ["Alquiler", "Sueldos", "Impuestos", "Servicios Base"]
    if today.day >= 10:
        have = {r["categoria"] for r in _q(conn, "SELECT DISTINCT categoria FROM expenses WHERE mes = ?", (month,))}
        miss = [c for c in fixed_cats if c not in have]
        if miss:
            add(
                "fijos-faltantes",
                "atencion",
                "compras",
                f"Gastos fijos de {util.month_label(month)} sin registrar: " + ", ".join(miss),
                f"A día {today.day} del mes no hay movimientos de esos rubros, que sí se cargan todos los meses.",
                "Cargar alquiler, sueldos, servicios e impuestos del mes.",
                {"month": month, "cats": miss},
                items=[f"{c} · sin movimientos en {util.month_label(month)}" for c in miss],
            )

    # 9. duplicados probables
    dupes = _q(
        conn,
        "SELECT fecha, descripcion, monto, COUNT(*) n, GROUP_CONCAT(id) ids FROM expenses "
        "WHERE fecha >= ? GROUP BY fecha, descripcion, monto HAVING n > 1 ORDER BY monto DESC LIMIT 10",
        ((today - timedelta(days=90)).isoformat(),),
    )
    if dupes:
        add(
            "duplicados",
            "atencion",
            "datos",
            f"{_plural(len(dupes), 'posible gasto duplicado', 'posibles gastos duplicados')}",
            "; ".join(f"{_fmt_date(d['fecha'])} {d['descripcion']} {util.money(d['monto'])}" for d in dupes[:5]),
            "Si son dos compras distintas, ignorar; si no, borrar la fila repetida en la planilla.",
            {"items": dupes},
            items=[
                f"{_fmt_date(d['fecha'])} · {d['descripcion']} · {util.money(d['monto'])} · {d['n']} veces"
                for d in dupes
            ],
        )

    # 10. cierres mensuales desactualizados
    closes = _q(
        conn,
        "SELECT * FROM monthly_history WHERE snapshot = 0 AND mes >= ? ORDER BY mes DESC",
        ((today - timedelta(days=200)).strftime("%Y-%m"),),
    )
    mismatches = []
    for c in closes:
        real = _q(conn, "SELECT SUM(monto) m FROM expenses WHERE mes = ?", (c["mes"],))[0]["m"] or 0
        if c["gastos"] and abs(real - c["gastos"]) / c["gastos"] > 0.01:
            mismatches.append({"mes": c["mes"], "cierre": c["gastos"], "planilla": real})
    if mismatches:
        add(
            "cierres-desvio",
            "atencion",
            "cierres",
            "El cierre mensual no coincide con la planilla de Gastos",
            "; ".join(
                f"{util.month_label(m['mes'])}: cierre {util.money(m['cierre'])} vs planilla {util.money(m['planilla'])}"
                for m in mismatches[:4]
            ),
            "Actualizar la pestaña Historico_Mensual con los totales vigentes.",
            {"items": mismatches},
            items=[
                f"{util.month_label(m['mes'])} · cierre {util.money(m['cierre'])} vs planilla {util.money(m['planilla'])} "
                f"({util.money(m['planilla'] - m['cierre'])})"
                for m in mismatches
            ],
        )

    # 11. costo unitario de productos en alza
    rows = _q(
        conn,
        "SELECT producto, semana, SUM(cmv) cmv, SUM(cantidad) qty FROM sales "
        "WHERE cantidad > 0 GROUP BY producto, semana",
    )
    by_prod: dict[str, list] = defaultdict(list)
    for r in rows:
        by_prod[_norm(r["producto"])].append(r)
    subas_unit = []
    for prod, rs in by_prod.items():
        rs.sort(key=lambda x: x["semana"])
        if len(rs) < 2:
            continue
        a, b = rs[-2], rs[-1]
        if a["qty"] < 3 or b["qty"] < 3:
            continue
        ua, ub = a["cmv"] / a["qty"], b["cmv"] / b["qty"]
        if ua > 0 and (ub - ua) / ua >= 0.12:
            subas_unit.append({"producto": b["producto"], "antes": ua, "ahora": ub, "delta": (ub - ua) / ua * 100})
    if subas_unit:
        subas_unit.sort(key=lambda x: -x["delta"])
        add(
            "costo-unitario",
            "info",
            "compras",
            "Subió el costo unitario de " + ", ".join(p["producto"] for p in subas_unit[:3]),
            "; ".join(f"{p['producto']} {util.money(p['antes'])} → {util.money(p['ahora'])} ({util.signed(p['delta'], 1, '%')})" for p in subas_unit[:5]),
            "Revisar precios de proveedores o actualizar recetas.",
            {"items": subas_unit[:8]},
            items=[
                f"{p['producto']} · {util.money(p['antes'])} → {util.money(p['ahora'])} por unidad "
                f"({util.signed(p['delta'], 1, '%')})"
                for p in subas_unit[:12]
            ],
        )

    # 12. última semana cerrada sin observaciones
    wh = _q(
        conn,
        "SELECT semana, MAX(observaciones) obs FROM weekly_history WHERE semana < ? GROUP BY semana ORDER BY semana DESC LIMIT 1",
        (today_key,),
    )
    if wh and not (wh[0]["obs"] or "").strip():
        add(
            "sin-observaciones",
            "info",
            "cierres",
            f"La semana {wh[0]['semana']} no tiene observaciones cargadas",
            "El histórico semanal de esa semana quedó sin comentarios.",
            "Agregar el resumen de la semana en Historico_Semanal.",
            {"week": wh[0]["semana"]},
            items=[f"Semana {util.week_label(wh[0]['semana'])} ({wh[0]['semana']}) sin observaciones"],
        )

    order = {"critico": 0, "atencion": 1, "info": 2}
    alerts.sort(key=lambda a: (order.get(a["nivel"], 3), a["titulo"]))
    return alerts


# ------------------------------------------------------------------ relatos


def _join_es(items: list[str]) -> str:
    if not items:
        return ""
    if len(items) == 1:
        return items[0]
    return ", ".join(items[:-1]) + " y " + items[-1]


def week_narrative(conn, key: str, categories: list[dict], totals: dict, prev_key: str, prev_totals: dict, expenses: dict, alerts: list[dict], today: date | None = None) -> str:
    st = week_status(key, today)
    start = date.fromisoformat(st["start"])
    end = date.fromisoformat(st["end"])
    if not categories:
        msg = f"Semana del {start.day} al {end.day} de {util.MESES[end.month]}: todavía no hay ventas cargadas."
        if expenses and expenses.get("total"):
            msg += f" Los gastos registrados en esos días suman {util.money(expenses['total'])}."
        return msg
    lines: list[str] = []
    head = f"Semana del {start.day} al {end.day} de {util.MESES[end.month]}"
    if totals["source"] == "historico":
        head += " (datos del histórico semanal, top 5 categorías)"
    ventas = totals["total_ventas"]
    cmv = totals["total_cmv"]
    cmv_pct = (cmv / ventas * 100) if ventas else 0
    lines.append(
        f"{head}: ventas por {util.money(ventas)}, CMV {util.pct(cmv_pct)} ({util.money(cmv)}) "
        f"y ganancia bruta {util.money(ventas - cmv)}."
    )

    if prev_totals and prev_totals.get("total_ventas"):
        basis = "top 5" if (totals["source"] != "ventas" or prev_totals.get("source") != "ventas") else None
        dv = util.safe_div(totals.get("top5_ventas") - prev_totals.get("top5_ventas"), prev_totals.get("top5_ventas"))
        prev_cmv_pct = (prev_totals["total_cmv"] / prev_totals["total_ventas"] * 100) if prev_totals.get("total_ventas") else None
        if dv is not None:
            extra = " (top 5)" if basis else ""
            lines.append(
                f"Contra la semana anterior ({util.week_label(prev_key)}) las ventas {('subieron' if dv >= 0 else 'bajaron')} "
                f"{util.pct(abs(dv) * 100)}{extra}"
                + (
                    f" y el CMV {'subió' if cmv_pct > prev_cmv_pct else 'bajó'} {util.number(abs(cmv_pct - prev_cmv_pct), 1)} pts"
                    if prev_cmv_pct is not None
                    else ""
                )
                + "."
            )

    if categories:
        top = categories[:3]
        lines.append(
            "Lideran "
            + _join_es(
                [f"{c['categoria']} ({util.pct(c['part'])} de participación, {util.money(c['ventas'])}, CMV {util.pct(c['cmv_pct'])})" for c in top if c.get("part") is not None]
            )
            + "."
        )

    subas = [c for c in categories if (c.get("delta_ventas_pct") or 0) >= 15 and (c.get("ventas") or 0) > 0]
    caidas = [c for c in categories if (c.get("delta_ventas_pct") or 0) <= -15 and c.get("prev")]
    if subas or caidas:
        parts = []
        if subas:
            parts.append("Subas: " + ", ".join(f"{c['categoria']} {util.signed(c['delta_ventas_pct'], 1, '%')}" for c in subas[:3]))
        if caidas:
            parts.append("Caídas: " + ", ".join(f"{c['categoria']} {util.signed(c['delta_ventas_pct'], 1, '%')}" for c in caidas[:3]))
        lines.append("; ".join(parts) + ".")

    if expenses and expenses.get("total"):
        if expenses.get("fijo"):
            lines.append(
                f"Gastos de la semana: {util.money(expenses['total'])} "
                f"(fijos {util.money(expenses['fijo'])}, variables {util.money(expenses['variable'])})."
            )
        else:
            lines.append(f"Gastos de la semana: {util.money(expenses['total'])} (sin gastos fijos cargados en esos días).")

    relevant = [a for a in alerts if a["nivel"] in ("critico", "atencion")][:3]
    if relevant:
        lines.append("Para revisar: " + " ".join(a["titulo"] + "." for a in relevant))
    return "\n\n".join(lines)


def month_narrative(conn, month: str, totals: dict, cats: list[dict], alerts: list[dict], today: date | None = None, prev_equiv: float | None = None) -> str:
    today = today or date.today()
    lines = []
    label = util.month_label(month)
    if totals["source"] == "cierre":
        lines.append(
            f"{label}: ventas por {util.money(totals['ventas'])}, CMV {util.pct(totals['cmv_pct'])} "
            f"({util.money(totals['cmv'])}) y resultado bruto {util.money(totals['bruto'])}."
        )
        lines.append(
            f"Gastos totales {util.money(totals['gastos'])} (fijos {util.money(totals['fijo'])}, "
            f"variables {util.money(totals['variable'])}): resultado final {util.money(totals['resultado_cierre']) if totals.get('resultado_cierre') is not None else util.money(totals['ventas'] - totals['gastos'])}."
        )
    else:
        parcial = "parcial" if not totals["complete"] else ""
        lines.append(
            f"{label} ({parcial} al {today.day}/{today.month}): ventas registradas {util.money(totals['ventas'])}, "
            f"CMV {util.pct(totals['cmv_pct'])} y gastos {util.money(totals['gastos'])}."
        )
    exp = totals.get("expenses") or {}
    by_cat = exp.get("by_cat") or []
    if by_cat:
        top = by_cat[:4]
        lines.append(
            "Principales rubros: "
            + ", ".join(f"{c['categoria']} {util.money(c['monto'])}" for c in top)
            + "."
        )
    if prev_equiv:
        d = util.safe_div(totals["gastos"] - prev_equiv, prev_equiv) * 100
        if d is not None:
            lines.append(
                f"Los gastos van {util.signed(d, 1, '%')} contra el mismo tramo de {util.month_label(util.prev_month(month))} "
                f"({util.money(prev_equiv)})."
            )
    if cats:
        top = cats[:3]
        lines.append(
            "Categorías que más venden: "
            + ", ".join(f"{c['categoria']} ({util.pct(c['part'])})" for c in top if c.get("part") is not None)
            + "."
        )
    relevant = [a for a in alerts if a["nivel"] in ("critico", "atencion")][:3]
    if relevant:
        lines.append("Para revisar: " + " ".join(a["titulo"] + "." for a in relevant))
    return "\n\n".join(lines)


# ------------------------------------------------------------------ reportes


def build_week_report(conn, key: str, today: date | None = None) -> dict:
    today = today or date.today()
    st = week_status(key, today)
    cur = week_categories(conn, key)
    prev_key = util.prev_week(key)
    prev = week_categories(conn, prev_key)
    prevm_key = util.same_week_prev_month(key)
    prevm = week_categories(conn, prevm_key)

    cats = compare(cur["items"], prev["items"], include_missing=cur["complete"])
    _attach_targets(cats)
    pm_by = {_norm(c["categoria"]): c for c in prevm["items"]}
    for c in cats:
        pm = pm_by.get(_norm(c["categoria"]))
        if pm:
            c["prev_month"] = {"ventas": pm["ventas"], "part": pm["part"], "cmv_pct": pm["cmv_pct"]}
            c["delta_ventas_pm_pct"] = util.safe_div(c["ventas"] - pm["ventas"], pm["ventas"]) * 100 if pm["ventas"] else None
            c["delta_cmv_pm_pts"] = (
                (c["cmv_pct"] - pm["cmv_pct"]) if c.get("cmv_pct") is not None and pm.get("cmv_pct") is not None else None
            )
        else:
            c["prev_month"] = None
            c["delta_ventas_pm_pct"] = None
            c["delta_cmv_pm_pts"] = None

    prods = week_products(conn, key)["items"]
    with_sales = [p for p in prods if (p.get("ventas") or 0) > 0]
    uncosted = [p for p in with_sales if (p.get("cmv") or 0) == 0]
    total_w = sum(p["ventas"] for p in with_sales) or 0
    worst = sorted(
        [p for p in with_sales if p.get("cmv_pct") is not None and p["ventas"] >= total_w * 0.02],
        key=lambda p: -(p["cmv_pct"] or 0),
    )[:5]
    best = sorted(
        [p for p in with_sales if p.get("cmv_pct") is not None],
        key=lambda p: -(p.get("ganancia") or 0),
    )[:5]

    exp = expenses_range(conn, st["start"], st["end"])
    p_start, p_end = util.week_bounds(prev_key)
    exp_prev = expenses_range(conn, p_start.isoformat(), p_end.isoformat())
    exp_by_cat = {c["categoria"]: c for c in exp_prev["by_cat"]}
    for c in exp["by_cat"]:
        prev_c = exp_by_cat.get(c["categoria"])
        c["prev"] = prev_c["monto"] if prev_c else 0
        c["delta_pct"] = util.safe_div(c["monto"] - (prev_c["monto"] if prev_c else 0), prev_c["monto"]) * 100 if prev_c and prev_c["monto"] else None

    daily = week_daily(conn, key)
    days_with = {d["fecha"] for d in daily}
    expected = _days(st["start"], min(st["end"], today.isoformat())) if st["days_elapsed"] else []
    missing_days = [d for d in expected if d not in days_with]

    alerts = build_alerts(conn, today)
    narrative = week_narrative(
        conn, key, cats, cur, prev_key,
        {"total_ventas": prev["total_ventas"], "total_cmv": prev["total_cmv"], "source": prev["source"], "top5_ventas": prev["top5_ventas"]},
        exp, alerts, today,
    )

    same_month = util.safe_div(cur["top5_ventas"] - prevm["top5_ventas"], prevm["top5_ventas"]) if prevm["top5_ventas"] else None
    prev_cmv_pct = (prev["total_cmv"] / prev["total_ventas"] * 100) if prev["total_ventas"] else None
    cmv_pct = (cur["total_cmv"] / cur["total_ventas"] * 100) if cur["total_ventas"] else None
    top5_delta = util.safe_div(cur["top5_ventas"] - prev["top5_ventas"], prev["top5_ventas"]) if prev["top5_ventas"] else None

    paste = []
    for c in cats[:5]:
        paste.append(
            {
                "categoria": c["categoria"],
                "cantidad": round(c.get("qty") or 0),
                "ventas": round(c.get("ventas") or 0, 2),
                "cmv": round(c.get("cmv") or 0, 2),
                "ganancia": round(c.get("ganancia") or 0, 2),
                "cmv_pct": round((c.get("cmv_pct") or 0) / 100, 4),
                "participacion": round((c.get("part") or 0) / 100, 4),
            }
        )

    return {
        "week": st,
        "sales": {
            "ventas": cur["total_ventas"],
            "cmv": cur["total_cmv"],
            "cmv_pct": cmv_pct,
            "ganancia": cur["total_ventas"] - cur["total_cmv"],
            "cantidad": cur["total_cantidad"],
            "source": cur["source"],
            "origen": "fudo" if "fudo" in (cur.get("origins") or []) else "sheet",
            "complete": cur["complete"],
            "top5_ventas": cur["top5_ventas"],
            "has_data": bool(cur["items"]),
        },
        "comparison": {
            "prev_week": prev_key,
            "prev_label": util.week_label(prev_key),
            "prev_source": prev["source"],
            "prev_ventas": prev["total_ventas"],
            "prev_cmv": prev["total_cmv"],
            "prev_cmv_pct": prev_cmv_pct,
            "delta_ventas_pct": top5_delta * 100 if top5_delta is not None else None,
            "delta_ventas_pct_total": (
                util.safe_div(cur["total_ventas"] - prev["total_ventas"], prev["total_ventas"]) * 100 if prev["total_ventas"] else None
            ),
            "basis": "top5" if (cur["source"] != "ventas" or prev["source"] != "ventas") else "total",
            "delta_cmv_pts": (cmv_pct - prev_cmv_pct) if (cmv_pct is not None and prev_cmv_pct is not None) else None,
            "same_month_week": prevm_key,
            "same_month_label": util.week_label(prevm_key),
            "same_month_delta_pct": same_month * 100 if same_month is not None else None,
        },
        "categories": cats,
        "products": {
            "top": with_sales[:12],
            "best": best,
            "worst": worst,
            "uncosted": uncosted,
            "total": len(with_sales),
            "uncosted_total": sum(p["ventas"] for p in uncosted),
        },
        "daily": daily,
        "coverage": {
            "days_with_sales": len(days_with),
            "days_expected": len(expected),
            "missing_days": missing_days,
        },
        "expenses": {
            "total": exp["total"],
            "fijo": exp["fijo"],
            "variable": exp["variable"],
            "count": exp["count"],
            "by_cat": exp["by_cat"],
            "top_suppliers": exp["by_supplier"][:10],
            "prev_total": exp_prev["total"],
            "delta_pct": util.safe_div(exp["total"] - exp_prev["total"], exp_prev["total"]) * 100 if exp_prev["total"] else None,
            "by_day": exp["by_day"],
        },
        "alerts": alerts,
        "narrative": narrative,
        "paste": paste,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


def build_month_report(conn, month: str, today: date | None = None) -> dict:
    import calendar

    today = today or date.today()
    totals = month_totals(conn, month)
    mc = month_categories(conn, month)
    prevm = util.prev_month(month)
    pm = month_categories(conn, prevm)
    cats = compare(mc["items"], pm["items"], include_missing=mc["source"] == "ventas")
    _attach_targets(cats)

    hist = _q(conn, "SELECT * FROM monthly_history WHERE mes = ? AND snapshot = 0 ORDER BY id DESC LIMIT 1", (month,))
    closes = _q(conn, "SELECT * FROM monthly_history WHERE snapshot = 0 ORDER BY mes")
    close_by = {c["mes"]: c for c in closes}
    partial = month == today.strftime("%Y-%m") and not hist

    # las categorías del histórico cubren solo el top 5 de cada semana: el resto se agrupa
    total_listed = sum(c["ventas"] for c in cats)
    if totals["ventas"] and total_listed < totals["ventas"] * 0.995:
        resto_v = totals["ventas"] - total_listed
        resto_cmv = max(0.0, totals["cmv"] - sum(c["cmv"] for c in cats))
        cats.append(
            {
                "categoria": "Otras categorías (sin detalle)",
                "qty": 0,
                "ventas": resto_v,
                "cmv": resto_cmv,
                "cmv_pct": (resto_cmv / resto_v * 100) if resto_v else None,
                "ganancia": resto_v - resto_cmv,
                "part": (resto_v / totals["ventas"] * 100) if totals["ventas"] else None,
                "prev": None,
                "delta_ventas_pct": None,
                "delta_part": None,
                "delta_cmv_pts": None,
                "delta_ventas_pm_pct": None,
                "virtual": True,
            }
        )
    for c in cats:
        c["part"] = (c["ventas"] / totals["ventas"] * 100) if totals["ventas"] else None
        if partial:
            c["delta_ventas_pct"] = None
            c["delta_ventas_pm_pct"] = None
            c["delta_cmv_pts"] = None

    exp = totals["expenses"]
    pm_exp = expenses_range(conn, f"{prevm}-01", f"{prevm}-31")
    is_current = month == today.strftime("%Y-%m")
    if is_current:
        prev_cut = min(today.day, calendar.monthrange(int(prevm[:4]), int(prevm[5:7]))[1])
        pm_equiv = expenses_range(conn, f"{prevm}-01", f"{prevm}-{prev_cut:02d}")
        prev_equiv = pm_equiv["total"]
    else:
        prev_equiv = pm_exp["total"]
    pm_by_cat = {c["categoria"]: c["monto"] for c in (pm_equiv["by_cat"] if is_current else pm_exp["by_cat"])}
    by_cat = []
    for c in exp["by_cat"]:
        prev_v = pm_by_cat.get(c["categoria"])
        by_cat.append(
            {
                **c,
                "prev": prev_v,
                "delta_pct": util.safe_div(c["monto"] - (prev_v or 0), prev_v) * 100 if prev_v else None,
            }
        )

    alerts = build_alerts(conn, today)
    narrative = month_narrative(conn, month, totals, cats, alerts, today, prev_equiv=prev_equiv)

    series = monthly_series(conn, 8)
    prev_close = close_by.get(prevm)
    deltas = None
    if prev_close and hist:
        deltas = {
            "ventas": util.safe_div(hist[0]["ventas"] - prev_close["ventas"], prev_close["ventas"]) * 100 if prev_close["ventas"] else None,
            "gastos": util.safe_div(hist[0]["gastos"] - prev_close["gastos"], prev_close["gastos"]) * 100 if prev_close["gastos"] else None,
            "cmv_pts": (hist[0]["cmv_pct"] or 0) - (prev_close["cmv_pct"] or 0),
        }

    return {
        "month": {
            "key": month,
            "label": util.month_label(month),
            "status": "en_curso" if month == today.strftime("%Y-%m") else ("futura" if month > today.strftime("%Y-%m") else "cerrado"),
            "days_in_month": calendar.monthrange(int(month[:4]), int(month[5:7]))[1],
            "today": today.isoformat(),
            "partial": partial,
        },
        "totals": {
            **{k: v for k, v in totals.items() if k != "expenses"},
            "ventas": totals["ventas"],
            "cmv": totals["cmv"],
            "cmv_pct": totals["cmv_pct"],
            "bruto": totals["bruto"],
            "ganancia_neta": (totals["resultado_cierre"] if totals.get("resultado_cierre") is not None else totals["ventas"] - totals["gastos"]),
            "margen_neto": (
                totals.get("margen_cierre")
                if totals.get("margen_cierre") is not None
                else (util.safe_div(totals["ventas"] - totals["gastos"], totals["ventas"]) or 0) * 100
            ),
        },
        "categories": cats,
        "categories_source": mc["source"],
        "expenses": {
            "total": exp["total"],
            "fijo": exp["fijo"],
            "variable": exp["variable"],
            "count": exp["count"],
            "by_cat": by_cat,
            "top_suppliers": exp["by_supplier"][:12],
            "by_day": exp["by_day"],
            "prev_total": prev_equiv,
            "prev_total_full": pm_exp["total"],
            "compare_partial": is_current,
            "delta_pct": util.safe_div(exp["total"] - prev_equiv, prev_equiv) * 100 if prev_equiv else None,
        },
        "close": dict(hist[0]) if hist else None,
        "prev_close": dict(prev_close) if prev_close else None,
        "deltas": deltas,
        "series": series,
        "alerts": alerts,
        "narrative": narrative,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }


def build_overview(conn, cfg: dict | None = None) -> dict:
    today = date.today()
    weeks = available_weeks(conn)
    months = month_keys(conn)
    alerts = build_alerts(conn, today)
    counts_by_level = defaultdict(int)
    for a in alerts:
        counts_by_level[a["nivel"]] += 1
    rep = db.get_setting(conn, "last_sync") or {}
    cw = util.current_week(today)
    cur_sales = week_categories(conn, cw)
    cur_start, cur_end = util.week_bounds(cw)
    cur_exp = expenses_range(conn, cur_start.isoformat(), min(cur_end, today).isoformat())
    return {
        "today": today.isoformat(),
        "current_week": week_status(cw, today),
        "default_week": default_week(conn),
        "weeks": [{"key": k, **week_status(k, today)} for k in weeks[-16:]],
        "months": [{"key": m, "label": util.month_label(m)} for m in months],
        "series_weekly": weekly_series(conn, 12),
        "series_monthly": monthly_series(conn, 8),
        "alerts": alerts[:12],
        "alert_counts": dict(counts_by_level),
        "counts": db.counts(conn),
        "last_sync": rep.get("finished") if isinstance(rep, dict) else None,
        "sync_ok": rep.get("ok") if isinstance(rep, dict) else None,
        "last_sync_report": rep if isinstance(rep, dict) else None,
        "sheet_url": (cfg or {}).get("sheet_url"),
        "pending_entries": conn.execute("SELECT COUNT(*) n FROM entries WHERE estado = 'pendiente'").fetchone()["n"],
        "last_reports": [dict(r) for r in conn.execute("SELECT * FROM sync_log ORDER BY id DESC LIMIT 8").fetchall()],
        "current": {
            "week": week_status(cw, today),
            "ventas": cur_sales["total_ventas"],
            "ventas_source": cur_sales["source"],
            "has_sales": bool(cur_sales["items"]),
            "gastos": cur_exp["total"],
            "gastos_count": cur_exp["count"],
            "gastos_fijo": cur_exp["fijo"],
        },
    }

