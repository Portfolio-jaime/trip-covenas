resource "aws_apigatewayv2_api" "this" {
  name          = "${var.project_name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"]
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.summary.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "summary" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "GET /api/summary"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_integration" "chat" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.chat.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_route" "chat" {
  api_id    = aws_apigatewayv2_api.this.id
  route_key = "POST /api/chat"
  target    = "integrations/${aws_apigatewayv2_integration.chat.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  # Cheap default throttle - this is a family dashboard, not a public API;
  # keeps a stray script/bot from running up (admittedly tiny) costs.
  default_route_settings {
    throttling_burst_limit = 5
    throttling_rate_limit  = 10
  }

  # Groq's free tier allows ~30 requests/min for the whole account, so the
  # chat gets a much tighter limit than the dashboard.
  route_settings {
    route_key              = aws_apigatewayv2_route.chat.route_key
    throttling_burst_limit = 3
    throttling_rate_limit  = 1
  }
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.summary.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}

resource "aws_lambda_permission" "apigw_invoke_chat" {
  statement_id  = "AllowAPIGatewayInvokeChat"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chat.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
