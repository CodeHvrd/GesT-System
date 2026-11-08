"""Cliente mínimo de la API pública de Fudo (sin dependencias externas).

Autenticación: POST {auth_url} con {"apiKey": ..., "apiSecret": ...} -> {"token": ..., "exp": ...}
El token dura 24 h; se cachea en memoria y se renueva solo cuando falta poco o si la API
devuelve 401. La API devuelve JSON:API: {"data": [{"id", "type", "attributes", "relationships"}]}
y pagina con page[size] (máx. 500) / page[number].
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "GesTPanel/1.0 (+gestion local)"
TIMEOUT = 40

# tokens por (base_url, api_key): (token, expira_epoch)
_TOKENS: dict[tuple[str, str], tuple[str, float]] = {}


class FudoError(RuntimeError):
    pass


class FudoClient:
    def __init__(self, cfg: dict):
        f = (cfg or {}).get("fudo") or {}
        self.api_key = (f.get("api_key") or "").strip()
        self.api_secret = (f.get("api_secret") or "").strip()
        self.auth_url = (f.get("auth_url") or "https://auth.fu.do/api").strip()
        self.base_url = (f.get("base_url") or "https://api.fu.do/v1alpha1").strip().rstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.api_secret)

    # ------------------------------------------------------------------ auth
    def _authenticate(self) -> tuple[str, float]:
        if not self.configured:
            raise FudoError("Faltan la API Key o la API Secret de Fudo.")
        body = json.dumps({"apiKey": self.api_key, "apiSecret": self.api_secret}).encode("utf-8")
        req = urllib.request.Request(
            self.auth_url,
            data=body,
            headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": UA},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code in (401, 403):
                raise FudoError("Fudo rechazó las credenciales (revisá API Key y API Secret).") from exc
            raise FudoError(f"Fudo respondió {exc.code} al autenticar: {detail}") from exc
        except Exception as exc:  # noqa: BLE001
            raise FudoError(f"No se pudo conectar con Fudo: {exc}") from exc

        token = data.get("token") or data.get("access_token")
        if not token:
            raise FudoError(f"Respuesta de autenticación inesperada: {str(data)[:200]}")
        exp_raw = data.get("exp") or data.get("expires_in") or 0
        try:
            exp = float(exp_raw)
        except (TypeError, ValueError):
            exp = 0.0
        if exp > 1e12:  # viene en milisegundos
            exp = exp / 1000.0
        if exp < 1e9:  # no vino un epoch válido: asumimos 24 h
            exp = time.time() + 24 * 3600
        return str(token), exp

    def token(self) -> str:
        key = (self.base_url, self.api_key)
        cached = _TOKENS.get(key)
        if cached and cached[1] - time.time() > 120:
            return cached[0]
        tok, exp = self._authenticate()
        _TOKENS[key] = (tok, exp)
        return tok

    def invalidate(self) -> None:
        _TOKENS.pop((self.base_url, self.api_key), None)

    # ------------------------------------------------------------------ requests
    def get(self, path: str, params: dict | None = None, _retry: bool = True) -> dict:
        url = self.base_url + (path if path.startswith("/") else "/" + path)
        if params:
            pairs = []
            for k, v in params.items():
                if v is None:
                    continue
                if isinstance(v, bool):
                    v = "true" if v else "false"
                pairs.append(f"{urllib.parse.quote(str(k), safe='[]')}={urllib.parse.quote(str(v), safe=':,.-')}")
            if pairs:
                url += "?" + "&".join(pairs)
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {self.token()}", "Accept": "application/json", "User-Agent": UA},
        )
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            if exc.code == 401 and _retry:
                self.invalidate()
                return self.get(path, params, _retry=False)
            detail = exc.read().decode("utf-8", "replace")[:300]
            if exc.code == 403:
                raise FudoError("El usuario de API no tiene permisos para ese recurso.") from exc
            if exc.code == 429:
                raise FudoError("Fudo limitó la cantidad de pedidos (429). Probá en unos minutos.") from exc
            raise FudoError(f"Fudo respondió {exc.code}: {detail}") from exc
        except Exception as exc:  # noqa: BLE001
            raise FudoError(f"Error de red con Fudo: {exc}") from exc
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise FudoError(f"Respuesta no JSON de Fudo: {raw[:200]}") from exc

    def list_all(self, path: str, params: dict | None = None, max_pages: int = 50) -> list[dict]:
        """Itera todas las páginas de una colección (page[size] máx. 500)."""
        out: list[dict] = []
        base = dict(params or {})
        base.setdefault("page[size]", 500)
        for page in range(1, max_pages + 1):
            q = dict(base)
            q["page[number]"] = page
            data = self.get(path, q)
            rows = data.get("data") or []
            out.extend(rows)
            if len(rows) < int(base["page[size]"]):
                break
        return out

    def health(self) -> dict:
        """Prueba de conexión: autentica y trae un gasto de muestra."""
        data = self.get(
            "/expenses",
            {"page[size]": 1, "include": "provider,expenseCategory", "sort": "-id"},
        )
        rows = data.get("data") or []
        return {
            "ok": True,
            "autenticado": True,
            "muestra": rows[0] if rows else None,
            "total_muestra": len(rows),
            "base_url": self.base_url,
        }
