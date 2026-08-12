# --- Packaging -------------------------------------------------------------
#
# Terraform doesn't run pip, so we shell out via null_resource to install
# the (deliberately few) third-party dependencies into a local build
# directory, copy the handler in next to them, then zip that directory
# with the `archive` provider. Rebuilds only when handler.py or
# requirements.txt actually change (see `triggers`).
#
# google-auth pulls in `cryptography` (a compiled, Rust-backed extension)
# for JWT signing - it is NOT pure-Python despite the rest of the
# dependency tree being so. Installing it with a plain `pip install -t` on
# a dev machine grabs that machine's platform wheel (e.g. macOS/arm64),
# which fails on Lambda's Amazon Linux runtime with
# `invalid ELF header`. `--platform manylinux2014_x86_64 --only-binary=:all:`
# forces pip to fetch the Linux x86_64 wheel regardless of host OS,
# matching this function's (default) x86_64 architecture.
resource "null_resource" "lambda_build" {
  triggers = {
    requirements_hash = filemd5("${path.module}/../lambda/requirements.txt")
    handler_hash      = filemd5("${path.module}/../lambda/handler.py")
  }

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      rm -rf "${path.module}/build/package"
      mkdir -p "${path.module}/build/package"
      pip3 install --no-cache-dir --quiet \
        --platform manylinux2014_x86_64 \
        --implementation cp \
        --python-version 3.12 \
        --only-binary=:all: \
        -r "${path.module}/../lambda/requirements.txt" \
        -t "${path.module}/build/package"
      cp "${path.module}/../lambda/handler.py" "${path.module}/build/package/handler.py"
    EOT
  }
}

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/build/package"
  output_path = "${path.module}/build/lambda.zip"

  depends_on = [null_resource.lambda_build]
}

# --- Function + logs ---------------------------------------------------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.lambda_function_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "summary" {
  function_name = local.lambda_function_name
  role          = aws_iam_role.lambda_exec.arn
  handler       = "handler.lambda_handler"
  runtime       = "python3.12"
  timeout       = var.lambda_timeout
  memory_size   = var.lambda_memory_size

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      SPREADSHEET_ID      = var.google_spreadsheet_id
      GOOGLE_SA_SSM_PARAM = var.google_service_account_ssm_param_name
      GASTOS_RECENT_LIMIT = tostring(var.gastos_recent_limit)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.lambda,
    aws_iam_role_policy.lambda_inline,
  ]
}
