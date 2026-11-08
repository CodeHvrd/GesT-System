"""Servidor web del portal (Postgres/Neon).

Sirve la interfaz estática y un único endpoint de dashboard:
    GET /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD

Uso:
    python -m cloud.server_pg
    PORT=8788 HOST=0.0.0.0 python -m cloud.server_pg
"""

from __future__ import annotations

import base64
import hmac
import importlib
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import analytics_pg as an
from . import db, ingest, recompute

STATIC = Path(__file__).resolve().parent / "static"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8788"))
PORTAL_USER = os.environ.get("PORTAL_USER", "bois")
PORTAL_PASS = os.environ.get("PORTAL_PASS", "")

# ------------------------------------------------------------------ versión
# Render expone RENDER_GIT_COMMIT con el commit desplegado. En local se lee de git.
GITHUB_REPO = os.environ.get("GITHUB_REPO", "CodeHvrd/GesT-System")
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "main")
STARTED_AT = datetime.now(timezone.utc)
_last_deploy_trigger = 0.0


def _detect_version() -> str:
    full = (os.environ.get("RENDER_GIT_COMMIT") or os.environ.get("GIT_COMMIT") or "").strip()
    if full:
        return full
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=STATIC.parent.parent, capture_output=True, text=True, timeout=3
        )
        return out.stdout.strip()
    except Exception:  # noqa: BLE001
        return ""


VERSION_FULL = _detect_version()
VERSION = VERSION_FULL[:7] or "desconocida"

HotReloadFiles = (
    "cloud/static/index.html",
    "cloud/static/cloud.css",
    "cloud/static/cloud.js",
    "cloud/analytics_pg.py",
    "cloud/ingest.py",
    "cloud/worker.py",
)

_sync_lock = getattr(db, "_fudo_sync_lock", None) or threading.Lock()
db._fudo_sync_lock = _sync_lock


def _resolve_sync_range(payload: dict, default_days: int = 10) -> tuple[date, date]:
    today = an.today_ar()
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


def sync_fudo_now(payload: dict | None = None, days: int = 10) -> dict:
    """Sincroniza ventas y gastos de Fudo hacia Postgres desde el propio servidor."""
    payload = payload or {}
    api_key = str(payload.get("api_key") or "").strip()
    api_secret = str(payload.get("api_secret") or "").strip()

    if not _sync_lock.acquire(timeout=30):
        return {"ok": False, "error": "Ya hay una sincronización en curso. Esperá unos segundos."}
    try:
        d0, d1 = _resolve_sync_range(payload, days)
        with db.connect() as pg:
            vid = db.ensure_venue(pg, "bois")
            if api_key and api_secret:
                ingest.save_credentials(pg, vid, api_key, api_secret)
                pg.commit()
            try:
                client = ingest.client_from_env(pg, vid)
            except SystemExit:
                return {
                    "ok": False,
                    "needs_credentials": True,
                    "error": "Faltan las credenciales de Fudo (API Key y API Secret).",
                }
            ventas = ingest.sync_sales(pg, vid, client, d0, d1)
            pg.commit()
            try:
                gastos = ingest.sync_expenses(pg, vid, client, d0, d1)
                pg.commit()
            except Exception as exc:  # noqa: BLE001
                pg.rollback()
                gastos = {"status": "error", "error": str(exc)}
            planillas = {}
            if hasattr(ingest, "sync_sheets"):
                try:
                    planillas = ingest.sync_sheets(pg, vid)
                    pg.commit()
                except Exception as exc:  # noqa: BLE001
                    pg.rollback()
                    planillas = {"status": "error", "error": str(exc)}
            agregados = recompute.recompute(pg, vid)
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
        _sync_lock.release()


def _auto_sync_loop(interval_sec: int = 900) -> None:
    """Sincroniza en segundo plano cada 15 min si hay credenciales configuradas."""
    time.sleep(8)
    while True:
        try:
            sync_fudo_now(days=5)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(interval_sec)


