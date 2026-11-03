"""Servidor web local: API JSON + interfaz estática. Sin dependencias externas."""

from __future__ import annotations

import argparse
import csv
import io
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import analytics, db, fudo, fudo_sync, sync, util
from .config import STATIC_DIR, load_config, parse_targets_text, save_config, sheet_id_from_url, tab_url, targets_text

APP_NAME = "Panel de gestión"
DEFAULT_PORT = 8787
_sync_lock = threading.Lock()
_auto_stop = threading.Event()


# ------------------------------------------------------------------ helpers API


def _clean(v, default=None):
    return v if v not in (None, "", "null", "undefined") else default


def _money(v):
    return util.money(v)


def _date_range(params: dict) -> tuple[date, date]:
    today = date.today()
    d1 = util.parse_date(params.get("to")) or today
    d0 = util.parse_date(params.get("from")) or (d1 - timedelta(days=7))
    if d0 > d1:
        d0, d1 = d1, d0
    if (d1 - d0).days > 62:
        raise ValueError("El rango no puede superar los 62 días.")
    return d0, d1


def list_expenses(conn, params: dict) -> dict:
    where, args = ["1=1"], []
    if params.get("from"):
        where.append("fecha >= ?")
        args.append(params["from"])
    if params.get("to"):
        where.append("fecha <= ?")
        args.append(params["to"])
    if params.get("categoria"):
        where.append("categoria = ?")
        args.append(params["categoria"])
    if params.get("tipo"):
        where.append("tipo = ?")
        args.append(params["tipo"])
    if params.get("mes"):
        where.append("mes = ?")
        args.append(params["mes"])
    if params.get("q"):
        where.append("(descripcion LIKE ? OR categoria LIKE ? OR subcategoria LIKE ?)")
        q = f"%{params['q']}%"
        args.extend([q, q, q])
    w = " AND ".join(where)
    limit = min(int(_clean(params.get("limit"), 200)), 1000)
    offset = int(_clean(params.get("offset"), 0))
    total_row = conn.execute(f"SELECT COUNT(*) n, COALESCE(SUM(monto),0) s FROM expenses WHERE {w}", args).fetchone()
    rows = conn.execute(
        f"SELECT * FROM expenses WHERE {w} ORDER BY fecha DESC, id DESC LIMIT ? OFFSET ?",
        args + [limit, offset],
    ).fetchall()
    cats = [r["categoria"] for r in conn.execute("SELECT DISTINCT categoria FROM expenses ORDER BY categoria")]
    return {
        "rows": [dict(r) for r in rows],
        "total": total_row["n"],
        "sum": total_row["s"],
        "limit": limit,
        "offset": offset,
        "categorias": cats,
    }


