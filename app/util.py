"""Utilidades de fechas, semanas, números y formato (es-AR)."""

from __future__ import annotations

import calendar
import re
from datetime import date, datetime, timedelta

MESES = {
    1: "enero", 2: "febrero", 3: "marzo", 4: "abril", 5: "mayo", 6: "junio",
    7: "julio", 8: "agosto", 9: "septiembre", 10: "octubre", 11: "noviembre", 12: "diciembre",
}
MESES_CORTO = {
    1: "ene", 2: "feb", 3: "mar", 4: "abr", 5: "may", 6: "jun",
    7: "jul", 8: "ago", 9: "sep", 10: "oct", 11: "nov", 12: "dic",
}

# ---------------------------------------------------------------- números


def parse_number(value) -> float | None:
    """Convierte montos es-AR/en-US a float. Devuelve None si no hay número."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip()
    if not s:
        return None
    neg = False
    if s.startswith("(") and s.endswith(")"):
        neg = True
        s = s[1:-1]
    s = s.replace("\u2212", "-").replace("%", "").replace("$", "")
    s = s.replace("ARS", "").replace("U$S", "").replace(" ", "").replace("\xa0", "")
    if s.startswith("-"):
        neg = True
        s = s[1:]
    s = re.sub(r"[^0-9.,]", "", s)
    if not s:
        return None
    has_comma, has_dot = "," in s, "." in s
    if has_comma and has_dot:
        # el último separador es el decimal
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif has_comma:
        parts = s.split(",")
        if len(parts) == 2 and len(parts[1]) == 3 and len(parts[0]) > 3:
            s = s.replace(",", "")  # 1,234 -> miles
        else:
            s = s.replace(",", ".")
    elif has_dot:
        parts = s.split(".")
        if len(parts) > 2 or (len(parts) == 2 and len(parts[1]) == 3 and len(parts[0]) >= 1 and not s.startswith("0.")):
            s = s.replace(".", "")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def parse_percent(value) -> float | None:
    """Devuelve puntos porcentuales (35,7% -> 35.7). Acepta 0,357 -> 35.7."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        v = float(value)
        return v * 100 if 0 < abs(v) <= 1.5 else v
    s = str(value).strip()
    if not s:
        return None
    explicit = "%" in s
    v = parse_number(s)
    if v is None:
        return None
    if not explicit and 0 < abs(v) <= 1.5:
        return v * 100
    return v


def parse_int(value) -> int | None:
    v = parse_number(value)
    return int(round(v)) if v is not None else None


DATE_FORMATS = ("%d/%m/%Y", "%d-%m-%Y", "%d/%m/%y", "%Y-%m-%d", "%d.%m.%Y", "%m/%d/%Y")


def parse_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    s = str(value).strip()
    if not s:
        return None
    s = s.split(" ")[0].split("T")[0]
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    # serial de excel
    try:
        f = float(s)
        if 20000 < f < 60000:
            return date(1899, 12, 30) + timedelta(days=int(f))
    except ValueError:
        pass
    return None


def iso(d: date | None) -> str | None:
    return d.isoformat() if d else None


def parse_month_key(value) -> str | None:
    """'2026-08' / '20226-10' / 'agosto 2026' -> 'YYYY-MM' (corrige typos de año)."""
    if not value:
        return None
    s = str(value).strip().lower()
    m = re.search(r"(\d{4,5})-(\d{1,2})", s)
    if m:
        year, month = m.group(1), int(m.group(2))
        if len(year) == 5 and year.startswith("202"):
            year = year[1:]
        if 1 <= month <= 12:
            return f"{int(year):04d}-{month:02d}"
    for num, name in MESES.items():
        if name in s:
            y = re.search(r"(20\d{2})", s)
            if y:
                return f"{y.group(1)}-{num:02d}"
    return None


# ---------------------------------------------------------------- semanas
# El local usa semanas relativas al mes: S1 = 1-7, S2 = 8-14, S3 = 15-21,
# S4 = 22-28, S5 = 29-fin de mes. Verificado contra Historico_Semanal.


