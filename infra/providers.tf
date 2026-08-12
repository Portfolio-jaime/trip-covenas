provider "aws" {
  region = var.aws_region

  # Applied to every resource that supports tags, without having to repeat
  # a `tags = {...}` block on each one individually. random_id/null_resource
  # and other non-AWS-API resources ignore this - it only reaches real
  # taggable AWS resources.
  default_tags {
    tags = {
      Project     = "covenas-dashboard"
      Environment = "production"
      ManagedBy   = "terraform"
      Repository  = "Portfolio-jaime/trip-covenas"
      Owner       = "jaime.henao"
    }
  }
}