def data_issues(conn) -> list[dict]:
    issues = []

    def pl(n, sing, plur):
        return f"{n} {sing if n == 1 else plur}"

    rows = conn.execute(
        "SELECT * FROM expenses WHERE substr(fecha,1,7) <> mes ORDER BY fecha DESC LIMIT 50"
    ).fetchall()
    if rows:
        issues.append(
            {
                "tipo": "mes",
                "titulo": pl(len(rows), "gasto con el mes distinto a la fecha", "gastos con el mes distinto a la fecha"),
                "detalle": "El campo Mes no coincide con la fecha del movimiento: "
                + " · ".join(f"{r['fecha']} {r['descripcion']} ({r['mes']})" for r in rows[:3]),
                "items": [
                    {"id": r["id"], "fecha": r["fecha"], "mes": r["mes"], "descripcion": r["descripcion"], "monto": r["monto"]}
                    for r in rows[:12]
                ],
            }
        )
    rows = conn.execute("SELECT * FROM expenses WHERE monto <= 0 ORDER BY fecha DESC LIMIT 50").fetchall()
    if rows:
        issues.append(
            {
                "tipo": "monto",
                "titulo": pl(len(rows), "gasto sin monto válido", "gastos sin monto válido"),
                "detalle": "Filas con monto 0 o negativo: "
                + " · ".join(f"{r['fecha']} {r['descripcion'] or '(sin descripción)'}" for r in rows[:3]),
                "items": [
                    {"id": r["id"], "fecha": r["fecha"], "descripcion": r["descripcion"], "monto": r["monto"]}
                    for r in rows[:12]
                ],
            }
        )
    rows = conn.execute(
        "SELECT * FROM expenses WHERE (descripcion IS NULL OR descripcion = '') ORDER BY fecha DESC LIMIT 50"
    ).fetchall()
    if rows:
        issues.append(
            {
                "tipo": "descripcion",
                "titulo": pl(len(rows), "gasto sin descripción/proveedor", "gastos sin descripción/proveedor"),
                "detalle": "Sin proveedor no se puede analizar la evolución de compras: "
                + " · ".join(f"{r['fecha']} {util.money(r['monto'])}" for r in rows[:3]),
                "items": [{"id": r["id"], "fecha": r["fecha"], "monto": r["monto"]} for r in rows[:12]],
            }
        )
    today = date.today().isoformat()
    rows = conn.execute("SELECT * FROM expenses WHERE fecha > ? ORDER BY fecha DESC LIMIT 50", (today,)).fetchall()
    if rows:
        issues.append(
            {
                "tipo": "fecha",
                "titulo": pl(len(rows), "gasto con fecha futura", "gastos con fecha futura"),
                "detalle": "Fechas posteriores a hoy, puede ser un error de tipeo: "
                + " · ".join(f"{r['fecha']} {r['descripcion']}" for r in rows[:3]),
                "items": [{"id": r["id"], "fecha": r["fecha"], "descripcion": r["descripcion"], "monto": r["monto"]} for r in rows[:12]],
            }
        )
    rows = conn.execute(
        "SELECT fecha, descripcion, monto, COUNT(*) n FROM expenses GROUP BY fecha, descripcion, monto HAVING n > 1 ORDER BY fecha DESC LIMIT 20"
    ).fetchall()
    if rows:
        issues.append(
            {
                "tipo": "duplicados",
                "titulo": pl(len(rows), "posible duplicado", "posibles duplicados"),
                "detalle": "Mismo día, proveedor e importe repetido: "
                + " · ".join(f"{r['fecha']} {r['descripcion']} {util.money(r['monto'])}" for r in rows[:3]),
                "items": [dict(r) for r in rows[:12]],
            }
        )
    return issues


def suggest(conn) -> dict:
    cats = [
        {"categoria": r["categoria"], "n": r["n"], "total": r["s"]}
        for r in conn.execute(
            "SELECT categoria, COUNT(*) n, SUM(monto) s FROM expenses GROUP BY categoria ORDER BY s DESC"
        )
    ]
    subs = [
        {"subcategoria": r["subcategoria"], "categoria": r["categoria"], "n": r["n"]}
        for r in conn.execute(
            "SELECT subcategoria, categoria, COUNT(*) n FROM expenses WHERE subcategoria <> '' "
            "GROUP BY subcategoria, categoria ORDER BY n DESC LIMIT 60"
        )
    ]
    provs = []
    for r in conn.execute(
        "SELECT descripcion, COUNT(*) n, MAX(fecha) ult, SUM(monto) total FROM expenses "
        "WHERE descripcion <> '' GROUP BY descripcion ORDER BY n DESC LIMIT 120"
    ):
        last = conn.execute(
            "SELECT monto, fecha, categoria, subcategoria, tipo FROM expenses WHERE descripcion = ? ORDER BY fecha DESC, id DESC LIMIT 1",
            (r["descripcion"],),
        ).fetchone()
        provs.append(
            {
                "descripcion": r["descripcion"],
                "n": r["n"],
                "ultima_fecha": r["ult"],
                "ultimo_monto": last["monto"] if last else None,
                "categoria": last["categoria"] if last else "",
                "subcategoria": last["subcategoria"] if last else "",
                "tipo": last["tipo"] if last else "",
                "total": r["total"],
            }
        )
    # últimos proveedores usados (uno por proveedor)
    recientes = [
        {
            "descripcion": r["descripcion"],
            "monto": r["monto"],
            "fecha": r["fecha"],
            "categoria": r["categoria"],
            "subcategoria": r["subcategoria"],
            "tipo": r["tipo"],
        }
        for r in conn.execute(
            "SELECT e.descripcion, e.monto, e.fecha, e.categoria, e.subcategoria, e.tipo FROM expenses e "
            "WHERE e.id = (SELECT MAX(id) FROM expenses e2 WHERE e2.descripcion = e.descripcion) "
            "ORDER BY e.fecha DESC, e.id DESC LIMIT 12"
        )
    ]
    # movimientos de los últimos 7 días agrupados por proveedor (para repetir)
    semana = [
        {
            "descripcion": r["descripcion"],
            "monto": r["monto"],
            "fecha": r["fecha"],
            "n": r["n"],
            "categoria": r["categoria"],
            "subcategoria": r["subcategoria"],
            "tipo": r["tipo"],
        }
        for r in conn.execute(
            "SELECT descripcion, SUM(monto) monto, MAX(fecha) fecha, COUNT(*) n, MAX(categoria) categoria, "
            "MAX(subcategoria) subcategoria, MAX(tipo) tipo "
            "FROM expenses WHERE fecha >= date('now', '-8 days') AND descripcion <> '' "
            "GROUP BY lower(descripcion) ORDER BY monto DESC LIMIT 20"
        )
    ]
    return {"categorias": cats, "subcategorias": subs, "proveedores": provs, "recientes": recientes, "semana": semana}


