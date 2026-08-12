# --- Cost safety net ---------------------------------------------------
#
# Expected real cost is $0/month (see docs/ARQUITECTURA.md). This budget
# doesn't change that - it's a tripwire: if something misbehaves (a stray
# script hammering the API despite the throttle, a runaway Lambda loop,
# S3 storage that grows unexpectedly), an email fires instead of the
# surprise showing up unnoticed on a monthly bill.
#
# Scoped to this project's resources only (`Project` tag, set account-wide
# by `default_tags` in providers.tf) - not the whole AWS account, which
# also runs TaxOps-11.
resource "aws_budgets_budget" "covenas_dashboard" {
  name         = "${var.project_name}-cost-guardrail"
  budget_type  = "COST"
  limit_amount = "1"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name = "TagKeyValue"
    # AWS Budgets' tag-filter format is "user:<TagKey>$<TagValue>" - built
    # with format() rather than string interpolation to avoid the literal
    # "$" colliding with Terraform's own "${...}" escaping rules.
    values = [format("user:Project$%s", var.project_name)]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
