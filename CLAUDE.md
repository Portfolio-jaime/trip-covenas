# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Personal project (not yet a git repo) to track shared expenses for a family trip to Coveñas,
Colombia, and to give the family a way to see the numbers without opening a spreadsheet. There is
no application code yet — see "Current state" and "Planned: AWS live dashboard" below before
assuming any commands or architecture exist.

## Trip facts (source of truth — don't re-derive from chat exports)

- **Where/when**: Condominio Victoria Real, cabaña #2, Coveñas (Sucre). 29 dic 2026 → 4 ene 2027,
  6 noches.
- **Cost**: cabaña $6.860.000 COP total, 12 personas base. Payment deadline is **unconfirmed** —
  never state a hard date for it.
- **Groups (12 confirmados)**: Andrés (+ Diana, Thomas), Ana (+ Isabella), Alex (+ Alyson), Sandra
  (+ Juanjo), Casa Mery (Daniel Felipe Ortega + Marlen Moncada), Paty (Patricia Arbelaez, sola).
- **Extra, unconfirmed**: Julián (con Alyson / Grupo Alex), llegaría después del 31 dic — se cobra
  proporcional a sus noches, no cuenta en los 12 base.
- **Cost-splitting model**: per person-night, not a flat per-person split — `rate = costo_cabaña /
  Σ(noches de cada persona)`, so partial-stay guests (like Julián) pay less automatically. This
  logic lives in the `Balance` sheet of `Gastos_Covenas.xlsx` and must be preserved in any app
  that replaces or reads that sheet.
- Andrés drives a Tesla Model Y RWD; the other cars are gasoline. Route assumptions and charging
  stops are documented in the `Tesla` sheet of the workbook.

## Current state

- `Gastos_Covenas.xlsx` — the real, hand-maintained budget workbook (6 sheets: Resumen, Cabaña,
  Personas, Abonos, Gastos, Balance, plus Estimado and Tesla for predictive/road-trip planning).
  This is the source of truth for numbers; it gets uploaded to the family's Google Drive as a
  Google Sheet so everyone can edit from their phone.
- A read-only visual dashboard has been published as a Claude Artifact (not part of this repo) —
  it's a manual snapshot, regenerated on request, not live-connected to the sheet.

## Planned: AWS live dashboard

Design decided but not yet implemented:

- **Data flow**: Google Sheets stays the source of truth (family edits there). A Lambda reads it
  read-only via a Google **Service Account** (not a public "anyone with the link" share) and
  serves JSON through an API Gateway HTTP API. A static frontend (S3 + CloudFront) fetches that
  JSON and renders the same dashboard design used in the Artifact version.
- **IaC**: Terraform.
- **Cost target**: effectively $0/month — stay inside Lambda/API Gateway/CloudFront's always-free
  tiers; no Route53 custom domain (use the default `*.cloudfront.net` URL) to avoid the $0.50/mo
  hosted-zone charge.
- **Auth**: none — read-only, unguessable CloudFront URL, same threat model already accepted for
  the Artifact link shared over WhatsApp.
- Once this exists, replace this section with real build/deploy/test commands and the actual
  architecture (Terraform module layout, Lambda entry point, frontend build step).