# ------------------------------------------------------------------ entradas


def create_entry(conn, payload: dict) -> dict:
    d = util.parse_date(payload.get("fecha")) or date.today()
    monto = util.parse_number(payload.get("monto"))
    desc = (payload.get("descripcion") or "").strip()
    cat = (payload.get("categoria") or "").strip()
    sub = (payload.get("subcategoria") or "").strip()
    tipo = (payload.get("tipo") or "").strip()
    if not tipo:
        tipo = "Fijo" if cat in ("Alquiler", "Sueldos", "Impuestos", "Servicios Base") else "Variable"
    if cat == "Reposiciones" and not sub:
        sub = "Proveedor"
    errors = []
    if not desc:
        errors.append("Falta la descripción o proveedor.")
    if monto is None or monto <= 0:
        errors.append("El monto tiene que ser mayor a cero.")
    if not cat:
        errors.append("Falta la categoría.")
    if errors:
        return {"ok": False, "errors": errors}

    dup = conn.execute(
        "SELECT id FROM expenses WHERE fecha = ? AND lower(descripcion) = lower(?) AND monto = ? LIMIT 1",
        (d.isoformat(), desc, monto),
    ).fetchone()
    dup_local = conn.execute(
        "SELECT id FROM entries WHERE fecha = ? AND lower(descripcion) = lower(?) AND monto = ? AND estado = 'pendiente' LIMIT 1",
        (d.isoformat(), desc, monto),
    ).fetchone()
    if dup or dup_local:
        return {"ok": False, "errors": ["Ya existe un gasto igual (mismo día, proveedor e importe)."], "duplicate": True}

    cur = conn.execute(
        "INSERT INTO entries(created_at, fecha, mes, tipo, categoria, subcategoria, descripcion, monto, estado) "
        "VALUES(?,?,?,?,?,?,?,?,'pendiente')",
        (
            datetime.now().isoformat(timespec="seconds"),
            d.isoformat(),
            d.strftime("%Y-%m"),
            tipo,
            cat,
            sub,
            desc,
            monto,
        ),
    )
    entry_id = cur.lastrowid
    cfg = load_config()
    result = {"ok": True, "id": entry_id}
    if cfg.get("webhook_url"):
        pushed = push_entries(conn, cfg, ids=[entry_id])
        result["pushed"] = pushed
    return result


