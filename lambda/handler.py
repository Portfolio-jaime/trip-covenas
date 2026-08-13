"""
Covenas trip dashboard - summary Lambda.

GET /api/summary handler for the family trip budget dashboard.

Reads the live "Gastos_Covenas" Google Sheet (read-only, via a Google
Service Account) directly through the Sheets API v4 REST endpoint, applies
the same cost-splitting business logic as the `Balance` tab of the
workbook, and returns a single JSON payload for the static frontend.

Design notes
------------
- Uses `google-auth` + `requests` only (no `google-api-python-client`) to
  keep the deployment package small enough to zip without a Lambda layer.
  `google-auth` gives us JWT/service-account signing and token refresh;
  `requests` is the HTTP transport for both the OAuth token exchange (via
  `google.auth.transport.requests.Request`) and the Sheets API calls
  themselves.
- The service account JSON key is never embedded here. It is fetched at
  runtime from AWS SSM Parameter Store (SecureString) and cached in memory
  for the lifetime of the warm Lambda execution environment.
- Values are requested with `valueRenderOption=UNFORMATTED_VALUE` and
  `dateTimeRenderOption=SERIAL_NUMBER` so dates/numbers come back as raw
  numbers (Sheets/Excel serial dates) instead of locale-formatted strings
  that would be fragile to parse.
- All "which column is what" lookups are header-driven (normalized,
  accent-stripped, case-insensitive), not hardcoded column letters, so a
  reordered column in the sheet doesn't silently break parsing.
"""

from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
from typing import Any

import requests
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2 import service_account

logger = logging.getLogger()
logger.setLevel(logging.INFO)

SHEETS_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]
SHEETS_API_BASE = "https://sheets.googleapis.com/v4/spreadsheets"

# Sheet tab + range names we read in a single batchGet call. Ranges are
# generously sized (well past the current data) so the sheet can grow
# without needing a code change.
RANGE_CABANA = "Cabaña!A1:C20"
RANGE_PERSONAS = "Personas!A1:F60"
RANGE_ABONOS = "Abonos!A1:F500"
RANGE_GASTOS = "Gastos!A1:F1000"
# Every other tab (Estimado, Tesla, Carros, and whatever gets added later)
# is free-form (sections of label/value pairs mixed with the odd table),
# not a clean header+rows table like the four above - they're discovered
# dynamically and read raw, rendered generically by the frontend rather
# than modeled here. See `_list_extra_sheet_titles` and `_trim_grid`.

# Header names as they appear in the workbook, normalized (lowercase,
# accents stripped). Used to locate columns by name instead of by letter.
# Each is a tuple of accepted synonyms, not just the exact current header -
# a family member renaming "Valor" to "Monto" (a plausible rename, unlike
# some random new name) keeps working instead of silently going blank.
# This is a mitigation, not a guarantee: a rename to something not listed
# here still isn't found - there's no way to auto-detect an arbitrary
# rename without risking guessing the wrong column.
COL_NOMBRE = ("nombre", "persona", "quien")
COL_GRUPO = ("grupo familiar", "grupo")
COL_NOCHES = ("noches en cabana", "noches")
COL_NOTA = ("nota", "notas")
COL_FECHA = ("fecha", "dia")  # "día" normalizes to "dia" already, no separate entry needed
COL_CONCEPTO = ("concepto", "detalle")
COL_VALOR = ("valor", "monto", "cantidad", "precio")
COL_QUIEN_PAGO = ("quien pago", "pagador")
COL_CATEGORIA = ("categoria", "tipo")
COL_DESCRIPCION = ("descripcion", "detalle")
COL_PARTICIPA = ("participa gastos variables (si/no)", "participa gastos variables", "participa")

# Generic keywords used to flag a group as "pending/unconfirmed". Matched,
# accent- and case-insensitively, against the group's raw label (from the
# `Grupo familiar` column) and every member's `Nota` cell. Deliberately NOT
# name-based (no "Julián" literal anywhere in this file) - whichever group
# ends up carrying one of these markers in the live sheet gets flagged.
PENDING_KEYWORDS = (
    "sin confirmar",
    "por confirmar",
    "no confirmado",
    "unconfirmed",
    "pendiente confirmar",
    "ajustar",
    "extra",
)

# Google Sheets/Excel serial-date epoch (day 0 = 1899-12-30).
_SERIAL_EPOCH = datetime(1899, 12, 30)

