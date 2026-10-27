# GitHub Actions examples

Copy a workflow into `.github/workflows/` in the repository that holds your copy of this accelerator. Nothing here runs until you copy it.

| File | What it does |
| --- | --- |
| [`static-checks.yml`](static-checks.yml) | Runs `npm run check` with no cloud credentials on Ubuntu, macOS and Windows, and calls the security scan. |
| [`security-scan.yml`](security-scan.yml) | Runs gitleaks, semgrep, bandit, pip-audit, osv-scanner, npm audit, checkov, and shellcheck. A high or critical finding fails the job. |
