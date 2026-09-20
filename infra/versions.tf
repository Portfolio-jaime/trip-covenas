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

  # --- State backend: S3, reusing the ai-platform account's tfstate bucket --
  # Migrado a la cuenta dedicada ai-platform-arheanja (080891698277) el
  # 2026-09-19. Reutiliza el bucket tfstate de DIAN-bot con su propia key
  # (un bucket por cuenta, key por proyecto). `use_lockfile` = locking nativo
  # de S3 (Terraform 1.10+), sin DynamoDB.
  backend "s3" {
    bucket       = "dianbot-tfstate-080891698277"
    key          = "trip-covenas/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }
}
