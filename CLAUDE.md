# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Personal project (git repo, `Portfolio-jaime/trip-covenas` on GitHub) to track shared expenses for
a family trip to Coveñas, Colombia, and to give the family a way to see the numbers without opening
a spreadsheet. See "Current state" and "AWS live dashboard — deployed" below for what actually
exists before assuming commands or architecture.

## Commit / PR signature

Never add Claude/Anthropic attribution here — no `Co-Authored-By: Claude...` line, no
"🤖 Generated with Claude Code" footer. End every commit message and PR body with:

```
Signed-off-by: Jaime Henao <arheanja@gmail.com>
```

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

- **The live Google Sheet is the only source of truth for data** — sheet ID
  `1KmnxmzLnohSPLx6PYSJ3WWulrdm1R53pA7Qx85xEnJk`, shared with the family for editing and with
  `covenas-dashboard-reader@covenas-dashboard.iam.gserviceaccount.com` (Viewer) for the Lambda.
  **All data changes (new abonos, gastos, tweaked supuestos, etc.) happen directly in that Sheet
  from now on** — not in the local file below, and not by asking Claude to regenerate anything.
- `Gastos_Covenas.xlsx` (repo root) is a **historical snapshot only** — it's what the live Sheet
  was converted from, kept here as a readable reference/backup of the original formulas and
  layout. It has already drifted from the live Sheet (e.g. real abonos added there aren't reflected
  here) and editing it does **not** propagate anywhere. If a new tab needs to exist in the live
  Sheet (like `Carros` was, and `Tesla`'s rewrite is), the practical path is: build/update it in
  this local file first (so the layout is documented and versioned), then the user copies that one
  tab into the live Sheet themselves (right-click the tab → Copy to → Existing spreadsheet) —
  Claude has no write access to the live Sheet (the service account is deliberately read-only).
- A read-only visual dashboard was also published as a Claude Artifact early on (not part of this
  repo, superseded by the AWS dashboard below) — a manual snapshot, regenerated on request, not
  live-connected to the sheet.

## AWS live dashboard — deployed

**Live**: https://d3v68ejd8s9g4n.cloudfront.net/ (frontend) · reads
`https://rbzg7ddzyh.execute-api.us-east-1.amazonaws.com/api/summary` (Lambda-backed API).

- **Data flow**: Google Sheets is the source of truth (family edits there — the native Sheets file,
  not the `.xlsx`; Sheets API rejects files still in Office-compat mode). `lambda/handler.py` reads
  it read-only via a Google **Service Account** (`covenas-dashboard-reader@covenas-dashboard.iam.gserviceaccount.com`,
  key in SSM at `/covenas-dashboard/google-service-account`), replicates the workbook's per-night
  proration + group-balance logic server-side, and returns JSON. `frontend/index.html` fetches that
  JSON (endpoint configured in `frontend/config.js`) and renders it — same visual design as the
  original Claude Artifact dashboard.
- **IaC**: Terraform in `infra/`, state in S3 (`taxops11-tfstate-786567028012`, key
  `trip-covenas/terraform.tfstate` — reuses TaxOps-11's bootstrap bucket with its own key prefix,
  no shared lock).
- **AWS account**: personal (786567028012), profile `trip-covenas` (SSO, same `sso-session` as
  TaxOps-11's `taxops-admin`). **GitHub**: personal account `jaimehenao8126`, not the work account
  — see `.envrc` (direnv auto-loads `AWS_PROFILE` + `GH_CONFIG_DIR` on `cd`).
- **CI/CD**: `.github/workflows/terraform-plan.yml` (PRs touching `infra/`, `lambda/`, or
  `frontend/`) and `terraform-apply.yml` (push to `main` or manual dispatch, gated behind the
  `production` environment's required reviewer). Auth via GitHub OIDC — no AWS keys stored in
  GitHub; IAM role `covenas-dashboard-github-actions-terraform` reuses the OIDC *provider* TaxOps-11
  already created in this account, scoped to its own trust policy for `Portfolio-jaime/trip-covenas`
  only.
- **Known gotchas already hit once** (don't redo this debugging): (1) `google-auth`'s `cryptography`
  dependency is a compiled extension — the Lambda build step (`infra/lambda.tf`) must `pip install
  --platform manylinux2014_x86_64 --only-binary=:all:` or the zip contains a macOS binary that fails
  on Lambda with "invalid ELF header". (2) Every sheet tab has a trailing "Total X:" summary row in
  the same lookup column as real data rows — `_parse_rows` in `handler.py` filters anything starting
  with "total" to avoid double-counting it as phantom data.
- **Tagging**: every AWS resource must be tagged — already handled globally via `default_tags` in
  `infra/providers.tf` (`Project`, `Environment`, `ManagedBy=terraform`, `Repository`, `Owner`), so
  a plain resource block picks it up automatically. If a new resource type doesn't support
  `default_tags` propagation (rare, but e.g. some `aws_s3_object`-adjacent or non-taggable
  resources), add an explicit `tags = { ... }` block matching that same set by hand — don't create
  an AWS resource without a tag path back to this project.
