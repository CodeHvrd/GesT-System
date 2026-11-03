"""Sincronización con el Google Sheet del local.

Lee cada pestaña como CSV (export público, sin OAuth) y la normaliza en SQLite.
El Sheet debe estar compartido como "cualquiera con el enlace puede ver".
"""

from __future__ import annotations

import csv
import gzip
import hashlib
import io
import json
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

from . import db, util
from .config import tab_url

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) GestionLocal/1.0"
TIMEOUT = 45


# ------------------------------------------------------------------ descarga


def _http_get(url: str, timeout: int = TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        return raw


def fetch_tab_csv(cfg: dict, key: str) -> str:
    tab = cfg["tabs"].get(key) or {}
    sid = cfg["sheet_id"]
    gid = tab.get("gid")
    name = tab.get("name")
    errors = []
    if gid is not None:
        url = f"https://docs.google.com/spreadsheets/d/{sid}/export?format=csv&gid={gid}"
        try:
            return _http_get(url).decode("utf-8-sig", "replace")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"export csv gid={gid}: {exc}")
    if name:
        url = (
            f"https://docs.google.com/spreadsheets/d/{sid}/gviz/tq?tqx=out:csv&headers=0&sheet="
            + urllib.parse.quote(name)
        )
        try:
            return _http_get(url).decode("utf-8-sig", "replace")
        except Exception as exc:  # noqa: BLE001
            errors.append(f"gviz sheet={name}: {exc}")
    raise RuntimeError("No se pudo leer la pestaña. " + " | ".join(errors))


def parse_csv(text: str) -> list[list[str]]:
    rows = []
    for row in csv.reader(io.StringIO(text)):
        rows.append([c.strip() for c in row])
    return rows


def fetch_api_values(cfg: dict, key: str) -> list[list[str]]:
    """Lee una pestaña con la API v4 de Google Sheets (requiere API key)."""
    api_key = (cfg.get("google_api_key") or "").strip()
    if not api_key:
        raise RuntimeError("No hay API key configurada")
    tab = cfg["tabs"].get(key) or {}
    name = tab.get("name")
    if not name:
        raise RuntimeError(f"Pestaña desconocida: {key}")
    sid = cfg["sheet_id"]
    rng = "'" + name.replace("'", "''") + "'!A1:AZ100000"
    url = (
        f"https://sheets.googleapis.com/v4/spreadsheets/{sid}/values/"
        + urllib.parse.quote(rng, safe="'!:")
        + "?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&key="
        + urllib.parse.quote(api_key, safe="")
    )
    data = json.loads(_http_get(url).decode("utf-8"))
    rows = data.get("values") or []
    if not isinstance(rows, list):
        raise RuntimeError("Respuesta inesperada de la API")
    width = max((len(r) for r in rows), default=0)
    out = []
    for r in rows:
        cells = [str(c).strip() if c is not None else "" for c in r]
        out.append(cells + [""] * (width - len(cells)))
    return out


def fetch_tab(cfg: dict, key: str) -> tuple[list[list[str]], str, str | None]:
    """Devuelve (filas, método, aviso). Usa la API si hay key y cae a CSV si falla."""
    api_key = (cfg.get("google_api_key") or "").strip()
    if api_key:
        try:
            return fetch_api_values(cfg, key), "api", None
        except Exception as exc:  # noqa: BLE001
            note = f"La API de Google falló ({exc}); se usó el enlace CSV."
            return parse_csv(fetch_tab_csv(cfg, key)), "csv", note
    return parse_csv(fetch_tab_csv(cfg, key)), "csv", None


def discover_tabs(sheet_id: str) -> dict[str, int]:
    """Intenta descubrir nombre -> gid leyendo la página /edit (best effort)."""
    try:
        html = _http_get(f"https://docs.google.com/spreadsheets/d/{sheet_id}/edit", timeout=30).decode(
            "utf-8", "replace"
        )
    except Exception:
        return {}
    found = re.findall(r'\\?"(\d{6,})\\?",\[\{\\?"1\\?":\[\[0,0,\\?"([^"\\]+)\\?"', html)
    out = {}
    for gid, name in found:
        out[name.strip()] = int(gid)
    return out


# ------------------------------------------------------------------ helpers


