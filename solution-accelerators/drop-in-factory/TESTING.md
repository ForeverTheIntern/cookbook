# Testing

How to test a copy of this folder without credentials or network access to GitHub, Cursor or Slack.

## Isolated copy

From this folder, on any OS:

```bash
npm run check
```

Expected output, at the end:

```text
# fail 0
check: ok
```

[`setup/check.ts`](setup/check.ts) copies the folder to a temp directory without `node_modules`, `data/` or `.env`, runs `npm ci`, the typecheck (which covers Foreman's bot code) and `npm test`, with no credentials in the environment. [`ci/isolated-copy.sh`](ci/isolated-copy.sh) is the same check in bash, for CI runners that prefer a shell script.

## What the tests cover

`npm test` drives the whole pipeline against in-memory GitHub, Cloud Agents and Slack from [`foreman/tests/fakes.ts`](foreman/tests/fakes.ts): the full route, duplicate and out-of-order deliveries, gate authority, holds and `retry`, restarts, Slack intake, metrics and invoice cost. [`foreman/tests/conformance.test.ts`](foreman/tests/conformance.test.ts) is the contract every implementation of the `Ports` interface must meet; it runs against the in-memory implementation and checks that the live one exposes the same calls.

## Live check

A live check needs real credentials and changes a real repository, so it is never part of CI. Follow [the tutorial](docs/tutorial.md) on a test repository: `npm run doctor`, then label a small issue and take it to a merged pull request.

## Example CI

[`examples/github-workflows/static-checks.yml`](examples/github-workflows/static-checks.yml) is the workflow a customer copies into their own `.github/workflows/`. It runs `npm run check` on Ubuntu, macOS and Windows. [`examples/github-workflows/security-scan.yml`](examples/github-workflows/security-scan.yml) runs the secret and code scanners.
