# Infra — Coveñas trip dashboard

Terraform for the AWS side of the live dashboard: S3 + CloudFront (static
frontend), API Gateway HTTP API + Lambda (`GET /api/summary`, reads the
Google Sheet). See the root `CLAUDE.md` for the overall architecture.

State lives in S3 (`taxops11-tfstate-786567028012`, key `trip-covenas/terraform.tfstate`)
— reuses the same personal-account bootstrap bucket as TaxOps-11, see the
comment at the top of `versions.tf`. This is what lets CI run `terraform
plan`/`apply` consistently instead of only ever working from one laptop.

## Prerequisites

- Terraform >= 1.5
- AWS CLI configured with credentials that can create S3/CloudFront/Lambda/
  API Gateway/IAM resources (`aws configure`, or an SSO profile)
- Python 3 + `pip3` on your PATH (used by the Lambda packaging step)
- A Google service-account JSON key already created — see
  `../docs/google-service-account-setup.md` if you haven't done this yet
- The target Google Sheet's ID (from its URL)

## 1. Put the Google service-account key in SSM — before `terraform apply`

Terraform never creates or touches this secret; the IAM policy references
it by ARN via a data source, and that data source (and the Lambda that
reads it at runtime) requires the parameter to already exist. Do this
first:

```bash
aws ssm put-parameter \
  --name "/covenas-dashboard/google-service-account" \
  --type SecureString \
  --value file:///absolute/path/to/service-account-key.json
```

(Use `--overwrite` if you're rotating an existing key.) If you use a
different parameter name, pass it via
`-var google_service_account_ssm_param_name=...` in the steps below.

## 2. Init / plan / apply

```bash
cd infra
terraform init
terraform plan \
  -var "google_spreadsheet_id=<your sheet id>"
terraform apply \
  -var "google_spreadsheet_id=<your sheet id>"
```

`terraform apply` will:

1. Run `pip3 install` for the Lambda's two dependencies (`google-auth`,
   `requests`) into `infra/build/package/`, copy `lambda/handler.py` in
   next to them, and zip the result — this is the deployment package,
   built fresh whenever `handler.py` or `requirements.txt` change.
2. Create the S3 bucket (private, OAC-only access) and CloudFront
   distribution.
3. Create the Lambda, its IAM role, the API Gateway HTTP API and its
   `GET /api/summary` route.
4. Upload anything currently in `frontend/` (or whatever
   `frontend_build_dir` points at) to the S3 bucket.

At the end, note the outputs:

```bash
terraform output cloudfront_url
terraform output api_summary_endpoint
```

## 3. Sync the frontend after it changes

Terraform's `aws_s3_object` resources track the exact set of files under
`frontend_build_dir` (default `../frontend`) via content hash, so the
simplest way to publish frontend updates is just:

```bash
terraform apply -var "google_spreadsheet_id=<your sheet id>"
```

Re-run it whenever frontend files change — Terraform diffs by MD5 and only
uploads what changed. (If you'd rather not touch Terraform state for pure
static-file pushes, `aws s3 sync ../frontend s3://$(terraform output -raw
s3_bucket_name) --delete` works too, but then Terraform's own state will
disagree about what's in the bucket until the next `apply`.)

CloudFront caches aggressively by default; after a frontend deploy you may
want to invalidate:

```bash
aws cloudfront create-invalidation \
  --distribution-id <id-from-aws-console-or-`aws cloudfront list-distributions`> \
  --paths "/*"
```

## Why no Lambda layer

`lambda/requirements.txt` is just `google-auth` + `requests`. Both, and all
of their transitive dependencies (`cachetools`, `pyasn1`, `pyasn1-modules`,
`rsa`, `six`, `charset-normalizer`, `idna`, `urllib3`, `certifi`), are
pure-Python — no compiled C extensions — so the zip built by
`null_resource.lambda_build` + `data.archive_file.lambda_zip` is small
(a few MB) and works on Lambda's runtime regardless of what OS/arch you
built it on. A layer would only earn its keep if a dependency needed
compiled wheels (e.g. `numpy`, `cryptography` with a C backend) — not the
case here, so it's deliberately left out.

## Cost

Designed to stay inside the AWS always-free tier for family-sized traffic
(dozens of requests/day): Lambda's 1M free requests/month, API Gateway
HTTP API's 1M free requests/month (first 12 months, then $1/million after),
CloudFront's 1TB free egress (first 12 months), S3 storage for a handful of
static files. No Route53 hosted zone (no custom domain), no NAT gateway, no
RDS/ElastiCache. Realistically ~$0/month.

## Teardown

```bash
terraform destroy -var "google_spreadsheet_id=<your sheet id>"
```

This does **not** delete the SSM parameter (it was never Terraform's to
manage) — remove it yourself if you want it gone:

```bash
aws ssm delete-parameter --name "/covenas-dashboard/google-service-account"
```