def _github_latest() -> dict:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/commits/{GITHUB_BRANCH}",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "gest-system"},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.load(resp)
    sha = data.get("sha") or ""
    commit = data.get("commit") or {}
    msg = (commit.get("message") or "").splitlines()[0]
    fecha = (commit.get("committer") or {}).get("date")
    return {"sha": sha, "corta": sha[:7], "mensaje": msg, "fecha": fecha}


def version_info(check_remote: bool = False) -> dict:
    info = {
        "version": VERSION,
        "commit": VERSION_FULL,
        "iniciado": STARTED_AT.isoformat(),
        "repo": GITHUB_REPO,
        "rama": GITHUB_BRANCH,
    }
    if check_remote:
        try:
            rem = _github_latest()
            info["remoto"] = rem
            info["al_dia"] = bool(VERSION_FULL) and rem["sha"] == VERSION_FULL
        except Exception:  # noqa: BLE001
            info["remoto"] = None
            info["al_dia"] = None
    return info


def check_update() -> dict:
    """Sincroniza con el último commit de GitHub en caliente y opcionalmente dispara Render deploy hook."""
    global VERSION_FULL, VERSION, _last_deploy_trigger
    rem = _github_latest()
    latest = rem["sha"]
    was_up_to_date = bool(VERSION_FULL) and latest == VERSION_FULL
    updated_files: list[str] = []

    root = STATIC.parent.parent
    for rel in HotReloadFiles:
        raw_url = f"https://raw.githubusercontent.com/{GITHUB_REPO}/{latest}/{rel}"
        req = urllib.request.Request(raw_url, headers={"User-Agent": "gest-system"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            content = resp.read()
        dest = (root / rel).resolve()
        if root in dest.parents and content:
            dest.write_bytes(content)
            updated_files.append(rel)

    importlib.reload(ingest)
    importlib.reload(recompute)
    importlib.reload(an)
    prev = VERSION
    VERSION_FULL = latest
    VERSION = latest[:7] or "desconocida"

    hook = os.environ.get("RENDER_DEPLOY_HOOK", "").strip()
    deploy_state = None
    if not was_up_to_date and hook and (time.time() - _last_deploy_trigger >= 90):
        try:
            urllib.request.urlopen(urllib.request.Request(hook, method="POST"), timeout=10).read()
            _last_deploy_trigger = time.time()
            deploy_state = "disparado"
        except Exception:  # noqa: BLE001
            deploy_state = "error_hook"

    return {
        "anterior": prev,
        "actual": VERSION,
        "ultima": rem["corta"],
        "mensaje": rem["mensaje"],
        "fecha": rem["fecha"],
        "al_dia": True,
        "ya_estaba_al_dia": was_up_to_date,
        "archivos": len(updated_files),
        "deploy": deploy_state,
    }


MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "GesTPortal/1.0"

    def log_message(self, fmt, *args):  # silencio en consola
        return

    # -------------------------------------------------------------- helpers
    def _authorized(self) -> bool:
        if not PORTAL_PASS:
            return True
        header = self.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8")
        except Exception:  # noqa: BLE001
            return False
        user, _, password = decoded.partition(":")
        return hmac.compare_digest(user, PORTAL_USER) and hmac.compare_digest(password, PORTAL_PASS)

    def _unauthorized(self) -> None:
        body = '{"ok":false,"error":"autenticación requerida"}'.encode("utf-8")
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="GesT", charset="UTF-8"')
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send(self, status: int, body: bytes, ctype: str, cache: str = "no-store") -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, data, status: int = 200) -> None:
        body = json.dumps(data, ensure_ascii=False, default=str).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str) -> None:
        self._json({"ok": False, "error": message}, status)

    def _static(self, path: str) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (STATIC / rel).resolve()
        if STATIC not in target.parents and target != STATIC:
            self._error(404, "no encontrado")
            return
        if not target.is_file():
            self._error(404, "no encontrado")
            return
        ctype = MIME.get(target.suffix.lower(), "application/octet-stream")
        body = target.read_bytes()
        if target.name == "index.html":
            body = (
                body.decode("utf-8")
                .replace('href="/cloud.css"', f'href="/cloud.css?v={VERSION}"')
                .replace('src="/cloud.js"', f'src="/cloud.js?v={VERSION}"')
                .encode("utf-8")
            )
        self._send(200, body, ctype, "no-store")

    # -------------------------------------------------------------- escritura
    def _write_guard(self) -> bool:
        """Auth + solo JSON (obliga a preflight CORS: frena POST cruzados desde otros sitios)."""
        if not self._authorized():
            self._unauthorized()
            return False
        if self.command == "POST" and "application/json" not in self.headers.get("Content-Type", ""):
            self._error(415, "se espera application/json")
            return False
        return True

    def do_POST(self):
        if not self._write_guard():
            return
        try:
            path = urlparse(self.path).path
            if path == "/api/update":
                try:
                    self._json({"ok": True, "data": check_update()})
                except Exception:  # noqa: BLE001
                    self._error(502, "no se pudo consultar GitHub o actualizar archivos")
                return
            if path == "/api/sync":
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8")) if 0 < length <= 10_000 else {}
                res = sync_fudo_now(body if isinstance(body, dict) else {})
                self._json(res, 200 if res.get("ok") else (428 if res.get("needs_credentials") else 400))
                return
            if path != "/api/external":
                self._error(404, "endpoint desconocido")
                return
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 10_000:
                self._error(400, "cuerpo inválido")
                return
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("se espera un objeto JSON")
            with db.connect() as pg:
                vid = db.ensure_venue(pg, "bois")
                new_id = an.external_add(pg, vid, data)
            self._json({"ok": True, "id": new_id}, 201)
        except (ValueError, UnicodeDecodeError) as exc:
            self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._error(500, f"error interno: {exc.__class__.__name__}")

    def do_DELETE(self):
        if not self._write_guard():
            return
        try:
            url = urlparse(self.path)
            if url.path != "/api/external":
                self._error(404, "endpoint desconocido")
                return
            ext_id = int(parse_qs(url.query).get("id", [""])[0])
            with db.connect() as pg:
                vid = db.ensure_venue(pg, "bois")
                found = an.external_remove(pg, vid, ext_id)
            if not found:
                self._error(404, "no encontrado")
                return
            self._json({"ok": True})
        except ValueError:
            self._error(400, "id inválido")
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._error(500, f"error interno: {exc.__class__.__name__}")

    # -------------------------------------------------------------- GET
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path not in ("/healthz", "/readyz") and not self._authorized():
            self._unauthorized()
            return
        try:
            if path == "/healthz":
                self._json({"ok": True, "version": VERSION})
                return
            if path == "/readyz":
                try:
                    with db.connect() as pg:
                        pg.execute("SELECT 1").fetchone()
                    self._json({"ok": True, "db": "ok"})
                except Exception:  # noqa: BLE001
                    self._json({"ok": False, "db": "error"}, 503)
                return
            if path == "/api/dashboard":
                qs = parse_qs(url.query)
                today = an.today_ar()
                d0 = date.fromisoformat(qs["from"][0]) if qs.get("from") else today.replace(day=1)
                d1 = date.fromisoformat(qs["to"][0]) if qs.get("to") else today
                if d0 > d1:
                    d0, d1 = d1, d0
                with db.connect() as pg:
                    vid = db.ensure_venue(pg, "bois")
                    data = an.dashboard(pg, vid, d0, d1)
                data["meta"]["version"] = VERSION
                self._json({"ok": True, "data": data})
                return
            if path == "/api/version":
                qs = parse_qs(url.query)
                self._json({"ok": True, "data": version_info(check_remote=bool(qs.get("remote")))})
                return
            if path == "/api/meta":
                with db.connect() as pg:
                    vid = db.ensure_venue(pg, "bois")
                    self._json({"ok": True, "data": an.meta(pg, vid)})
                return
            if path.startswith("/api/"):
                self._error(404, "endpoint desconocido")
                return
            self._static(path)
        except ValueError as exc:
            self._error(400, f"parámetro inválido: {exc}")
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._error(500, f"error interno: {exc.__class__.__name__}")

    def handle_error(self, request, client_address=None):  # noqa: D401
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main() -> None:
    db.load_env(".env")
    threading.Thread(target=_auto_sync_loop, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Portal GesT · http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
