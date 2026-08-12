variable "aws_region" {
  description = "AWS region to deploy into. CloudFront itself is global, but the S3 bucket, Lambda, and API Gateway are regional."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used as a prefix for all resource names (bucket, Lambda function, IAM role, API)."
  type        = string
  default     = "covenas-dashboard"
}

variable "google_spreadsheet_id" {
  description = <<-EOT
    The Google Sheet ID (the long id in its URL:
    https://docs.google.com/spreadsheets/d/<THIS_PART>/edit) for the live
    Gastos_Covenas sheet. Required - has no default since it's specific to
    your Google Drive.
  EOT
  type        = string
}

variable "google_service_account_ssm_param_name" {
  description = <<-EOT
    Name of the AWS SSM Parameter Store SecureString parameter that holds
    the Google service-account JSON key. The parameter is created
    out-of-band via `aws ssm put-parameter` (see infra/README.md) - it is
    intentionally NOT created or written by Terraform, so the key never
    passes through Terraform state or code.
  EOT
  type        = string
  default     = "/covenas-dashboard/google-service-account"
}

variable "gastos_recent_limit" {
  description = "How many of the most recent Gastos rows the API returns in `ultimosGastos`."
  type        = number
  default     = 10
}

variable "lambda_timeout" {
  description = "Lambda timeout in seconds."
  type        = number
  default     = 10
}

variable "lambda_memory_size" {
  description = "Lambda memory in MB. 128 is plenty for a lightweight JSON/HTTP handler like this."
  type        = number
  default     = 128
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the Lambda's log group."
  type        = number
  default     = 14
}

variable "cloudfront_price_class" {
  description = "CloudFront price class. PriceClass_100 (US/Canada/Europe only) is the cheapest and plenty for a family dashboard."
  type        = string
  default     = "PriceClass_100"
}

variable "frontend_build_dir" {
  description = <<-EOT
    Path to the built static frontend assets to upload to S3, relative to
    this infra/ directory. Point this at `../frontend/dist` if the
    frontend gets a build step later; defaults to `../frontend` for a
    plain static site with no build step.
  EOT
  type        = string
  default     = "../frontend"
}