def _norm_key(s: str) -> str:
    s = unicodedata.normalize("NFKD", (s or "").strip().lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.replace("%", "pct")
    return re.sub(r"[^a-z0-9]", "", s)


def _h(*parts) -> str:
    return hashlib.sha1("|".join("" if p is None else str(p) for p in parts).encode("utf-8")).hexdigest()


def _clean(s) -> str:
    return re.sub(r"\s+", " ", (s or "").replace("\u200b", "").replace("\xa0", " ")).strip()


def _is_blank(row) -> bool:
    return not any((c or "").strip() for c in row)


def _find_header(rows: list[list[str]], required: str, limit: int = 15) -> int | None:
    for i, row in enumerate(rows[:limit]):
        keys = [_norm_key(c) for c in row]
        if required in keys:
            return i
    return None


def _columns(header: list[str]) -> dict[str, int]:
    out: dict[str, int] = {}
    for i, cell in enumerate(header):
        k = _norm_key(cell)
        if not k or k in out:
            continue
        out[k] = i
    return out


# ------------------------------------------------------------------ gastos


def normalize_expenses(rows: list[list[str]]) -> tuple[list[dict], list[str], list[str]]:
    warnings: list[str] = []
    info: list[str] = []
    hi = _find_header(rows, "fecha")
    if hi is None:
        # ¿ya viene sin encabezado? probamos posicional
        hi = -1
        cols = {"fecha": 0, "mes": 1, "tipo": 2, "categoria": 3, "subcategoria": 4,
                "descripcion": 5, "monto": 6, "validacion": 7}
        info.append("Gastos sin encabezado reconocible: se leyó por posición.")
    else:
        cols = _columns(rows[hi])
        missing = [c for c in ("fecha", "monto") if c not in cols]
        if missing:
            raise RuntimeError(f"Faltan columnas en Gastos: {missing}")

    def get(row, name, default=""):
        idx = cols.get(name)
        if idx is None or idx >= len(row):
            return default
        return row[idx]

    out: list[dict] = []
    bad_dates = 0
    bad_amounts = 0
    for offset, row in enumerate(rows[hi + 1 :]):
        if _is_blank(row):
            continue
        raw_fecha = _clean(get(row, "fecha"))
        raw_monto = _clean(get(row, "monto"))
        if not raw_fecha and not raw_monto:
            continue
        d = util.parse_date(raw_fecha)
        if not d:
            bad_dates += 1
            if bad_dates <= 3:
                warnings.append(f"Fila {hi + offset + 2}: fecha inválida «{raw_fecha}»")
            continue
        monto = util.parse_number(raw_monto)
        if monto is None:
            bad_amounts += 1
            if bad_amounts <= 3:
                warnings.append(
                    f"Fila {hi + offset + 2}: sin monto cargado (se tomó 0)" if not raw_monto else f"Fila {hi + offset + 2}: monto inválido «{raw_monto}»"
                )
            monto = 0.0
        mes_raw = _clean(get(row, "mes"))
        mes = util.parse_month_key(mes_raw) or d.strftime("%Y-%m")
        tipo = _clean(get(row, "tipo")) or "Variable"
        tipo = "Fijo" if tipo.lower().startswith("fij") else ("Variable" if tipo.lower().startswith("var") else tipo)
        cat = _clean(get(row, "categoria")) or "Sin categoría"
        sub = _clean(get(row, "subcategoria"))
        desc = _clean(get(row, "descripcion"))
        out.append(
            {
                "hash": _h(d.isoformat(), mes, tipo, cat, sub, desc, round(monto, 2), offset),
                "fecha": d.isoformat(),
                "mes": mes,
                "tipo": tipo,
                "categoria": cat,
                "subcategoria": sub,
                "descripcion": desc,
                "monto": monto,
                "validacion": _clean(get(row, "validacion")),
                "source_row": hi + offset + 2,
            }
        )
    if bad_dates:
        warnings.append(f"{bad_dates} fila{'s' if bad_dates != 1 else ''} de Gastos con fecha inválida (omitida{'s' if bad_dates != 1 else ''}).")
    if bad_amounts:
        warnings.append(f"{bad_amounts} fila{'s' if bad_amounts != 1 else ''} de Gastos con monto inválido (tomada{'s' if bad_amounts != 1 else ''} como 0).")
    return out, warnings, info


# ------------------------------------------------------------------ ventas (Fudo)


def normalize_sales(rows: list[list[str]]) -> tuple[list[dict], list[str], list[str]]:
    warnings: list[str] = []
    info: list[str] = []
    start = 0
    if rows and _norm_key(rows[0][0]) in ("fecha", "dia", "date"):
        start = 1
        info.append("Se detectó encabezado en Import_Fudo_Detalle.")
    out: list[dict] = []
    bad = 0
    for offset, row in enumerate(rows[start:]):
        if len(row) < 6 or _is_blank(row):
            continue
        d = util.parse_date(_clean(row[0]))
        if not d:
            bad += 1
            continue
        prod = _clean(row[3]) if len(row) > 3 else ""
        ventas = util.parse_number(row[5]) or 0.0
        cmv = util.parse_number(row[6]) or 0.0
        out.append(
            {
                "fecha": d.isoformat(),
                "mes": d.strftime("%Y-%m"),
                "semana": util.week_key(d),
                "categoria": _clean(row[1]) or "Sin categoría",
                "subcategoria": _clean(row[2]),
                "producto": prod or "Sin producto",
                "cantidad": util.parse_number(row[4]) or 0.0,
                "ventas": ventas,
                "cmv": cmv,
                "cmv_pct": util.parse_percent(row[7]) if len(row) > 7 and row[7] else None,
                "costo_unit": util.parse_number(row[8]) if len(row) > 8 and row[8] else None,
                "source_row": offset + start + 1,
            }
        )
    if bad:
        warnings.append(f"{bad} filas de ventas con fecha inválida (omitidas).")
    # agregado por (fecha, categoria, producto) por si el export viene partido
    agg: dict[tuple, dict] = {}
    for r in out:
        k = (r["fecha"], r["categoria"], r["producto"])
        if k in agg:
            a = agg[k]
            a["cantidad"] += r["cantidad"]
            a["ventas"] += r["ventas"]
            a["cmv"] += r["cmv"]
        else:
            agg[k] = dict(r)
    final = []
    for r in agg.values():
        r["hash"] = _h(r["fecha"], r["categoria"], r["producto"])
        final.append(r)
    return final, warnings, info


# ------------------------------------------------------------------ historico semanal


def normalize_weekly(rows: list[list[str]]) -> tuple[list[dict], list[str], list[str]]:
    warnings: list[str] = []
    info: list[str] = []
    hi = _find_header(rows, "semana")
    if hi is None:
        raise RuntimeError("No se encontró la fila de encabezados en Historico_Semanal.")
    cols = _columns(rows[hi])
    if "semana" not in cols or "categoria" not in cols:
        raise RuntimeError("Historico_Semanal no tiene columnas Semana/Categoría.")

    def get(row, name):
        idx = cols.get(name)
        return row[idx] if idx is not None and idx < len(row) else ""

    out: list[dict] = []
    bad = 0
    for offset, row in enumerate(rows[hi + 1 :]):
        if _is_blank(row):
            continue
        semana = _clean(get(row, "semana"))
        cat = _clean(get(row, "categoria"))
        if not re.fullmatch(r"\d{4}-\d{2}-S\d", semana) or not cat:
            bad += 1
            continue
        ventas = util.parse_number(get(row, "ventas")) or 0.0
        cmv = util.parse_number(get(row, "cmv")) or 0.0
        ganancia = util.parse_number(get(row, "ganancia"))
        if ganancia is None:
            ganancia = ventas - cmv
        out.append(
            {
                "hash": _h(semana, cat),
                "mes": util.parse_month_key(get(row, "mes")) or semana[:7],
                "semana": semana,
                "categoria": cat,
                "cantidad": util.parse_number(get(row, "cantidad")) or 0.0,
                "ventas": ventas,
                "cmv": cmv,
                "ganancia": ganancia,
                "cmv_pct": util.parse_percent(get(row, "cmvpct")) if get(row, "cmvpct") else None,
                "participacion": util.parse_percent(get(row, "participacion")) if get(row, "participacion") else None,
                "observaciones": _clean(get(row, "observaciones")),
                "source_row": hi + offset + 2,
            }
        )
    if bad:
        info.append(f"{bad} fila{'s' if bad != 1 else ''} de Historico_Semanal sin semana/categoría válida (omitida{'s' if bad != 1 else ''}).")
    # dedupe por semana+categoria, conservando la fila con observaciones
    dedup: dict[tuple, dict] = {}
    dupes = 0
    for r in out:
        k = (r["semana"], r["categoria"])
        if k in dedup:
            dupes += 1
            prev = dedup[k]
            if not prev.get("observaciones") and r.get("observaciones"):
                dedup[k] = r
        else:
            dedup[k] = r
    if dupes:
        info.append(f"{dupes} filas duplicadas en Historico_Semanal (se conservó una por semana/categoría).")
    return list(dedup.values()), warnings, info


# ------------------------------------------------------------------ historico mensual


def normalize_monthly(rows: list[list[str]]) -> tuple[list[dict], list[str], list[str]]:
    warnings: list[str] = []
    info: list[str] = []
    out: list[dict] = []
    # La primera tabla del sheet es un "mes analizado" en curso (snapshot);
    # después del título "Registro histórico..." empieza el historial de cierres.
    snapshot_mode = True
    for idx, row in enumerate(rows):
        if _is_blank(row):
            continue
        joined = " ".join(row).lower()
        if "registro historico" in joined or "registro histórico" in joined:
            snapshot_mode = False
            continue
        mes_idx = mes = None
        for i, cell in enumerate(row):
            if re.fullmatch(r"\d{4}-\d{2}", (cell or "").strip()):
                mes_idx, mes = i, cell.strip()
                break
            if re.fullmatch(r"20\d{3}-\d{2}", (cell or "").strip()):
                mes_idx, mes = i, util.parse_month_key(cell)
                warnings.append(f"Historico_Mensual fila {idx + 1}: mes con typo «{cell.strip()}» (se leyó {mes}).")
                break
        if not mes or mes_idx is None:
            continue
        vals = row[mes_idx + 1 : mes_idx + 8]
        if len(vals) < 6:
            continue
        nums = [util.parse_number(v) for v in vals]
        if nums[0] is None or nums[1] is None:
            continue
        ventas, cmv = nums[0] or 0.0, nums[1] or 0.0
        bruto = nums[2] if nums[2] is not None else ventas - cmv
        cmv_pct = util.parse_percent(vals[3]) if vals[3] else (util.safe_div(cmv, ventas) or 0) * 100
        gastos = nums[4] or 0.0
        resultado = nums[5] if nums[5] is not None else ventas - cmv - gastos
        margen = util.parse_percent(vals[6]) if len(vals) > 6 and vals[6] else (util.safe_div(resultado, ventas) or 0) * 100
        out.append(
            {
                "hash": _h(mes, "snap" if snapshot_mode else "hist"),
                "mes": mes,
                "ventas": ventas,
                "cmv": cmv,
                "bruto": bruto,
                "cmv_pct": cmv_pct,
                "gastos": gastos,
                "resultado": resultado,
                "margen": margen,
                "snapshot": 1 if snapshot_mode else 0,
                "source_row": idx + 1,
            }
        )
    if not out:
        warnings.append("No se pudo leer ningún mes en Historico_Mensual.")
    return out, warnings, info


# ------------------------------------------------------------------ guardado


def _replace_expenses(conn, items: list[dict]) -> None:
    conn.execute("DELETE FROM expenses")
    conn.executemany(
        "INSERT INTO expenses(hash, fecha, mes, tipo, categoria, subcategoria, descripcion, monto, validacion, source_row)"
        " VALUES(:hash,:fecha,:mes,:tipo,:categoria,:subcategoria,:descripcion,:monto,:validacion,:source_row)",
        items,
    )


def _replace_sales_weeks(conn, items: list[dict], batch: str, source: str = "sheet") -> int:
    weeks = sorted({i["semana"] for i in items})
    if not weeks:
        return 0
    qs = ",".join("?" for _ in weeks)
    conn.execute(f"DELETE FROM sales WHERE semana IN ({qs})", weeks)
    conn.executemany(
        "INSERT INTO sales(hash, fecha, mes, semana, categoria, subcategoria, producto, cantidad, ventas, cmv, cmv_pct, costo_unit, import_batch, source, source_row)"
        " VALUES(:hash,:fecha,:mes,:semana,:categoria,:subcategoria,:producto,:cantidad,:ventas,:cmv,:cmv_pct,:costo_unit,:import_batch,:source,:source_row)",
        [{**i, "import_batch": batch, "source": source, "source_row": i.get("source_row")} for i in items],
    )
    return len(weeks)


def _replace_weekly(conn, items: list[dict]) -> None:
    conn.execute("DELETE FROM weekly_history")
    conn.executemany(
        "INSERT INTO weekly_history(hash, mes, semana, categoria, cantidad, ventas, cmv, ganancia, cmv_pct, participacion, observaciones, source_row)"
        " VALUES(:hash,:mes,:semana,:categoria,:cantidad,:ventas,:cmv,:ganancia,:cmv_pct,:participacion,:observaciones,:source_row)",
        items,
    )


def _replace_monthly(conn, items: list[dict]) -> None:
    conn.execute("DELETE FROM monthly_history")
    conn.executemany(
        "INSERT INTO monthly_history(hash, mes, ventas, cmv, bruto, cmv_pct, gastos, resultado, margen, snapshot, source_row)"
        " VALUES(:hash,:mes,:ventas,:cmv,:bruto,:cmv_pct,:gastos,:resultado,:margen,:snapshot,:source_row)",
        items,
    )


# ------------------------------------------------------------------ sync


def sync_all(cfg: dict, only: str | None = None) -> dict:
    started = time.time()
    report = {"ok": True, "started": datetime.now().isoformat(timespec="seconds"), "tabs": []}
    batch = datetime.now().strftime("%Y-%m-%dT%H:%M:%S")
    targets = [only] if only else ["gastos", "ventas", "semanal", "mensual"]
    with db.db() as conn:
        for key in targets:
            t0 = time.time()
            tab = cfg["tabs"].get(key, {})
            entry = {"key": key, "name": tab.get("name"), "url": tab_url(cfg, key), "warnings": [], "info": []}
            conn.execute("SAVEPOINT tab")
            try:
                rows, method, note = fetch_tab(cfg, key)
                entry["method"] = method
                if key == "gastos":
                    items, warns, info = normalize_expenses(rows)
                    _replace_expenses(conn, items)
                elif key == "ventas":
                    items, warns, info = normalize_sales(rows)
                    fudo_weeks = {
                        r["semana"]
                        for r in conn.execute("SELECT DISTINCT semana FROM sales WHERE source = 'fudo'")
                    }
                    protected = sorted({i["semana"] for i in items} & fudo_weeks)
                    if protected:
                        items = [i for i in items if i["semana"] not in fudo_weeks]
                        info.append(
                            "Se conservaron las semanas traídas de Fudo (la planilla no las pisa): "
                            + ", ".join(protected)
                            + "."
                        )
                    weeks = _replace_sales_weeks(conn, items, batch)
                    if weeks:
                        info.append(f"{weeks} semana(s) de ventas actualizadas desde la planilla.")
                elif key == "semanal":
                    items, warns, info = normalize_weekly(rows)
                    _replace_weekly(conn, items)
                elif key == "mensual":
                    items, warns, info = normalize_monthly(rows)
                    _replace_monthly(conn, items)
                else:
                    raise RuntimeError(f"Pestaña desconocida: {key}")
                if note:
                    warns = [note] + warns
                conn.execute("RELEASE tab")
                entry.update(
                    status="ok",
                    rows=len(items),
                    warnings=warns,
                    info=info,
                    ms=int((time.time() - t0) * 1000),
                )
            except Exception as exc:  # noqa: BLE001
                conn.execute("ROLLBACK TO tab")
                conn.execute("RELEASE tab")
                report["ok"] = False
                entry.update(status="error", rows=0, message=str(exc), ms=int((time.time() - t0) * 1000))
            db.log_sync(
                conn,
                key,
                entry["status"],
                entry.get("rows", 0),
                entry.get("message") or "; ".join(entry.get("warnings", [])[:3]),
                entry["ms"],
            )
            report["tabs"].append(entry)

        db.log_sync(conn, "_all", "ok" if report["ok"] else "error", 0, "", int((time.time() - started) * 1000))
        report["finished"] = datetime.now().isoformat(timespec="seconds")
        report["duration_ms"] = int((time.time() - started) * 1000)
        db.set_setting(conn, "last_sync", report)
        db.set_setting(conn, "last_sync_at", report["finished"])
        # confirmar cargas locales que ya aparecieron en el sheet
        _confirm_entries(conn)

    return report


def _confirm_entries(conn) -> None:
    rows = conn.execute("SELECT * FROM entries WHERE estado = 'pendiente'").fetchall()
    for r in rows:
        hit = conn.execute(
            "SELECT 1 FROM expenses WHERE fecha = ? AND monto = ? AND lower(descripcion) = lower(?) LIMIT 1",
            (r["fecha"], r["monto"], r["descripcion"] or ""),
        ).fetchone()
        if hit:
            conn.execute("UPDATE entries SET estado = 'confirmada' WHERE id = ?", (r["id"],))
