"""Worker de sincronización Fudo → Postgres.

Corre una vez (para Task Scheduler/cron) o en loop cada N minutos.

Uso:
    python -m cloud.worker --once
    python -m cloud.worker --minutes 15
"""

from __future__ import annotations

import argparse
import time
import traceback
from datetime import date, timedelta

from . import db, ingest, recompute


def run_once(days: int = 1, venue: str = "bois") -> dict:
    db.load_env(".env")
    client = ingest.client_from_env()
    d1 = date.today()
    d0 = d1 - timedelta(days=days)
    with db.connect(direct=True) as pg:
        db.apply_schema(pg)
        vid = db.ensure_venue(pg, venue)
        out = {
            "ventas": ingest.sync_sales(pg, vid, client, d0, d1),
            "gastos": ingest.sync_expenses(pg, vid, client, d0, d1),
        }
        out["agregados"] = recompute.recompute(pg, vid)
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description="Sincronización periódica de Fudo")
    ap.add_argument("--once", action="store_true", help="una corrida y termina")
    ap.add_argument("--minutes", type=int, default=15, help="intervalo entre corridas")
    ap.add_argument("--days", type=int, default=1, help="días hacia atrás a sincronizar")
    ap.add_argument("--venue", default="bois")
    args = ap.parse_args()

    if args.once:
        print(run_once(args.days, args.venue))
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
