data "aws_caller_identity" "current" {}

data "aws_region" "current" {}

# The parameter itself is created out-of-band via `aws ssm put-parameter`
# (see infra/README.md) - Terraform never writes the Google service-account
# key. This data source must therefore run AFTER that put-parameter step;
# `terraform apply` will fail with a "parameter not found" error if the
# parameter doesn't exist yet, which is intentional (fail loud, not silent).
#
# `with_decryption = false` on purpose: we only ever use `.arn` from this
# data source (to scope the Lambda's IAM policy), never `.value`, so the
# decrypted secret is never pulled into Terraform state.
data "aws_ssm_parameter" "google_service_account" {
  name            = var.google_service_account_ssm_param_name
  with_decryption = false
}
