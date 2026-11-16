locals {
  lambda_function_name = "${var.project_name}-summary"
  chat_function_name   = "${var.project_name}-chat"

  # Browsers send these as the Origin header; the chat Lambda rejects any other.
  chat_allowed_origins = compact([
    "https://${aws_cloudfront_distribution.frontend.domain_name}",
    var.custom_domain != "" ? "https://${var.custom_domain}" : "",
  ])
}

data "aws_iam_policy_document" "lambda_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  name               = "${var.project_name}-lambda-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

# Least-privilege inline policy: CloudWatch Logs for this function's own
# log group, plus ssm:GetParameter on exactly the one parameter ARN that
# holds the Google service-account key. Nothing broader (no "*" resources,
# no ssm:GetParameters/GetParametersByPath, no logs:* on other functions).
data "aws_iam_policy_document" "lambda_inline" {
  statement {
    sid    = "WriteOwnLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.lambda_function_name}:*"
    ]
  }

  statement {
    sid       = "ReadGoogleServiceAccountKey"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = [data.aws_ssm_parameter.google_service_account.arn]
  }
}

resource "aws_iam_role_policy" "lambda_inline" {
  name   = "${var.project_name}-lambda-inline"
  role   = aws_iam_role.lambda_exec.id
  policy = data.aws_iam_policy_document.lambda_inline.json
}

# --- Chat function: its own role -------------------------------------------
#
# The Groq key's SSM parameter is created out-of-band (like the Google key),
# so its ARN is built from the name instead of a data source: a missing
# parameter makes the chat answer 503 instead of breaking `terraform plan`.
resource "aws_iam_role" "chat_exec" {
  name               = "${var.project_name}-chat-exec"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume_role.json
}

data "aws_iam_policy_document" "chat_inline" {
  statement {
    sid     = "WriteOwnLogs"
    effect  = "Allow"
    actions = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [
      "arn:aws:logs:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${local.chat_function_name}:*"
    ]
  }

  statement {
    sid       = "ReadGroqApiKey"
    effect    = "Allow"
    actions   = ["ssm:GetParameter"]
    resources = ["arn:aws:ssm:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:parameter${var.groq_api_key_ssm_param_name}"]
  }
}

resource "aws_iam_role_policy" "chat_inline" {
  name   = "${var.project_name}-chat-inline"
  role   = aws_iam_role.chat_exec.id
  policy = data.aws_iam_policy_document.chat_inline.json
}
