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

  # --- State backend: local, on purpose ----------------------------------
  # This is a single-person personal project: no team to coordinate state
  # locking with, and standing up an S3 bucket + DynamoDB lock table just
  # to hold one person's `terraform.tfstate` is pure overhead for the
  # always-free-tier budget this project targets. Local state is a
  # deliberate choice here, not an oversight.
  #
  # If this ever needs a remote backend (e.g. multiple contributors, or
  # just wanting state backed up off one laptop), create a small S3 bucket
  # (+ optionally a DynamoDB table for locking) out of band, then uncomment
  # and fill in:
  #
  # backend "s3" {
  #   bucket         = "your-tfstate-bucket"
  #   key            = "covenas-dashboard/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "your-tfstate-lock-table"
  #   encrypt        = true
  # }
  #
  # ...then run `terraform init -migrate-state` to copy the existing local
  # state into the new backend.
}
