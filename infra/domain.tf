# --- Custom domain (covenas.taxopsapp.com) -----------------------------
#
# DNS lives on Cloudflare, not Route53 - the domain was already bought
# there, and Route53 would add a $0.50/mo hosted-zone charge for nothing
# we need (see providers.tf tagging notes and CLAUDE.md for why this
# project avoids Route53 generally). Terraform only manages the ACM
# certificate (free, required for CloudFront to serve HTTPS on a custom
# domain) and the CloudFront alias - the actual DNS records are added by
# hand in the Cloudflare dashboard, in two phases:
#
#   1. `terraform apply` with just this file → creates the ACM cert →
#      outputs a CNAME (acm_validation_record) → add it in Cloudflare,
#      set to DNS only (grey cloud, not proxied).
#   2. Once that CNAME resolves, `terraform apply` again → cert finishes
#      validating → CloudFront gets the alias + cert attached → outputs
#      the final CNAME (dashboard_cname_target) → add *that* in
#      Cloudflare too (also DNS only).
#
# Why "DNS only" and not proxied (orange cloud): CloudFront is already a
# CDN with its own TLS termination. Proxying through Cloudflare on top
# would mean two CDNs and two certificates in the chain for no benefit -
# just extra latency and a second place for SSL config to go wrong.

resource "aws_acm_certificate" "dashboard" {
  count             = var.custom_domain != "" ? 1 : 0
  domain_name       = var.custom_domain
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

output "acm_validation_record" {
  description = "Add this as a CNAME in Cloudflare (DNS only) to validate the certificate. Only needed once."
  value = var.custom_domain != "" ? {
    name  = one(aws_acm_certificate.dashboard[0].domain_validation_options).resource_record_name
    type  = one(aws_acm_certificate.dashboard[0].domain_validation_options).resource_record_type
    value = one(aws_acm_certificate.dashboard[0].domain_validation_options).resource_record_value
  } : null
}

# Phase 2: the validation CNAME resolves now (confirmed via dig), safe to
# let this block until ACM sees it.
resource "aws_acm_certificate_validation" "dashboard" {
  count           = var.custom_domain != "" ? 1 : 0
  certificate_arn = aws_acm_certificate.dashboard[0].arn
  validation_record_fqdns = [
    one(aws_acm_certificate.dashboard[0].domain_validation_options).resource_record_name
  ]

  timeouts {
    create = "10m"
  }
}

output "dashboard_cname_target" {
  description = "Once this shows a value, add covenas.taxopsapp.com as a CNAME (DNS only) in Cloudflare pointing at this."
  value       = var.custom_domain != "" ? aws_cloudfront_distribution.frontend.domain_name : null
}

output "dashboard_url" {
  description = "The custom-domain URL, once DNS + validation are both done."
  value       = var.custom_domain != "" ? "https://${var.custom_domain}" : null
}
