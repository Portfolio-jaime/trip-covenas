output "cloudfront_domain_name" {
  description = "Default CloudFront domain (no custom domain configured)."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "cloudfront_url" {
  description = "Full HTTPS URL to the dashboard frontend."
  value       = "https://${aws_cloudfront_distribution.frontend.domain_name}"
}

output "api_invoke_url" {
  description = "Base invoke URL of the HTTP API's default stage."
  value       = aws_apigatewayv2_stage.default.invoke_url
}

output "api_summary_endpoint" {
  description = "Full URL of the GET /api/summary endpoint the frontend should call."
  value       = "${aws_apigatewayv2_stage.default.invoke_url}api/summary"
}

output "s3_bucket_name" {
  description = "Name of the S3 bucket the frontend is synced to."
  value       = aws_s3_bucket.frontend.bucket
}

output "lambda_function_name" {
  description = "Name of the deployed Lambda function."
  value       = aws_lambda_function.summary.function_name
}