def week_key(d: date) -> str:
    idx = (d.day - 1) // 7 + 1
    return f"{d.year:04d}-{d.month:02d}-S{idx}"


def week_bounds(key: str) -> tuple[date, date]:
    m = re.fullmatch(r"(\d{4})-(\d{2})-S(\d)", key)
    if not m:
        raise ValueError(f"Semana inválida: {key}")
    year, month, idx = int(m.group(1)), int(m.group(2)), int(m.group(3))
    last = calendar.monthrange(year, month)[1]
    start = date(year, month, 1) + timedelta(days=7 * (idx - 1))
    end = min(date(year, month, 1) + timedelta(days=7 * idx - 1), date(year, month, last))
    if start > date(year, month, last):
        start = end = date(year, month, last)
    return start, end


def week_index(key: str) -> int:
    return int(key[-1])


def prev_week(key: str) -> str:
    year, month = int(key[:4]), int(key[5:7])
    idx = week_index(key)
    if idx > 1:
        return f"{year:04d}-{month:02d}-S{idx - 1}"
    month -= 1
    if month == 0:
        year, month = year - 1, 12
    last = calendar.monthrange(year, month)[1]
    return f"{year:04d}-{month:02d}-S{(last - 1) // 7 + 1}"


def next_week(key: str) -> str:
    year, month = int(key[:4]), int(key[5:7])
    idx = week_index(key)
    last = calendar.monthrange(year, month)[1]
    if idx < (last - 1) // 7 + 1:
        return f"{year:04d}-{month:02d}-S{idx + 1}"
    month += 1
    if month == 13:
        year, month = year + 1, 1
    return f"{year:04d}-{month:02d}-S1"


def prev_month(month: str) -> str:
    year, m = int(month[:4]), int(month[5:7])
    m -= 1
    if m == 0:
        year, m = year - 1, 12
    return f"{year:04d}-{m:02d}"


def next_month(month: str) -> str:
    year, m = int(month[:4]), int(month[5:7])
    m += 1
    if m == 13:
        year, m = year + 1, 1
    return f"{year:04d}-{m:02d}"


def same_week_prev_month(key: str) -> str:
    return f"{prev_month(key[:7])}-S{week_index(key)}"


def week_label(key: str) -> str:
    start, end = week_bounds(key)
    if start == end:
        return f"{start.day} {MESES_CORTO[start.month]}"
    if start.month == end.month:
        return f"{start.day}–{end.day} {MESES_CORTO[start.month]}"
    return f"{start.day} {MESES_CORTO[start.month]} – {end.day} {MESES_CORTO[end.month]}"


def month_label(month: str, short: bool = False) -> str:
    year, m = int(month[:4]), int(month[5:7])
    name = MESES_CORTO[m] if short else MESES[m]
    return f"{name} {year}"


def current_week(today: date | None = None) -> str:
    return week_key(today or date.today())


# ---------------------------------------------------------------- formato


def money(v, decimals: int = 0) -> str:
    if v is None:
        return "—"
    v = float(v)
    sign = "-" if v < 0 else ""
    s = f"{abs(v):,.{decimals}f}"
    s = s.replace(",", "X").replace(".", ",").replace("X", ".")
    return f"{sign}${s}"


def number(v, decimals: int = 0) -> str:
    if v is None:
        return "—"
    s = f"{float(v):,.{decimals}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def pct(v, decimals: int = 1) -> str:
    if v is None:
        return "—"
    s = f"{float(v):,.{decimals}f}"
    return s.replace(".", ",") + "%"


def signed(v, decimals: int = 1, suffix: str = "") -> str:
    if v is None:
        return "—"
    sign = "+" if v > 0 else ""
    return f"{sign}{number(v, decimals)}{suffix}"


def pct_points(v) -> str:
    if v is None:
        return "—"
    sign = "+" if v > 0 else ""
    return f"{sign}{number(v, 1)} pts"


def safe_div(a, b):
    try:
        return a / b if b else None
    except ZeroDivisionError:
        return None