def push_entries(conn, cfg: dict, ids=None) -> dict:
    url = cfg.get("webhook_url")
    if not url:
        return {"ok": False, "error": "No hay webhook configurado. Usá el bloque para pegar en el Sheet."}
    if ids:
        qs = ",".join("?" for _ in ids)
        rows = conn.execute(f"SELECT * FROM entries WHERE id IN ({qs}) AND estado = 'pendiente'", ids).fetchall()
    else:
        rows = conn.execute("SELECT * FROM entries WHERE estado = 'pendiente' ORDER BY fecha").fetchall()
    if not rows:
        return {"ok": True, "pushed": 0}
    payload = {
        "token": cfg.get("webhook_token") or "",
        "rows": [
            {
                "fecha": datetime.strptime(r["fecha"], "%Y-%m-%d").strftime("%d/%m/%Y"),
                "mes": r["mes"],
                "tipo": r["tipo"],
                "categoria": r["categoria"],
                "subcategoria": r["subcategoria"],
                "descripcion": r["descripcion"],
                "monto": r["monto"],
            }
            for r in rows
        ],
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": "GestionLocal/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            body = resp.read().decode("utf-8", "replace")
        data = json.loads(body)
        if not data.get("ok"):
            raise RuntimeError(data.get("error") or body[:200])
        now = datetime.now().isoformat(timespec="seconds")
        conn.executemany(
            "UPDATE entries SET estado = 'enviada', pushed_at = ? WHERE id = ?",
            [(now, r["id"]) for r in rows],
        )
        return {"ok": True, "pushed": len(rows)}
    except Exception as exc:  # noqa: BLE001
        conn.execute("UPDATE entries SET error = ? WHERE id = ?", (str(exc)[:300], rows[0]["id"]))
        return {"ok": False, "error": f"No se pudo enviar al Sheet: {exc}"}


def entries_payload(conn) -> dict:
    pend = [dict(r) for r in conn.execute("SELECT * FROM entries WHERE estado = 'pendiente' ORDER BY fecha, id")]
    recent = [dict(r) for r in conn.execute("SELECT * FROM entries WHERE estado <> 'pendiente' ORDER BY id DESC LIMIT 20")]
    return {"pendientes": pend, "recientes": recent, "count": len(pend)}


def paste_block(conn) -> dict:
    rows = conn.execute("SELECT * FROM entries WHERE estado = 'pendiente' ORDER BY fecha, id").fetchall()
    lines = []
    for r in rows:
        d = datetime.strptime(r["fecha"], "%Y-%m-%d").strftime("%d/%m/%Y")
        lines.append(
            "\t".join(
                [d, r["mes"], r["tipo"] or "", r["categoria"] or "", r["subcategoria"] or "", r["descripcion"] or "", f"{r['monto']:.2f}".replace(".", ",")]
            )
        )
    preview = [
        {
            **dict(r),
            "fecha_txt": datetime.strptime(r["fecha"], "%Y-%m-%d").strftime("%d/%m/%Y"),
        }
        for r in rows
    ]
    return {"tsv": "\n".join(lines), "rows": preview, "count": len(rows)}


def week_paste(conn, key: str) -> dict:
    rep = analytics.build_week_report(conn, key)
    header = "\t".join(["Mes", "Semana", "Categoría", "Cantidad", "Ventas", "CMV $", "Ganancia", "CMV %", "Participación", "Observaciones"])
    lines = [header]
    mes = util.MESES[int(key[5:7])].capitalize()
    for i, p in enumerate(rep["paste"]):
        lines.append(
            "\t".join(
                [
                    mes,
                    key,
                    p["categoria"],
                    str(p["cantidad"]),
                    f"{p['ventas']:.2f}".replace(".", ","),
                    f"{p['cmv']:.2f}".replace(".", ","),
                    f"{p['ganancia']:.2f}".replace(".", ","),
                    f"{p['cmv_pct']:.4f}".replace(".", ","),
                    f"{p['participacion']:.4f}".replace(".", ","),
                    rep["narrative"].replace("\n", " ").strip() if i == 0 else "",
                ]
            )
        )
    return {"tsv": "\n".join(lines), "report": rep}


# ------------------------------------------------------------------ servidor


class PanelServer(ThreadingHTTPServer):
    daemon_threads = True
    # En Windows hay que evitar SO_REUSEADDR: permitiría que dos paneles
    # escuchen el mismo puerto al mismo tiempo.
    allow_reuse_address = os.name != "nt"

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return  # el navegador cerró una conexión keep-alive: no es un error real
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    server_version = "GestionLocal/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silencio en consola, salvo errores
        if args and str(args[1]).startswith(("4", "5")):
            print(f"[{self.log_date_time_string()}] {fmt % args}")

    # -------------------------------------------------------------- respuestas
    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def error(self, msg, status=400, **extra):
        self.json({"ok": False, "error": str(msg), **extra}, status=status)

    # -------------------------------------------------------------- GET
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if path.startswith("/api/"):
                return self.api_get(path, params)
            return self.serve_static(path)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.error(f"Error interno: {exc}", status=500)

    def api_get(self, path: str, params: dict):
        cfg = load_config()
        with db.db() as conn:
            if path == "/api/health":
                return self.json({"ok": True, "time": datetime.now().isoformat(timespec="seconds")})
            if path == "/api/overview":
                ov = analytics.build_overview(conn, cfg)
                ov["config"] = {
                    "restaurant": cfg.get("restaurant"),
                    "sheet_url": cfg.get("sheet_url"),
                    "sheet_id": cfg.get("sheet_id"),
                    "webhook": bool(cfg.get("webhook_url")),
                    "google_api": bool(cfg.get("google_api_key")),
                    "fudo": bool((cfg.get("fudo") or {}).get("api_key")),
                    "auto_sync_minutes": int(cfg.get("auto_sync_minutes") or 0),
                    "cmv_targets_text": targets_text(cfg),
                    "tabs": {
                        k: {"name": v.get("name"), "gid": v.get("gid"), "url": tab_url(cfg, k)}
                        for k, v in cfg.get("tabs", {}).items()
                    },
                }
                return self.json({"ok": True, "data": ov})
            if path == "/api/sheets/test":
                if not (cfg.get("google_api_key") or "").strip():
                    return self.error("Todavía no hay una API key guardada.")
                try:
                    rows = sync.fetch_api_values(cfg, "gastos")
                except Exception as exc:  # noqa: BLE001
                    return self.error(f"La API devolvió un error: {exc}")
                return self.json({"ok": True, "data": {"rows": len(rows), "first": rows[0][:8] if rows else []}})
            if path == "/api/fudo/test":
                client = fudo.FudoClient(cfg)
                if not client.configured:
                    return self.error("Faltan la API Key y la API Secret de Fudo.")
                try:
                    data = client.health()
                except fudo.FudoError as exc:
                    return self.error(str(exc))
                return self.json({"ok": True, "data": data})
            if path == "/api/fudo/preview":
                client = fudo.FudoClient(cfg)
                if not client.configured:
                    return self.error("Faltan la API Key y la API Secret de Fudo.")
                resources = {
                    "expenses": ("/expenses", {"include": "provider,expenseCategory,expenseItems.ingredient", "sort": "-id", "page[size]": 3}),
                    "sales": ("/sales", {"include": "items.product,items.product.productCategory", "sort": "-id", "page[size]": 3}),
                    "ingredients": ("/ingredients", {"page[size]": 8}),
                    "providers": ("/providers", {"page[size]": 8}),
                    "expense-categories": ("/expense-categories", {"page[size]": 20}),
                    "products": ("/products", {"include": "productCategory", "page[size]": 8}),
                }
                res = params.get("resource", "expenses")
                if res not in resources:
                    return self.error(f"Recurso desconocido: {res}")
                path_, q = resources[res]
                try:
                    data = client.get(path_, q)
                except fudo.FudoError as exc:
                    return self.error(str(exc))
                return self.json({"ok": True, "data": data})
            if path == "/api/fudo/sales/preview":
                client = fudo.FudoClient(cfg)
                if not client.configured:
                    return self.error("Faltan la API Key y la API Secret de Fudo.")
                try:
                    d0, d1 = _date_range(params)
                    data = fudo_sync.preview(client, d0, d1)
                except fudo.FudoError as exc:
                    return self.error(str(exc))
                except ValueError as exc:
                    return self.error(str(exc))
                return self.json({"ok": True, "data": data})
            if path == "/api/week":
                key = _clean(params.get("key")) or analytics.default_week(conn)
                return self.json({"ok": True, "data": analytics.build_week_report(conn, key)})
            if path == "/api/month":
                month = _clean(params.get("month")) or date.today().strftime("%Y-%m")
                return self.json({"ok": True, "data": analytics.build_month_report(conn, month)})
            if path == "/api/expenses":
                return self.json({"ok": True, "data": list_expenses(conn, params)})
            if path == "/api/suggest":
                return self.json({"ok": True, "data": suggest(conn)})
            if path == "/api/entries":
                return self.json({"ok": True, "data": {**entries_payload(conn), **paste_block(conn)}})
            if path == "/api/paste/week":
                key = _clean(params.get("key")) or analytics.default_week(conn)
                return self.json({"ok": True, "data": {"tsv": week_paste(conn, key)["tsv"]}})
            if path == "/api/alerts":
                return self.json({"ok": True, "data": analytics.build_alerts(conn)})
            if path == "/api/quality":
                return self.json({"ok": True, "data": data_issues(conn)})
            if path == "/api/export/week.csv":
                key = _clean(params.get("key")) or analytics.default_week(conn)
                return self.csv_week(conn, key)
            if path == "/api/export/month.csv":
                month = _clean(params.get("month")) or date.today().strftime("%Y-%m")
                return self.csv_month(conn, month)
            if path == "/api/export/expenses.csv":
                return self.csv_expenses(conn, params)
            return self.error("Ruta no encontrada", status=404)

    # -------------------------------------------------------------- POST
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return self.error("JSON inválido")
        try:
            return self.api_post(path, payload)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self.error(f"Error interno: {exc}", status=500)

    def api_post(self, path: str, payload: dict):
        cfg = load_config()
        if path == "/api/sync":
            if not _sync_lock.acquire(blocking=False):
                return self.error("Ya hay una sincronización en curso.", status=409)
            try:
                report = sync.sync_all(cfg)
            finally:
                _sync_lock.release()
            return self.json({"ok": True, "data": report})
        if path == "/api/entries":
            with db.db() as conn:
                res = create_entry(conn, payload)
            if res.get("ok"):
                return self.json({"ok": True, "data": res})
            return self.error(" ".join(res.get("errors") or ["No se pudo guardar"]), status=409, duplicate=bool(res.get("duplicate")))
        if path == "/api/entries/push":
            with db.db() as conn:
                res = push_entries(conn, cfg, payload.get("ids"))
            if res.get("ok"):
                return self.json({"ok": True, "data": res})
            return self.error(res.get("error") or "No se pudo enviar al Sheet")
        if path == "/api/entries/discard":
            ids = payload.get("ids") or ([payload["id"]] if payload.get("id") else [])
            with db.db() as conn:
                qs = ",".join("?" for _ in ids)
                conn.execute(f"DELETE FROM entries WHERE id IN ({qs})", ids)
            return self.json({"ok": True, "data": {"deleted": len(ids)}})
        if path == "/api/fudo/sales/import":
            client = fudo.FudoClient(cfg)
            if not client.configured:
                return self.error("Faltan la API Key y la API Secret de Fudo.")
            try:
                d0, d1 = _date_range(payload)
                raw = fudo_sync.fetch_sales(client, d0, d1)
                lines = fudo_sync.build_lines(raw)
            except fudo.FudoError as exc:
                return self.error(str(exc))
            except ValueError as exc:
                return self.error(str(exc))
            if not lines:
                return self.error(f"No hay ventas cerradas en Fudo entre {d0} y {d1}.")
            batch = datetime.now().strftime("fudo-%Y%m%dT%H%M%S")
            with db.db() as conn:
                weeks = sync._replace_sales_weeks(conn, lines, batch, source="fudo")
            ventas = sum(l["ventas"] for l in lines)
            cmv = sum(l["cmv"] for l in lines)
            return self.json(
                {
                    "ok": True,
                    "data": {
                        "from": d0.isoformat(),
                        "to": d1.isoformat(),
                        "semanas": weeks,
                        "lineas": len(lines),
                        "ventas": round(ventas, 2),
                        "cmv": round(cmv, 2),
                        "cmv_pct": round(cmv / ventas * 100, 2) if ventas else 0,
                        "control": raw["control"],
                        "modo": raw["modo"],
                    },
                }
            )
        if path == "/api/fudo/sales/clear":
            try:
                d0, d1 = _date_range(payload)
            except ValueError as exc:
                return self.error(str(exc))
            weeks = sorted({util.week_key(d0 + timedelta(days=i)) for i in range((d1 - d0).days + 1)})
            with db.db() as conn:
                qs = ",".join("?" for _ in weeks)
                cur = conn.execute(f"DELETE FROM sales WHERE source = 'fudo' AND semana IN ({qs})", weeks)
                deleted = cur.rowcount
            return self.json({"ok": True, "data": {"deleted": deleted, "semanas": weeks}})
        if path == "/api/config":
            if payload.get("sheet_url"):
                sid = sheet_id_from_url(payload["sheet_url"])
                if not sid:
                    return self.error("No pude leer el ID del link de Google Sheets.")
                cfg["sheet_url"] = payload["sheet_url"]
                if sid != cfg.get("sheet_id"):
                    cfg["sheet_id"] = sid
                    found = sync.discover_tabs(sid)
                    if found:
                        cfg["tabs"] = {
                            k: {**v, "gid": found.get(v["name"], v.get("gid"))} for k, v in cfg["tabs"].items()
                        }
                        cfg["discovered_tabs"] = found
            for k in ("restaurant", "webhook_url", "webhook_token"):
                if k in payload:
                    val = (payload[k] or "").strip()
                    if k == "webhook_token" and not val:
                        continue  # no pisa el token guardado si lo dejan vacío
                    cfg[k] = val
            if payload.get("google_api_key"):
                cfg["google_api_key"] = payload["google_api_key"].strip()
            fudo_cfg = cfg.setdefault("fudo", {})
            if payload.get("fudo_api_key"):
                fudo_cfg["api_key"] = payload["fudo_api_key"].strip()
            if payload.get("fudo_api_secret"):
                fudo_cfg["api_secret"] = payload["fudo_api_secret"].strip()
            if "cmv_targets_text" in payload:
                cfg["cmv_targets"] = parse_targets_text(payload["cmv_targets_text"])
            if "auto_sync_minutes" in payload:
                try:
                    cfg["auto_sync_minutes"] = max(0, min(1440, int(payload["auto_sync_minutes"])))
                except (TypeError, ValueError):
                    pass
            save_config(cfg)
            safe = {k: v for k, v in cfg.items() if k not in ("webhook_token", "google_api_key", "fudo")}
            safe["fudo"] = {"configured": bool(fudo_cfg.get("api_key")), "base_url": fudo_cfg.get("base_url")}
            return self.json({"ok": True, "data": safe})
        return self.error("Ruta no encontrada", status=404)

    # -------------------------------------------------------------- export
    def _csv(self, rows: list[list], filename: str):
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";", lineterminator="\r\n")
        for r in rows:
            out = []
            for v in r:
                if isinstance(v, float):
                    out.append(f"{v:.2f}".replace(".", ","))
                else:
                    out.append(v)
            w.writerow(out)
        body = ("\ufeff" + buf.getvalue()).encode("utf-8")
        self._send(
            200,
            body,
            "text/csv; charset=utf-8",
            {"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    def csv_week(self, conn, key: str):
        rep = analytics.build_week_report(conn, key)
        rows = [["Categoría", "Cantidad", "Ventas", "CMV", "Ganancia", "CMV %", "Participación", "Δ ventas %", "Δ CMV pts"]]
        for c in rep["categories"]:
            rows.append(
                [
                    c["categoria"],
                    round(c.get("qty") or 0),
                    round(c.get("ventas") or 0, 2),
                    round(c.get("cmv") or 0, 2),
                    round(c.get("ganancia") or 0, 2),
                    round(c.get("cmv_pct") or 0, 2),
                    round(c.get("part") or 0, 2),
                    round(c.get("delta_ventas_pct") or 0, 2),
                    round(c.get("delta_cmv_pts") or 0, 2),
                ]
            )
        self._csv(rows, f"semana-{key}.csv")

    def csv_month(self, conn, month: str):
        rep = analytics.build_month_report(conn, month)
        rows = [["Rubro", "Monto", "Movimientos", "Fijo", "Variable"]]
        for c in rep["expenses"]["by_cat"]:
            rows.append([c["categoria"], round(c["monto"], 2), c["n"], round(c["fijo"], 2), round(c["variable"], 2)])
        rows.append([])
        rows.append(["Categoría", "Cantidad", "Ventas", "CMV", "Ganancia", "CMV %", "Participación"])
        for c in rep["categories"]:
            rows.append(
                [
                    c["categoria"],
                    round(c.get("qty") or 0),
                    round(c.get("ventas") or 0, 2),
                    round(c.get("cmv") or 0, 2),
                    round(c.get("ganancia") or 0, 2),
                    round(c.get("cmv_pct") or 0, 2),
                    round(c.get("part") or 0, 2),
                ]
            )
        self._csv(rows, f"mes-{month}.csv")

    def csv_expenses(self, conn, params: dict):
        data = list_expenses(conn, {**params, "limit": 1000})
        rows = [["Fecha", "Mes", "Tipo", "Categoría", "Subcategoría", "Descripción", "Monto"]]
        for r in data["rows"]:
            rows.append([r["fecha"], r["mes"], r["tipo"], r["categoria"], r["subcategoria"], r["descripcion"], r["monto"]])
        self._csv(rows, "gastos.csv")

    # -------------------------------------------------------------- estáticos
    def serve_static(self, path: str):
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            return self.error("Archivo no encontrado", status=404)
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        body = target.read_bytes()
        self._send(200, body, ctype)


def auto_sync_worker() -> None:
    """Sincroniza sola cada `auto_sync_minutes` (la config se relee en cada vuelta)."""
    last = time.time()
    while not _auto_stop.wait(60):
        try:
            cfg = load_config()
            try:
                minutes = int(cfg.get("auto_sync_minutes") or 0)
            except (TypeError, ValueError):
                minutes = 0
            if minutes <= 0:
                last = time.time()
                continue
            if time.time() - last < minutes * 60:
                continue
            last = time.time()
            if not _sync_lock.acquire(blocking=False):
                continue
            try:
                rep = sync.sync_all(cfg)
                estado = "OK" if rep["ok"] else "con avisos"
                print(f"[auto {datetime.now():%H:%M}] planilla sincronizada · {estado}", flush=True)
            finally:
                _sync_lock.release()
        except Exception as exc:  # noqa: BLE001
            print(f"[auto] error de sincronización: {exc}", flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Panel de gestión del local")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", DEFAULT_PORT)))
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--sync", action="store_true", help="Sincronizar al arrancar")
    ap.add_argument("--open", action="store_true", help="Abrir el navegador")
    args = ap.parse_args(argv)

    db.init_db()
    if args.sync:
        try:
            rep = sync.sync_all(load_config())
            print("Sincronización:", "OK" if rep["ok"] else "con errores")
            for t in rep["tabs"]:
                print(f"  - {t['name']}: {t.get('rows', 0)} filas [{t['status']}]")
        except Exception as exc:  # noqa: BLE001
            print("No se pudo sincronizar al arrancar:", exc)

    url = f"http://{args.host}:{args.port}/"
    try:
        httpd = PanelServer((args.host, args.port), Handler)
    except OSError as exc:
        busy = getattr(exc, "errno", None) in (48, 98, 10048) or getattr(exc, "winerror", None) == 10048
        if not busy:
            raise
        # ¿ya está corriendo el panel en ese puerto?
        try:
            with urllib.request.urlopen(url + "api/health", timeout=3) as resp:
                alive = json.loads(resp.read().decode("utf-8")).get("ok")
        except Exception:  # noqa: BLE001
            alive = False
        if alive:
            print(f"\n  El panel ya está corriendo en {url}\n")
            if args.open:
                webbrowser.open(url)
            return
        raise SystemExit(f"El puerto {args.port} está ocupado por otro programa. Probá con --port 8788.")

    print(f"\n  {APP_NAME} — {url}\n  (Ctrl+C para detener)\n")
    threading.Thread(target=auto_sync_worker, daemon=True, name="auto-sync").start()
    if args.open:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nCerrando…")
    finally:
        _auto_stop.set()
        httpd.server_close()


if __name__ == "__main__":
    main()
