"""Prueba las credenciales de Fudo sin tocar la base.

Uso:
    python -m cloud.fudo_check
"""

from __future__ import annotations

import argparse
from pathlib import Path

from . import db
from .ingest import client_from_env


def main() -> None:
    ap = argparse.ArgumentParser(description="Prueba de credenciales de Fudo")
    ap.add_argument("--env", default=".env")
    args = ap.parse_args()
    db.load_env(Path(args.env))

    client = client_from_env()
    print("Autenticando con Fudo…")
    client.token()
    print("  OK: token obtenido (dura 24 h y se renueva solo)\n")

    for resource, params in (
        ("/sales", {"page[size]": 3, "sort": "-id"}),
        ("/expenses", {"page[size]": 3, "sort": "-id", "include": "provider,expenseCategory"}),
        ("/ingredients", {"page[size]": 3}),
        ("/providers", {"page[size]": 3}),
        ("/expense-categories", {"page[size]": 3}),
    ):
        try:
            data = client.get(resource, params)
            rows = data.get("data") or []
            print(f"{resource:20} OK · {len(rows)} fila(s) de muestra")
            if rows:
                attrs = rows[0].get("attributes") or {}
                keys = ", ".join(list(attrs)[:6])
                print(f"                     campos: {keys}")
        except Exception as exc:  # noqa: BLE001
            print(f"{resource:20} ERROR: {exc}")
            if "permisos" in str(exc).lower():
                print("                     → el rol del usuario de API no tiene ese permiso")
                print("                       Fudo → Administración → Usuarios → editar el usuario → Rol")

    print("\nSi Ventas y Gastos responden OK, las credenciales sirven para la base.")
    print("Si dan 403, cambiá el rol del usuario de API por uno con permiso de lectura de")
    print("Ventas, Gastos, Proveedores y Categorías de gastos, y volvé a correr este chequeo.")


if __name__ == "__main__":
    main()
