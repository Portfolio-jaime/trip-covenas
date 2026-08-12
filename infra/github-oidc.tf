# --- GitHub Actions OIDC role -----------------------------------------
#
# Lets GitHub Actions assume a temporary AWS role via OIDC instead of
# storing long-lived access keys as a repo secret. The OIDC *provider*
# (token.actions.githubusercontent.com) is account-wide — AWS only allows
# one per account per issuer URL — and already exists here because
# TaxOps-11 created it first. We reuse it via a data source rather than
# redeclaring it (that would conflict), and create our own IAM *role*,
# trust-scoped to only this repo, so nothing here can touch TaxOps' role
# or vice versa.
data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_role" "github_actions_terraform" {
  name = "covenas-dashboard-github-actions-terraform"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = data.aws_iam_openid_connect_provider.github.arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        # Scoped to this exact repo — without this, any repo whose
        # workflow presents a token to this OIDC provider could assume
        # the role.
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:*"
        }
      }
    }]
  })
}

# MVP, matching TaxOps-11's own documented tradeoff: AdministratorAccess
# rather than a hand-scoped policy. Fine for a single-maintainer personal
# project; revisit before adding a second collaborator to the repo.
resource "aws_iam_role_policy_attachment" "github_actions_admin" {
  role       = aws_iam_role.github_actions_terraform.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

output "github_actions_role_arn" {
  description = "Set this as the AWS_TERRAFORM_ROLE_ARN repo variable in GitHub Actions."
  value       = aws_iam_role.github_actions_terraform.arn
}
