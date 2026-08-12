# Random suffix keeps the bucket name globally unique without the user
# having to pick one.
resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "frontend" {
  bucket = "${var.project_name}-frontend-${random_id.suffix.hex}"
}

# Fully private - CloudFront reaches it via Origin Access Control (OAC),
# nothing is public directly on the bucket.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

locals {
  # Resolved relative to this infra/ module directory (not the caller's
  # working directory), so `terraform` commands work the same regardless
  # of where they're invoked from.
  frontend_dir = "${path.module}/${var.frontend_build_dir}"

  # Empty today (frontend/ has no build output yet) - that's fine, this
  # just uploads nothing until files show up here and `terraform apply`
  # runs again.
  frontend_files = fileset(local.frontend_dir, "**/*")

  content_types = {
    html  = "text/html"
    css   = "text/css"
    js    = "application/javascript"
    mjs   = "application/javascript"
    json  = "application/json"
    svg   = "image/svg+xml"
    png   = "image/png"
    jpg   = "image/jpeg"
    jpeg  = "image/jpeg"
    gif   = "image/gif"
    ico   = "image/x-icon"
    woff  = "font/woff"
    woff2 = "font/woff2"
    txt   = "text/plain"
    webp  = "image/webp"
  }
}

resource "aws_s3_object" "frontend" {
  for_each = local.frontend_files

  bucket = aws_s3_bucket.frontend.id
  key    = each.value
  source = "${local.frontend_dir}/${each.value}"
  etag   = filemd5("${local.frontend_dir}/${each.value}")
  content_type = lookup(
    local.content_types,
    lower(element(split(".", each.value), length(split(".", each.value)) - 1)),
    "application/octet-stream"
  )
}
