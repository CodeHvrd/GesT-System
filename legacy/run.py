"""Punto de entrada: python run.py [serve|sync] [opciones]."""

from __future__ import annotations

import sys

from app import db, sync
from app.config import load_config
from app.server import main


def do_sync() -> None:
    db.init_db()
    rep = sync.sync_all(load_config())
    print("Sincronización:", "OK" if rep["ok"] else "con errores")
    for t in rep["tabs"]:
        print(f"  · {t.get('name')}: {t.get('rows', 0)} filas [{t['status']}] {t.get('message', '')}")
        for w in t.get("warnings", []) or []:
            print(f"      ! {w}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args and args[0] == "sync":
        do_sync()
    else:
        if args and args[0] == "serve":
            args = args[1:]
        main(args)
