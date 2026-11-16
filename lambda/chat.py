"""
Covenas trip dashboard - Tesla route chat.

POST /api/chat: a small assistant for the Tesla tab. It calls Groq's
OpenAI-compatible chat completions API with the model's built-in
`browser_search` tool (server-side web search powered by Exa), so it can
check the current state of chargers instead of relying on stale data.

Design notes
------------
- The Groq API key is read at runtime from SSM Parameter Store
  (SecureString), cached for the warm execution environment. It is never
  in code, env vars, Terraform state or logs.
- The base rules (language, zero invention, how to propose a plan) live
  here. The route data (chargers, reports, current simulation) comes from
  the frontend as `context`, so tesla-data.js stays the single source of
  truth. Because that makes `context` client-controlled, it is only ever
  used as a *user-role* message and is size-capped.
- Message contents are never logged (only status codes and sizes).
- Groq's free tier is small (30 RPM, ~8K tokens per minute for gpt-oss), so
  the request is deliberately lean: low reasoning effort, short history,
  capped output, and a clear 429 -> "try again in a minute" path.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import requests

logger = logging.getLogger()
logger.setLevel(logging.INFO)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"

MAX_MESSAGES = 6
MAX_MESSAGE_CHARS = 800
MAX_CONTEXT_CHARS = 6000
MAX_OUTPUT_TOKENS = 900
GROQ_TIMEOUT_SECONDS = 24  # API Gateway HTTP APIs cut off at 30 s

SYSTEM_PROMPT = """\
Eres el asistente de ruta del viaje familiar Medellín ⇄ Coveñas en un Tesla Model Y RWD.
Responde siempre en español, claro y breve (máximo ~180 palabras), tuteando.

Reglas:
1. No inventes cargadores, potencias ni distancias. Si algo no está en el CONTEXTO ni en una fuente web \
que hayas consultado, dilo y marca el dato como "sin verificar".
2. Para el estado actual de un cargador (funciona, fuera de servicio, filas) o datos recientes, usa la \
búsqueda web. Cita la fuente con su URL. Si no encuentras nada confiable, dilo.
3. Los reportes de conductores del CONTEXTO tienen prioridad sobre suposiciones. Los puntos marcados \
como hipótesis no son cargadores confirmados.
4. Las decisiones son del conductor: presenta opciones y riesgos, no órdenes. Si la batería llega por \
debajo de la reserva, dilo de forma explícita.
5. Formato: Markdown simple y ordenado. Empieza con la respuesta directa en 1 o 2 frases. Si hace falta detalle, usa una lista corta con viñetas ("- "), una idea por viñeta. Negritas solo para cifras y nombres clave. Sin tablas ni encabezados con #. Cierra con una línea "Fuente: URL" solo si usaste la web.
6. Si el usuario pide armar o cambiar un plan, añade AL FINAL un bloque exactamente así (y solo uno):
```plan
{"dir":"ida|regreso","route":"monteria|sincelejo","startSoc":97,"style":"eco|normal|rapido",\
"stops":{"popalito":{"target":100},"fatima":{"target":90}}}
```
Nodos válidos: popalito, corredor, fatima, planetarica, monteria (con "charger":"castellana"|"places"), \
sincelejo. Usa solo los campos que cambian. El navegador lo simula; tú no calcules la batería a mano.
"""


_cached_key: str | None = None


def _response(status: int, body: dict, origin: str | None = None) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": origin or "*",
            "Vary": "Origin",
        },
        "body": json.dumps(body, ensure_ascii=False),
    }


def _get_api_key(ssm_param_name: str) -> str:
    global _cached_key
    if _cached_key:
        return _cached_key
    import boto3  # lazy import: provided by the Lambda runtime

    resp = boto3.client("ssm").get_parameter(Name=ssm_param_name, WithDecryption=True)
    _cached_key = resp["Parameter"]["Value"].strip()
    return _cached_key


def _allowed_origin(event: dict) -> tuple[bool, str | None]:
    """Browsers always send Origin on cross-origin POSTs. This is a cheap
    filter against casual misuse, not authentication."""
    allowed = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
    origin = (event.get("headers") or {}).get("origin")
    if not allowed:
        return True, origin
    return (origin in allowed), origin


def parse_request(raw_body: str | None) -> tuple[list[dict], str]:
    """Validate and trim the incoming payload. Raises ValueError on bad input."""
    try:
        payload = json.loads(raw_body or "")
    except json.JSONDecodeError as exc:
        raise ValueError("invalid_json") from exc
    if not isinstance(payload, dict):
        raise ValueError("invalid_payload")

    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ValueError("messages_required")

    clean: list[dict] = []
    for m in messages[-MAX_MESSAGES:]:
        if not isinstance(m, dict) or m.get("role") not in ("user", "assistant"):
            raise ValueError("invalid_message")
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("invalid_message")
        clean.append({"role": m["role"], "content": content.strip()[:MAX_MESSAGE_CHARS]})
    if clean[-1]["role"] != "user":
        raise ValueError("last_message_must_be_user")

    context = payload.get("context", "")
    if not isinstance(context, str):
        raise ValueError("invalid_context")
    if len(context) > MAX_CONTEXT_CHARS:
        raise ValueError("context_too_large")
    return clean, context


def build_groq_payload(messages: list[dict], context: str) -> dict:
    convo: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    if context.strip():
        # user role on purpose: client-controlled text must not carry system authority
        convo.append({"role": "user", "content": "CONTEXTO (datos del simulador y de la ruta):\n" + context})
        convo.append({"role": "assistant", "content": "Entendido, uso ese contexto."})
    convo.extend(messages)
    return {
        "model": os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"),
        "messages": convo,
        "temperature": 0.4,
        "max_completion_tokens": MAX_OUTPUT_TOKENS,
        "reasoning_effort": "low",
        "tools": [{"type": "browser_search"}],
        "tool_choice": "auto",
    }


def lambda_handler(event: dict, context: Any) -> dict:
    ok_origin, origin = _allowed_origin(event)  # CORS preflight is answered by API Gateway itself
    if not ok_origin:
        return _response(403, {"error": "origin_not_allowed"})

    try:
        messages, ctx = parse_request(event.get("body"))
    except ValueError as exc:
        return _response(400, {"error": str(exc)}, origin)

    try:
        api_key = _get_api_key(os.environ["GROQ_SSM_PARAM"])
    except Exception:  # noqa: BLE001 - missing parameter/permissions: fail closed
        logger.exception("Groq API key is not available")
        return _response(503, {"error": "chat_not_configured"}, origin)

    try:
        resp = requests.post(
            GROQ_URL,
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=build_groq_payload(messages, ctx),
            timeout=GROQ_TIMEOUT_SECONDS,
        )
    except requests.exceptions.RequestException:
        logger.warning("Groq request failed (network/timeout)")
        return _response(504, {"error": "upstream_timeout"}, origin)

    if resp.status_code == 429:
        logger.warning("Groq rate limit hit")
        return _response(429, {"error": "rate_limited"}, origin)
    if resp.status_code != 200:
        logger.warning("Groq returned status %s", resp.status_code)
        return _response(502, {"error": "upstream_error"}, origin)

    try:
        reply = resp.json()["choices"][0]["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError):
        logger.warning("Unexpected Groq response shape")
        return _response(502, {"error": "upstream_error"}, origin)

    return _response(200, {"reply": reply.strip()}, origin)
