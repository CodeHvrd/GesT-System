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
import json
import os
import sys
import traceback
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import analytics_pg as an
from . import db

STATIC = Path(__file__).resolve().parent / "static"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8788"))
PORTAL_USER = os.environ.get("PORTAL_USER", "bois")
PORTAL_PASS = os.environ.get("PORTAL_PASS", "")

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
        cache = "no-store" if target.suffix == ".html" else "public, max-age=120"
        self._send(200, target.read_bytes(), ctype, cache)

    # -------------------------------------------------------------- GET
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path
        if path not in ("/healthz", "/readyz") and not self._authorized():
            self._unauthorized()
            return
        try:
            if path == "/healthz":
                self._json({"ok": True})
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
                today = date.today()
                d0 = date.fromisoformat(qs["from"][0]) if qs.get("from") else today.replace(day=1)
                d1 = date.fromisoformat(qs["to"][0]) if qs.get("to") else today
                if d0 > d1:
                    d0, d1 = d1, d0
                with db.connect() as pg:
                    vid = db.ensure_venue(pg, "bois")
                    data = an.dashboard(pg, vid, d0, d1)
                self._json({"ok": True, "data": data})
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
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Portal GesT · http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
