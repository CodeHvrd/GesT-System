"""Worker de sincronización Fudo → Postgres.

Corre una vez (para Task Scheduler/cron) o en loop cada N minutos.

Uso:
    python -m cloud.worker --once
    python -m cloud.worker --minutes 15
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import traceback
from datetime import datetime, timedelta, timezone

from . import db, ingest, recompute

ART = timezone(timedelta(hours=-3))


def run_once(days: int = 7, venue: str = "bois", direct: bool = True) -> dict:
    db.load_env(".env")
    if not (os.environ.get("DATABASE_URL_DIRECT") or os.environ.get("DATABASE_URL") or "").strip():
        msg = "Falta DATABASE_URL_DIRECT / DATABASE_URL en GitHub Secrets/Variables o .env"
        print(f"::error title=Configuracion faltante::{msg}", flush=True)
        raise SystemExit(msg)

    d1 = datetime.now(ART).date()
    d0 = d1 - timedelta(days=days)
    out: dict = {"rango": f"{d0}..{d1}"}
    with db.connect(direct=direct) as pg:
        db.apply_schema(pg)
        vid = db.ensure_venue(pg, venue)
        pg.commit()
        client = ingest.client_from_env(pg, vid)
        try:
            out["ventas"] = ingest.sync_sales(pg, vid, client, d0, d1)
            pg.commit()
        except Exception as exc:  # noqa: BLE001
            pg.rollback()
            out["ventas_error"] = f"{type(exc).__name__}: {exc}"
            print(f"::error title=Error sincronizando ventas::{out['ventas_error']}", flush=True)
        try:
            out["gastos"] = ingest.sync_expenses(pg, vid, client, d0, d1)
            pg.commit()
        except Exception as exc:  # noqa: BLE001
            pg.rollback()
            out["gastos_error"] = f"{type(exc).__name__}: {exc}"
            print(f"::warning title=Error sincronizando gastos::{out['gastos_error']}", flush=True)
        if hasattr(ingest, "sync_sheets"):
            try:
                out["planillas"] = ingest.sync_sheets(pg, vid)
                pg.commit()
            except Exception as exc:  # noqa: BLE001
                pg.rollback()
                out["planillas_error"] = f"{type(exc).__name__}: {exc}"
        out["agregados"] = recompute.recompute(pg, vid)
        pg.commit()

    print(f"::notice title=Resultado sync-fudo::{out}", flush=True)
    if "ventas_error" in out:
        raise SystemExit(1)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Sincronización periódica de Fudo")
    ap.add_argument("--once", action="store_true", help="una corrida y termina")
    ap.add_argument("--minutes", type=int, default=15, help="intervalo entre corridas")
    ap.add_argument("--days", type=int, default=7, help="días hacia atrás a sincronizar")
    ap.add_argument("--venue", default="bois")
    args = ap.parse_args()

    if args.once:
        try:
            print(run_once(args.days, args.venue), flush=True)
        except BaseException as exc:  # noqa: BLE001
            msg = f"{type(exc).__name__}: {exc}".replace("\n", " ")[:400]
            print(f"::error title=Fallo sync-fudo::{msg}", flush=True)
            sys.exit(1)
        return

    print(f"Worker activo · cada {args.minutes} min · últimos {args.days} día(s)")
    while True:
        started = time.time()
        try:
            print(time.strftime("[%H:%M]"), run_once(args.days, args.venue), flush=True)
        except Exception:  # noqa: BLE001
            print(time.strftime("[%H:%M]"), "ERROR", flush=True)
            traceback.print_exc()
        elapsed = time.time() - started
        time.sleep(max(0, args.minutes * 60 - elapsed))


if __name__ == "__main__":
    main()
