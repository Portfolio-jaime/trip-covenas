locals {
  lambda_function_name = "${var.project_name}-summary"
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
