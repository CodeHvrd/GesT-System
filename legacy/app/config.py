"""Configuración persistente del sistema."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CONFIG_PATH = ROOT / "config.json"
DB_PATH = DATA_DIR / "gestion.db"
STATIC_DIR = Path(__file__).resolve().parent / "static"

DEFAULT_SHEET_ID = ""

DEFAULT_CONFIG = {
    "sheet_id": DEFAULT_SHEET_ID,
    "sheet_url": (
        f"https://docs.google.com/spreadsheets/d/{DEFAULT_SHEET_ID}/edit" if DEFAULT_SHEET_ID else ""
    ),
    "restaurant": "Mi local",
    "tabs": {
        "gastos": {"name": "Gastos", "gid": 133421437},
        "ventas": {"name": "Import_Fudo_Detalle", "gid": 1305319188},
        "semanal": {"name": "Historico_Semanal", "gid": 70642287},
        "mensual": {"name": "Historico_Mensual", "gid": 1588207894},
        "procesamiento": {"name": "Procesamiento", "gid": 1369942727},
        "semana_actual": {"name": "Semana_Actual", "gid": 1910367920},
        "extras": {"name": "Hoja 10", "gid": 1443174277},
    },
    # Objetivos de CMV por categoría (tomados de Semana_Actual, "CMV Rentable").
    # Se usan para marcar la tabla y para alertar cuando una categoría se pasa.
    "cmv_targets": {
        "Cafetería": [15, 20],
        "Bakery": [25, 35],
        "Burgers": [30, 40],
        "Take Away": [30, 35],
        "Cervezas": [20, 30],
        "Tragos": [20, 30],
    },
    "google_api_key": "",
    "fudo": {
        "api_key": "",
        "api_secret": "",
        "auth_url": "https://auth.fu.do/api",
        "base_url": "https://api.fu.do/v1alpha1",
    },
    "webhook_url": "",
    "webhook_token": "",
    "auto_sync_minutes": 15,  # 0 = desactivado
    "weeks": "month",  # esquema de semanas del local
}


def load_config() -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if CONFIG_PATH.exists():
        try:
            stored = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
            _deep_update(cfg, stored)
        except Exception:
            pass
    return cfg


def save_config(cfg: dict) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


def _deep_update(base: dict, extra: dict) -> None:
    for k, v in extra.items():
        if isinstance(v, dict) and isinstance(base.get(k), dict):
            _deep_update(base[k], v)
        else:
            base[k] = v


def sheet_id_from_url(url: str) -> str | None:
    m = re.search(r"/spreadsheets/d/([a-zA-Z0-9_-]{20,})", url or "")
    return m.group(1) if m else None


def tab_url(cfg: dict, key: str) -> str:
    tab = cfg["tabs"].get(key, {})
    sid = cfg["sheet_id"]
    gid = tab.get("gid")
    return f"https://docs.google.com/spreadsheets/d/{sid}/edit#gid={gid}" if gid else cfg["sheet_url"]


def parse_targets_text(text: str) -> dict[str, list[float]]:
    """'Cafetería = 15-20' por línea -> {'Cafetería': [15.0, 20.0]}."""
    out: dict[str, list[float]] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            name, rest = line.split("=", 1)
        else:
            m = re.match(r"^(.*?)\s+(\d+(?:[.,]\d+)?\s*[-–]\s*\d+(?:[.,]\d+)?)$", line)
            if not m:
                continue
            name, rest = m.group(1), m.group(2)
        nums = re.findall(r"\d+(?:[.,]\d+)?", rest)
        if len(nums) < 2:
            continue
        lo, hi = float(nums[0].replace(",", ".")), float(nums[1].replace(",", "."))
        if lo > hi:
            lo, hi = hi, lo
        name = name.strip()
        if name:
            out[name] = [lo, hi]
    return out


def targets_text(cfg: dict) -> str:
    t = cfg.get("cmv_targets") or {}
    lines = []
    for name, rng in t.items():
        try:
            lo, hi = float(rng[0]), float(rng[1])
        except (TypeError, ValueError, IndexError):
            continue
        lines.append(f"{name} = {lo:g}-{hi:g}")
    return "\n".join(lines)