# Module-level caches so a warm Lambda execution environment doesn't repay
# the SSM + Google OAuth round trips on every request.
_cached_credentials: service_account.Credentials | None = None
_cached_service_account_info: dict | None = None


# --------------------------------------------------------------------------
# Small parsing helpers
# --------------------------------------------------------------------------


def _normalize(value: Any) -> str:
    """Lowercase, accent-stripped, whitespace-trimmed text for matching."""
    if value is None:
        return ""
    text = str(value).strip().lower()
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return text


def _to_number(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return float(str(value).replace(",", "").strip())
    except ValueError:
        return 0.0


def _to_money_int(value: Any) -> int:
    return int(round(_to_number(value)))


def _serial_to_date(value: Any) -> date | None:
    """Convert a Sheets serial-number date (or a plain date string, as a
    defensive fallback) into a `date`."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return (_SERIAL_EPOCH + timedelta(days=float(value))).date()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(str(value), fmt).date()
        except ValueError:
            continue
    return None


def _date_iso(value: Any) -> str | None:
    d = _serial_to_date(value)
    return d.isoformat() if d else None


def _join_names_es(names: list[str]) -> str:
    """'Andrés' | 'Andrés y Diana' | 'Andrés, Diana y Thomas'."""
    names = [n for n in names if n]
    if not names:
        return ""
    if len(names) == 1:
        return names[0]
    if len(names) == 2:
        return f"{names[0]} y {names[1]}"
    return ", ".join(names[:-1]) + f" y {names[-1]}"


# --------------------------------------------------------------------------
# Generic (header-driven) table parsing
# --------------------------------------------------------------------------


_ColNames = str | tuple[str, ...]


def _find_header_row(
    values: list[list[Any]], required_col: _ColNames
) -> tuple[int, dict[str, int], list[Any]]:
    """Find the first row containing `required_col` (normalized - accepts
    either one name or a tuple of accepted synonyms) and build a
    {normalized_header: column_index} map from that row, plus the row's
    original (unnormalized) cell text for display purposes (see
    `_extra_fields`).

    Returns (-1, {}, []) if no such header row is found (e.g. empty/blank tab).
    """
    candidates = (required_col,) if isinstance(required_col, str) else required_col
    for i, row in enumerate(values or []):
        norm_cells = [_normalize(c) for c in row]
        if any(c in norm_cells for c in candidates):
            colmap = {c: idx for idx, c in enumerate(norm_cells) if c}
            return i, colmap, row
    return -1, {}, []


def _cell(row: list[Any], colmap: dict[str, int], name: _ColNames, default: Any = None) -> Any:
    candidates = (name,) if isinstance(name, str) else name
    idx = next((colmap[c] for c in candidates if c in colmap), None)
    if idx is None or idx >= len(row):
        return default
    val = row[idx]
    return val if val not in (None, "") else default


def _extra_fields(
    row: list[Any], colmap: dict[str, int], header_row: list[Any], known_cols: frozenset[str]
) -> dict[str, Any]:
    """Any column in this row that isn't one of `known_cols` (the aliases
    this sheet's row_factory already reads) - captured generically, keyed
    by the column's actual header text, so a brand-new column a family
    member adds shows up in the dashboard automatically instead of being
    silently dropped. Column order in the sheet is preserved."""
    extra: dict[str, Any] = {}
    for norm_header, idx in sorted(colmap.items(), key=lambda kv: kv[1]):
        if norm_header in known_cols:
            continue
        if idx < len(row) and row[idx] not in (None, ""):
            label = str(header_row[idx]) if idx < len(header_row) else norm_header
            extra[label] = row[idx]
    return extra


def _parse_rows(
    values: list[list[Any]],
    required_col: _ColNames,
    row_factory,
    known_cols: frozenset[str] = frozenset(),
) -> list[dict]:
    header_idx, colmap, header_row = _find_header_row(values, required_col)
    if header_idx == -1:
        return []
    results = []
    for row in values[header_idx + 1 :]:
        cell_value = _cell(row, colmap, required_col)
        if cell_value is None:
            continue  # skip blank/unused pre-allocated rows
        # Every one of these sheets ends with a "Total X:" / "TOTAL X:"
        # summary row (Personas' "Total noches-persona:", Abonos' "TOTAL
        # ABONADO:", Gastos' "TOTAL GASTOS:") whose label sits in this same
        # required column, so it isn't blank and slips past the check
        # above. Without filtering it out, its own already-summed value
        # gets folded into the sum *again* one level up (e.g.
        # total_noches_persona, total_gastos), silently doubling it.
        if str(cell_value).strip().lower().startswith("total"):
            continue
        item = row_factory(row, colmap)
        item["extra"] = _extra_fields(row, colmap, header_row, known_cols)
        results.append(item)
    return results


def _flatten(*groups: _ColNames) -> frozenset[str]:
    out: set[str] = set()
    for g in groups:
        out.update((g,) if isinstance(g, str) else g)
    return frozenset(out)


# --------------------------------------------------------------------------
# Sheet-specific parsing
# --------------------------------------------------------------------------


def _extract_condominio(estado_text: str) -> str:
    """'Reservada (cabaña #2, Condominio Victoria Real)' ->
    'Condominio Victoria Real, cabaña #2'. Falls back to the raw
    parenthetical (or the full estado text) if the pattern doesn't match,
    so this degrades gracefully rather than raising.
    """
    if not estado_text:
        return ""
    paren = re.search(r"\(([^)]*)\)", estado_text)
    inner = paren.group(1) if paren else estado_text

    cabana_match = re.search(r"caba[nñ]a\s*#?\s*(\S+)", inner, re.IGNORECASE)
    condo_match = re.search(r"condominio\s+(.+)", inner, re.IGNORECASE)

    if condo_match and cabana_match:
        condo_name = condo_match.group(1).split(",")[0].strip()
        cabana_num = cabana_match.group(1).rstrip(",").strip()
        return f"Condominio {condo_name}, cabaña #{cabana_num}"
    return inner.strip()


def parse_cabana(values: list[list[Any]]) -> dict:
    """Cabaña tab is laid out as label/value pairs in columns A/B, not a
    header+rows table, so it gets its own simple label->value map."""
    label_map: dict[str, Any] = {}
    for row in values or []:
        if not row:
            continue
        label = _normalize(row[0])
        if not label:
            continue
        label_map[label] = row[1] if len(row) > 1 else None

    d_inicio = _serial_to_date(label_map.get("fecha de entrada"))
    d_fin = _serial_to_date(label_map.get("fecha de salida"))
    noches = (d_fin - d_inicio).days if d_inicio and d_fin else 0

    return {
        "inicio": d_inicio.isoformat() if d_inicio else None,
        "fin": d_fin.isoformat() if d_fin else None,
        "noches": noches,
        "costoTotal": _to_money_int(label_map.get("costo total cabana")),
        "costoPorNoche": _to_money_int(label_map.get("costo por noche (base 12 pers.)")),
        "fechaLimitePago": str(label_map.get("fecha limite de pago") or "").strip(),
        "condominio": _extract_condominio(str(label_map.get("estado") or "")),
        "linkReserva": str(label_map.get("link reserva (airbnb)") or "").strip(),
    }


def parse_personas(values: list[list[Any]]) -> list[dict]:
    def row_factory(row, colmap):
        participa_raw = _normalize(_cell(row, colmap, COL_PARTICIPA, ""))
        return {
            "nombre": str(_cell(row, colmap, COL_NOMBRE, "")).strip(),
            "grupo": str(_cell(row, colmap, COL_GRUPO, "")).strip(),
            "noches": _to_number(_cell(row, colmap, COL_NOCHES, 0)),
            "participaGastos": participa_raw == "si",
            "nota": str(_cell(row, colmap, COL_NOTA, "") or "").strip(),
        }

    # The sheet's "Total noches-persona:" summary row is filtered out
    # generically by _parse_rows (see its "total"-prefix check) since its
    # label sits in this same Nombre column.
    known = _flatten(COL_NOMBRE, COL_GRUPO, COL_NOCHES, COL_PARTICIPA, COL_NOTA)
    return _parse_rows(values, COL_NOMBRE, row_factory, known)


def _trim_grid(values: list[list[Any]]) -> list[list[Any]]:
    """Estimado and Tesla are free-form sheets (section headings, label/
    value pairs, and the odd table, not one clean table) - rather than
    hand-model their exact layout here, this just drops fully-blank rows
    and any trailing blank columns, and lets the frontend classify each
    row by its shape (1 cell -> heading, 2 -> label/value line, 3+ ->
    table). Cell values pass through as-is (numbers stay numbers - the
    frontend formats them)."""
    out = []
    for row in values or []:
        trimmed = list(row)
        while trimmed and trimmed[-1] in (None, ""):
            trimmed.pop()
        if not trimmed:
            continue
        out.append(trimmed)
    return out


def parse_abonos(values: list[list[Any]]) -> list[dict]:
    def row_factory(row, colmap):
        return {
            "fecha": _cell(row, colmap, COL_FECHA),
            "nombre": str(_cell(row, colmap, COL_NOMBRE, "")).strip(),
            "grupo": str(_cell(row, colmap, COL_GRUPO, "")).strip(),
            "concepto": str(_cell(row, colmap, COL_CONCEPTO, "") or "").strip(),
            "valor": _to_number(_cell(row, colmap, COL_VALOR, 0)),
        }

    known = _flatten(COL_FECHA, COL_NOMBRE, COL_GRUPO, COL_CONCEPTO, COL_VALOR)
    return _parse_rows(values, COL_FECHA, row_factory, known)


def parse_gastos(values: list[list[Any]]) -> list[dict]:
    def row_factory(row, colmap):
        return {
            "fecha": _cell(row, colmap, COL_FECHA),
            "quienPago": str(_cell(row, colmap, COL_QUIEN_PAGO, "") or "").strip(),
            "categoria": str(_cell(row, colmap, COL_CATEGORIA, "") or "").strip(),
            "descripcion": str(_cell(row, colmap, COL_DESCRIPCION, "") or "").strip(),
            "valor": _to_number(_cell(row, colmap, COL_VALOR, 0)),
        }

    known = _flatten(COL_FECHA, COL_QUIEN_PAGO, COL_CATEGORIA, COL_DESCRIPCION, COL_VALOR)
    return _parse_rows(values, COL_FECHA, row_factory, known)


# --------------------------------------------------------------------------
# Business logic (mirrors the `Balance` tab formulas)
# --------------------------------------------------------------------------


def _derive_group_display_name(raw_group: str, members: list[dict]) -> str:
    """'Grupo Andrés' -> 'Andrés'; 'Casa Mery' -> 'Casa Mery' (no prefix to
    strip); a descriptive/parenthetical label like 'Extra (con Alyson -
    Grupo Alex)' -> falls back to its sole/first member's first name.
    This is a heuristic over the *shape* of the label (has a "Grupo "
    prefix vs. reads as a free-text description), not a name lookup.
    """
    label = (raw_group or "").strip()
    if label.lower().startswith("grupo "):
        return label[len("grupo ") :].strip()
    if "(" in label and members:
        return members[0]["nombre"].split()[0]
    return label


def _detect_pending(raw_group: str, members: list[dict]) -> bool:
    haystack = _normalize(raw_group)
    for m in members:
        haystack += " " + _normalize(m.get("nota", ""))
    return any(kw in haystack for kw in PENDING_KEYWORDS)


def _names_match(a: str, b: str) -> bool:
    return _normalize(a) == _normalize(b) and _normalize(a) != ""


def build_summary(
    cabana_values: list[list[Any]],
    personas_values: list[list[Any]],
    abonos_values: list[list[Any]],
    gastos_values: list[list[Any]],
    extra_sheets: dict[str, list[list[Any]]] | None = None,
    gastos_recent_limit: int = 10,
) -> dict:
    cabana = parse_cabana(cabana_values)
    personas = parse_personas(personas_values)
    abonos = parse_abonos(abonos_values)
    gastos = parse_gastos(gastos_values)

    total_noches_persona = sum(p["noches"] for p in personas)
    rate_per_person_night = (
        cabana["costoTotal"] / total_noches_persona if total_noches_persona else 0.0
    )

    total_gastos = sum(g["valor"] for g in gastos)
    total_abonado = sum(a["valor"] for a in abonos)
    gran_total = cabana["costoTotal"] + total_gastos
    pendiente_recaudar = gran_total - total_abonado

    # Variable-expense (Gastos) share: split evenly across whoever is
    # marked as participating, mirroring the workbook's Balance sheet
    # (`=IF(participa,totalGastos/COUNTIF(participa="Sí"),0)`).
    participantes = [p for p in personas if p["participaGastos"]]
    gasto_share = total_gastos / len(participantes) if participantes else 0.0

    def _abonado_por(nombre: str) -> float:
        return sum(a["valor"] for a in abonos if _names_match(a["nombre"], nombre))

    # Per-person detail - the full "Personas" tab, individually granular
    # (unlike `grupos` below, which rolls this up per family group).
    personas_out = []
    for p in personas:
        costo_cabana = p["noches"] * rate_per_person_night
        costo_gastos = gasto_share if p["participaGastos"] else 0.0
        total_a_cargo = costo_cabana + costo_gastos
        abonado = _abonado_por(p["nombre"])
        personas_out.append(
            {
                "nombre": p["nombre"],
                "grupo": _derive_group_display_name(p["grupo"], [p]),
                "noches": p["noches"],
                "participaGastos": p["participaGastos"],
                "nota": p["nota"],
                "costoCabana": _to_money_int(costo_cabana),
                "costoGastos": _to_money_int(costo_gastos),
                "totalACargo": _to_money_int(total_a_cargo),
                "totalAbonado": _to_money_int(abonado),
                "saldo": _to_money_int(abonado - total_a_cargo),
                "extra": p.get("extra", {}),
            }
        )

    # Group people by their raw `Grupo familiar` label, preserving the
    # order groups first appear in the Personas sheet.
    groups: dict[str, list[dict]] = {}
    for p in personas:
        groups.setdefault(p["grupo"], []).append(p)

    grupos_out = []
    for raw_group, members in groups.items():
        noches_grupo = sum(m["noches"] for m in members)
        owed = sum(
            m["noches"] * rate_per_person_night
            + (gasto_share if m["participaGastos"] else 0.0)
            for m in members
        )
        member_names = {m["nombre"] for m in members}
        paid = sum(
            a["valor"]
            for a in abonos
            if any(_names_match(a["nombre"], n) for n in member_names)
        )
        grupos_out.append(
            {
                "nombre": _derive_group_display_name(raw_group, members),
                "sub": f"{_join_names_es([m['nombre'] for m in members])} · {int(noches_grupo)} noches",
                "owed": _to_money_int(owed),
                "paid": _to_money_int(paid),
                "pending": _detect_pending(raw_group, members),
            }
        )

    abonos_sorted = sorted(
        (a for a in abonos if a["fecha"] is not None),
        key=lambda a: _serial_to_date(a["fecha"]) or date.min,
        reverse=True,
    )
    abonos_out = [
        {
            "fecha": _date_iso(a["fecha"]),
            "nombre": a["nombre"],
            "grupo": _derive_group_display_name(a["grupo"], []) or a["grupo"],
            "concepto": a["concepto"],
            "valor": _to_money_int(a["valor"]),
            "extra": a.get("extra", {}),
        }
        for a in abonos_sorted
    ]

    gastos_sorted = sorted(
        (g for g in gastos if g["fecha"] is not None),
        key=lambda g: _serial_to_date(g["fecha"]) or date.min,
        reverse=True,
    )
    gastos_out = [
        {
            "fecha": _date_iso(g["fecha"]),
            "quienPago": g["quienPago"],
            "categoria": g["categoria"],
            "descripcion": g["descripcion"],
            "valor": _to_money_int(g["valor"]),
            "extra": g.get("extra", {}),
        }
        for g in gastos_sorted
    ]

    return {
        "cabaña": cabana,
        "totales": {
            "gastos": _to_money_int(total_gastos),
            "abonado": _to_money_int(total_abonado),
            "granTotal": _to_money_int(gran_total),
            "pendienteRecaudar": _to_money_int(pendiente_recaudar),
        },
        "grupos": grupos_out,
        "personas": personas_out,
        "abonos": abonos_out,
        "gastos": gastos_out,
        "ultimosGastos": gastos_out[:gastos_recent_limit],
        # Keyed by the tab's actual title in the live Sheet, in tab order -
        # the frontend builds one pestaña per key, so a new tab shows up
        # here with no Lambda change and no frontend change either.
        "extra": {
            title: {"grid": _trim_grid(values)}
            for title, values in (extra_sheets or {}).items()
        },
        "actualizado": datetime.now(timezone.utc).isoformat(),
    }


# --------------------------------------------------------------------------
# Google auth + Sheets API access
# --------------------------------------------------------------------------


def _get_service_account_info(ssm_parameter_name: str) -> dict:
    """Fetch and cache the service-account JSON key from SSM Parameter
    Store (SecureString). Never logged, never written to disk/state.
    """
    global _cached_service_account_info
    if _cached_service_account_info is not None:
        return _cached_service_account_info

    import boto3  # lazy import: provided by the Lambda runtime, not a dep

    ssm = boto3.client("ssm")
    resp = ssm.get_parameter(Name=ssm_parameter_name, WithDecryption=True)
    _cached_service_account_info = json.loads(resp["Parameter"]["Value"])
    return _cached_service_account_info


def _get_access_token(sa_info: dict) -> str:
    global _cached_credentials
    if _cached_credentials is None:
        _cached_credentials = service_account.Credentials.from_service_account_info(
            sa_info, scopes=SHEETS_SCOPES
        )
    if not _cached_credentials.valid:
        _cached_credentials.refresh(GoogleAuthRequest())
    return _cached_credentials.token


# Tabs the workbook is guaranteed to have - if any of these is missing,
# something is genuinely wrong and the request should fail loudly.
_REQUIRED_RANGES = [RANGE_CABANA, RANGE_PERSONAS, RANGE_ABONOS, RANGE_GASTOS]

# Tabs that are either specially modeled above (Cabaña/Personas/Abonos/
# Gastos) or redundant to show as a raw grid (Resumen and Balance are
# formula-heavy views of the same data the dashboard's own Resumen/
# Personas tabs already compute) - excluded from the dynamic "extra tabs"
# discovery below. Normalized (accent/case-insensitive) so "Cabaña" and
# "CABAÑA" both match.
_CORE_SHEET_TITLES = {"cabana", "personas", "abonos", "gastos", "resumen", "balance"}

# How wide/tall a freeform "extra" tab is read - generous on purpose since
# these are open-ended reference sheets (Tesla, Carros, Estimado, and
# whatever gets added next), not a tight data table.
_EXTRA_TAB_RANGE_SUFFIX = "!A1:H200"


def _sheets_get(url: str, access_token: str, params: dict) -> requests.Response:
    return requests.get(
        url, headers={"Authorization": f"Bearer {access_token}"}, params=params, timeout=10
    )


def _quote_sheet_title(title: str) -> str:
    """Sheets range syntax needs single-quoting for tab names containing
    spaces/special characters (e.g. `'Viajes y Rutas'!A1:H200`); plain
    single-word names work either way, so quoting unconditionally is safe."""
    return "'" + title.replace("'", "''") + "'"


def _list_extra_sheet_titles(spreadsheet_id: str, access_token: str) -> list[str]:
    """Every tab in the live spreadsheet that isn't one of the core,
    specially-modeled ones - discovered fresh on every request, so a
    brand-new tab (or one renamed/removed) shows up on the next page load
    with no code change here. Returns titles in the sheet's own left-to-
    right tab order (the API preserves that order)."""
    resp = _sheets_get(
        f"{SHEETS_API_BASE}/{spreadsheet_id}",
        access_token,
        {"fields": "sheets.properties.title"},
    )
    resp.raise_for_status()
    all_titles = [
        s["properties"]["title"] for s in resp.json().get("sheets", []) if "properties" in s
    ]
    return [t for t in all_titles if _normalize(t) not in _CORE_SHEET_TITLES]


def fetch_sheet_values(spreadsheet_id: str, access_token: str) -> dict[str, Any]:
    """Batch-fetches the required tabs (must all exist), then discovers and
    fetches every other tab individually, so new/renamed/removed "extra"
    tabs (Tesla, Carros, Estimado, or whatever gets added later) just work
    without a code change. A tab that fails to fetch (e.g. a transient API
    hiccup) degrades to an empty grid for just that tab, not a broken
    dashboard.
    """
    render_params = {
        "valueRenderOption": "UNFORMATTED_VALUE",
        "dateTimeRenderOption": "SERIAL_NUMBER",
    }

    resp = _sheets_get(
        f"{SHEETS_API_BASE}/{spreadsheet_id}/values:batchGet",
        access_token,
        {"ranges": _REQUIRED_RANGES, **render_params},
    )
    resp.raise_for_status()
    payload = resp.json()

    out: dict[str, list[list[Any]]] = {}
    for value_range in payload.get("valueRanges", []):
        out[value_range.get("range", "")] = value_range.get("values", [])

    # Match back by prefix since Google echoes ranges with sheet quoting
    # normalized (e.g. `'Cabaña'!A1:C20`), not byte-identical to what we sent.
    def _lookup(range_name: str) -> list[list[Any]]:
        tab = range_name.split("!")[0]
        for k, v in out.items():
            if k.split("!")[0].strip("'") == tab.strip("'"):
                return v
        return []

    result: dict[str, Any] = {
        "cabana": _lookup(RANGE_CABANA),
        "personas": _lookup(RANGE_PERSONAS),
        "abonos": _lookup(RANGE_ABONOS),
        "gastos": _lookup(RANGE_GASTOS),
    }

    extra: dict[str, list[list[Any]]] = {}
    try:
        extra_titles = _list_extra_sheet_titles(spreadsheet_id, access_token)
    except requests.exceptions.RequestException:
        logger.info("Could not list sheet tabs; showing no extra tabs this request")
        extra_titles = []

    for title in extra_titles:
        try:
            r = _sheets_get(
                f"{SHEETS_API_BASE}/{spreadsheet_id}/values/"
                f"{_quote_sheet_title(title)}{_EXTRA_TAB_RANGE_SUFFIX}",
                access_token,
                render_params,
            )
            r.raise_for_status()
            extra[title] = r.json().get("values", [])
        except requests.exceptions.RequestException:
            logger.info("Extra tab %r failed to fetch, showing empty", title)
            extra[title] = []

    result["extra"] = extra
    return result


# --------------------------------------------------------------------------
# Lambda entry point
# --------------------------------------------------------------------------

_CORS_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
}


def lambda_handler(event: dict, context: Any) -> dict:
    try:
        spreadsheet_id = os.environ["SPREADSHEET_ID"]
        ssm_param_name = os.environ["GOOGLE_SA_SSM_PARAM"]
        recent_limit = int(os.environ.get("GASTOS_RECENT_LIMIT", "10"))

        sa_info = _get_service_account_info(ssm_param_name)
        token = _get_access_token(sa_info)
        sheets = fetch_sheet_values(spreadsheet_id, token)

        summary = build_summary(
            sheets["cabana"],
            sheets["personas"],
            sheets["abonos"],
            sheets["gastos"],
            extra_sheets=sheets["extra"],
            gastos_recent_limit=recent_limit,
        )

        return {
            "statusCode": 200,
            "headers": _CORS_HEADERS,
            "body": json.dumps(summary, ensure_ascii=False),
        }
    except Exception:  # noqa: BLE001 - top-level handler, must not crash
        logger.exception("Failed to build /api/summary response")
        return {
            "statusCode": 500,
            "headers": _CORS_HEADERS,
            "body": json.dumps({"error": "internal_error"}),
        }


# --------------------------------------------------------------------------
# Local smoke test
# --------------------------------------------------------------------------
#
# NOT runnable as-is: it needs a real Google Sheet ID and a real service
# account key with Viewer access to that sheet. Nothing here is fabricated
# or hardcoded - set the two environment variables below and this will
# exercise the exact same code path as the deployed Lambda, but reading
# the service account key from a local JSON file instead of SSM.
#
#   SPREADSHEET_ID=<the sheet id from its URL> \
#   GOOGLE_SA_LOCAL_KEY_FILE=/path/to/service-account-key.json \
#   python3 handler.py
#
if __name__ == "__main__":
    spreadsheet_id = os.environ.get("SPREADSHEET_ID")
    local_key_file = os.environ.get("GOOGLE_SA_LOCAL_KEY_FILE")

    if not spreadsheet_id or not local_key_file:
        raise SystemExit(
            "Local smoke test needs real credentials:\n"
            "  SPREADSHEET_ID=<sheet id> GOOGLE_SA_LOCAL_KEY_FILE=<path to key.json> "
            "python3 handler.py\n"
            "See docs/google-service-account-setup.md to create the key file, "
            "and remember to share the sheet with the service account's "
            "...@...iam.gserviceaccount.com email as Viewer first."
        )

    with open(local_key_file, encoding="utf-8") as f:
        _cached_service_account_info = json.load(f)

    _token = _get_access_token(_cached_service_account_info)
    _sheets = fetch_sheet_values(spreadsheet_id, _token)
    _summary = build_summary(
        _sheets["cabana"],
        _sheets["personas"],
        _sheets["abonos"],
        _sheets["gastos"],
        extra_sheets=_sheets["extra"],
    )
    print(json.dumps(_summary, indent=2, ensure_ascii=False))
