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

# Header names as they appear in the workbook, normalized (lowercase,
# accents stripped). Used to locate columns by name instead of by letter.
COL_NOMBRE = "nombre"
COL_GRUPO = "grupo familiar"
COL_NOCHES = "noches en cabana"
COL_NOTA = "nota"
COL_FECHA = "fecha"
COL_CONCEPTO = "concepto"
COL_VALOR = "valor"
COL_QUIEN_PAGO = "quien pago"
COL_CATEGORIA = "categoria"
COL_DESCRIPCION = "descripcion"

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


def _find_header_row(values: list[list[Any]], required_col: str) -> tuple[int, dict[str, int]]:
    """Find the first row containing `required_col` (normalized) and build
    a {normalized_header: column_index} map from that row.

    Returns (-1, {}) if no such header row is found (e.g. empty/blank tab).
    """
    for i, row in enumerate(values or []):
        norm_cells = [_normalize(c) for c in row]
        if required_col in norm_cells:
            colmap = {c: idx for idx, c in enumerate(norm_cells) if c}
            return i, colmap
    return -1, {}


def _cell(row: list[Any], colmap: dict[str, int], name: str, default: Any = None) -> Any:
    idx = colmap.get(name)
    if idx is None or idx >= len(row):
        return default
    val = row[idx]
    return val if val not in (None, "") else default


def _parse_rows(
    values: list[list[Any]], required_col: str, row_factory
) -> list[dict]:
    header_idx, colmap = _find_header_row(values, required_col)
    if header_idx == -1:
        return []
    results = []
    for row in values[header_idx + 1 :]:
        if _cell(row, colmap, required_col) is None:
            continue  # skip blank/unused pre-allocated rows
        results.append(row_factory(row, colmap))
    return results


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
        "condominio": _extract_condominio(str(label_map.get("estado") or "")),
    }


def parse_personas(values: list[list[Any]]) -> list[dict]:
    def row_factory(row, colmap):
        return {
            "nombre": str(_cell(row, colmap, COL_NOMBRE, "")).strip(),
            "grupo": str(_cell(row, colmap, COL_GRUPO, "")).strip(),
            "noches": _to_number(_cell(row, colmap, COL_NOCHES, 0)),
            "nota": str(_cell(row, colmap, COL_NOTA, "") or "").strip(),
        }

    return _parse_rows(values, COL_NOMBRE, row_factory)


def parse_abonos(values: list[list[Any]]) -> list[dict]:
    def row_factory(row, colmap):
        return {
            "fecha": _cell(row, colmap, COL_FECHA),
            "nombre": str(_cell(row, colmap, COL_NOMBRE, "")).strip(),
            "grupo": str(_cell(row, colmap, COL_GRUPO, "")).strip(),
            "concepto": str(_cell(row, colmap, COL_CONCEPTO, "") or "").strip(),
            "valor": _to_number(_cell(row, colmap, COL_VALOR, 0)),
        }

    return _parse_rows(values, COL_FECHA, row_factory)


def parse_gastos(values: list[list[Any]]) -> list[dict]:
    def row_factory(row, colmap):
        return {
            "fecha": _cell(row, colmap, COL_FECHA),
            "quienPago": str(_cell(row, colmap, COL_QUIEN_PAGO, "") or "").strip(),
            "categoria": str(_cell(row, colmap, COL_CATEGORIA, "") or "").strip(),
            "descripcion": str(_cell(row, colmap, COL_DESCRIPCION, "") or "").strip(),
            "valor": _to_number(_cell(row, colmap, COL_VALOR, 0)),
        }

    return _parse_rows(values, COL_FECHA, row_factory)


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

    # Group people by their raw `Grupo familiar` label, preserving the
    # order groups first appear in the Personas sheet.
    groups: dict[str, list[dict]] = {}
    for p in personas:
        groups.setdefault(p["grupo"], []).append(p)

    grupos_out = []
    for raw_group, members in groups.items():
        noches_grupo = sum(m["noches"] for m in members)
        owed = sum(m["noches"] * rate_per_person_night for m in members)
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

    gastos_sorted = sorted(
        (g for g in gastos if g["fecha"] is not None),
        key=lambda g: _serial_to_date(g["fecha"]) or date.min,
        reverse=True,
    )
    ultimos_gastos = [
        {
            "fecha": _date_iso(g["fecha"]),
            "quienPago": g["quienPago"],
            "categoria": g["categoria"],
            "descripcion": g["descripcion"],
            "valor": _to_money_int(g["valor"]),
        }
        for g in gastos_sorted[:gastos_recent_limit]
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
        "ultimosGastos": ultimos_gastos,
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


def fetch_sheet_values(spreadsheet_id: str, access_token: str) -> dict[str, list[list[Any]]]:
    """Single batchGet call for all the ranges we need. Returns
    {range_name: 2D values list}.
    """
    ranges = [RANGE_CABANA, RANGE_PERSONAS, RANGE_ABONOS, RANGE_GASTOS]
    resp = requests.get(
        f"{SHEETS_API_BASE}/{spreadsheet_id}/values:batchGet",
        headers={"Authorization": f"Bearer {access_token}"},
        params={
            "ranges": ranges,
            "valueRenderOption": "UNFORMATTED_VALUE",
            "dateTimeRenderOption": "SERIAL_NUMBER",
        },
        timeout=10,
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

    return {
        "cabana": _lookup(RANGE_CABANA),
        "personas": _lookup(RANGE_PERSONAS),
        "abonos": _lookup(RANGE_ABONOS),
        "gastos": _lookup(RANGE_GASTOS),
    }


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
        _sheets["cabana"], _sheets["personas"], _sheets["abonos"], _sheets["gastos"]
    )
    print(json.dumps(_summary, indent=2, ensure_ascii=False))
