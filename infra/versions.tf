terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # --- State backend: S3, reusing the same account's existing bootstrap --
  # `taxops11-tfstate-786567028012` is a versioned, encrypted, public-
  # access-blocked bucket already standing in this same personal AWS
  # account (786567028012) for the TaxOps-11 project. Rather than stand up
  # a second bootstrap bucket for one more personal project, this reuses
  # it with its own key prefix — no bucket-per-project needed.
  # `use_lockfile` is Terraform 1.10+'s native S3 locking, so no DynamoDB
  # table is needed either.
  backend "s3" {
    bucket       = "taxops11-tfstate-786567028012"
    key          = "trip-covenas/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
