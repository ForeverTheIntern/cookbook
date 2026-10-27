# Prerequisites

What has to be true before setup. The [README](README.md) links here, and [the tutorial](docs/tutorial.md) walks through each item. When a setup hits a snag, add it under Snags with the command, the error and the fix.

## Checklist

| Id | Requirement | How to tell |
| --- | --- | --- |
| P1 | This folder is in a repository of its own (recommended), or in a folder of one it serves | `factory.yaml` `repo` or `repos` names the repositories it works on |
| P2 | Cursor plan with cloud agents enabled; if your team uses privacy mode, it allows cloud agents | <https://cursor.com/agents> starts an agent |
| P3 | The Cursor GitHub app is installed on the repository with write access | cursor.com/dashboard → Integrations → GitHub lists the repository |
| P4 | The account behind `CURSOR_API_KEY` (a service-account key works) is itself connected to GitHub in Cursor and can see the repository | `curl -s -u "$CURSOR_API_KEY:" https://api.cursor.com/v0/repositories` lists it; `npm run doctor` checks it |
| P5 | A cloud agent environment for the repository (recommended) | Verify can install dependencies and run the tests |
| P6 | `GH_TOKEN` can read and write contents, issues and pull requests (and read team membership for `team:` approvers) | `npm run doctor` prints `ok    GitHub repository` |
| P7 | Slack (optional): an app from `foreman/.slack/manifest.prod.json`, with `files:write` and `reactions:read`, invited to the factory channel | `npm run doctor` prints `ok    Slack … the bot token has chat:write, files:write, reactions:read, users:read` |
| P7a | Foreman's GitHub identity (optional): a GitHub App installed on the repositories with contents, issues and pull requests write and checks read (`npm run github-app` makes one), or a bot user's token | `npm run doctor` prints `ok    <key>: factory identity` naming who Foreman posts as |
| P8 | A host whose disk survives restarts, for Foreman's store (or deploy Foreman to Cursor hosting) | `foreman/.agent-serve/` is still there after a reboot |
| P9 | Hosted only: the folder is pushed to a GitHub repository your team's Cursor GitHub App can read | `npm run deploy -- --dry-run` succeeds; see Snags |

## Tools

- Node.js 22.14 or later ([`.nvmrc`](.nvmrc) names the tested minimum). Not Bun.
- `gh`, the GitHub CLI, on Foreman's `PATH`. It is used only for the issue timeline (who added a gate label) and the Deployments GraphQL query.
- `lsof`, so `npm run doctor` can say which process owns ports 8787 and 8790. On Linux, lsof 4.95 misses Next's `next-server`; the doctor then reads `/proc/net/tcp`.
- Optional, for metrics: Docker with Compose, or the `otelcol-contrib` binary. Without Docker: `curl -fsSL https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.163.2/otelcol-contrib_0.163.2_linux_amd64.tar.gz | tar xz otelcol-contrib` (tested 0.163.2; other platforms are on the [releases page](https://github.com/open-telemetry/opentelemetry-collector-releases/releases)).
- A Cursor team admin, only to create `CURSOR_ADMIN_API_KEY` for invoice cost.

## Environment

Variables this accelerator defines start with `SA_`. Copy them from [`.env.example`](.env.example). Platform variables keep the name the platform reads: `GH_TOKEN` is the GitHub CLI's, `CURSOR_*` are Cursor's, `OTEL_*` are OpenTelemetry's, and `FOREMAN_SLACK_BOT_TOKEN` / `FOREMAN_SLACK_APP_TOKEN` are the names the BDK's Slack channel reads for the `foreman` agent.

| Variable | Who sets it | Notes |
| --- | --- | --- |
| `GH_TOKEN` | You (GitHub token) | Read by the worker and `gh`. |
| `CURSOR_API_KEY` | You (Cursor dashboard) | Launches the step agents. Its account needs GitHub access (P4). |
| `CURSOR_ADMIN_API_KEY` | A Cursor team admin | Optional. Without it invoice cost is not emitted. Must be from the team of the account behind `CURSOR_API_KEY`; the doctor checks it with a live call. |
| `SA_FACTORY_CONFIG` | You | Usually `factory.yaml`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | You | The collector's OTLP/HTTP address, such as `http://localhost:4318` for the one `docker compose -f setup/compose.yaml up -d` starts. The doctor fails while it is empty. |
| `SA_PORTAL_URL`, `SA_PORTAL_INGEST_SECRET` | You (`openssl rand -hex 32`) | Only for a dashboard you host; `npm run dev` fills both for the local one. Not needed with `dashboard.enabled: false`. |
| `FOREMAN_SLACK_BOT_TOKEN`, `FOREMAN_SLACK_APP_TOKEN` | You (Slack app) | Required when `factory.yaml` has a `slack` block. |
| `SA_GH_APP_ID`, `SA_GH_APP_PRIVATE_KEY` | `npm run github-app` | Only with `github.identity: app`. |
| `SA_GH_BOT_TOKEN` | You (the bot account's token) | Only with `github.identity: bot-user`. |

On Cursor hosting the platform owns `CURSOR_API_KEY` and `GH_TOKEN`, so the deployment `foreman` reads the factory's keys as `SA_CURSOR_API_KEY`, `SA_GH_TOKEN` and `SA_CURSOR_ADMIN_API_KEY` instead. Locally either name works, and the `SA_` one wins. Set them with `npx --yes @cursor/bdk@0.2.28 secret set foreman <NAME>` before you deploy code that reads them.

## Snags

Symptom: the doctor prints `FAIL  Cloud Agents API: the account behind CURSOR_API_KEY cannot see owner/repo through the Cursor GitHub app (it sees 0 repositories)`, or a run is held with `Cloud Agents POST /agents returned 400: {"error":"Failed to verify existence of branch 'factory/f-gh-79' …"}`.

Cause: the key came from a newly invited team member whose Cursor account had never connected GitHub. The API accepts the key and lists every model, but cloud agents run as that account and cannot see the repository.

Fix: sign in as that account and connect GitHub with access to the repository, or use a key from an account that has it. Then run the doctor again and comment `retry` on a held issue.

```bash
curl -s -u "$CURSOR_API_KEY:" https://api.cursor.com/v0/repositories
npm run doctor
```

Symptom: the doctor prints `FAIL  ports:` with a pid on 8790, or on 8787 that is not the dashboard this session started.

Cause: an earlier portal or Foreman is still listening. A later doctor or launch then talks to that process.

Fix: stop that pid (the line names it). `npm run verify -- cleanup` stops only a factory this verification run started. Do not `pkill` by process name if other work is using the machine.

Symptom: `lsof -nP -iTCP:8787 -sTCP:LISTEN` is empty while `curl http://127.0.0.1:8787/api/health` returns `{"ok":true}`.

Cause: lsof 4.95 does not list the `next-server` process Next.js 15 uses for the dashboard. The port is taken.

Fix: trust `npm run doctor`. On Linux it reads `/proc/net/tcp` when lsof reports the port free.

Symptom: `FAIL  CLI auth:` names two different emails, or `FAIL  team:` names an unexpected team id.

Cause: the CLI credential, a stored login in `~/.cursor/cli-config.json`, or `CURSOR_SERVICE_ACCOUNT_KEY` is a different account or team from the key Foreman launches with. A hosted deploy then goes to the wrong team.

Fix: unset the extra credential, or set `CURSOR_API_KEY` to the account whose team you mean. Re-run the doctor. The `team` line prints the id and name it found. Set `SA_EXPECTED_TEAM_ID` and `SA_EXPECTED_TEAM_NAME` when a proof has to pin them.

On Windows the extra credential can be `authInfo` in `%USERPROFILE%\.cursor\cli-config.json` (the Cursor CLI), while `bdk whoami` already uses a different stored login that matches the launch key. Copy the file aside, remove the `authInfo` object, and run the doctor again. Leave the rest of the file. BDK does not read that file; the doctor does, so a second plus-alias on the same team still fails the check.

Symptom: a hosted deploy fails with "not accessible through this team's installation".

Cause: BDK builds from a pushed ref, and the team's Cursor GitHub App installation can't read the repository it was asked to build from. The deploy pointed at a repository in a different GitHub organization from the one the team's App is installed on.

Fix: deploy from a repository the team's App can read, normally your own copy of this folder. Push it, then `npm run deploy` (it uses `origin` and the current branch), or pass `--repo https://github.com/your-org/your-repo --ref <branch>`. Don't deploy again to see the same error.

Symptom: `npm run deploy` stops with "commit or stash these first" or "Push HEAD to <branch> first".

Cause: BDK builds the pushed branch, not your working tree, so a deploy with local changes would run different code from what you have.

Fix: commit, `git push origin <branch>`, and run it again.

Symptom: `npx --yes @cursor/bdk@0.2.28 secret set foreman SA_GH_TOKEN` hangs or fails in a script or a cloud agent shell.

Cause: `secret set` reads the value from a hidden prompt, and nothing can answer it there.

Fix: pipe the value in with the `.env` loaded: `printf %s "$GH_TOKEN" | npx --yes @cursor/bdk@0.2.28 secret set foreman SA_GH_TOKEN`. Don't use `--from-argv`, which puts the value on the command line.

Symptom: `npx --yes @cursor/bdk@0.2.28 slack create --dir . --env prod` prints `Finish Slack setup in the browser: https://cursor.com/dashboard/deployed-agents/slack-setup?wizardId=…` and waits.

Cause: the hosted Slack app is made in a browser wizard, signed in to Cursor as the account that ran the command (the account behind `CURSOR_API_KEY`).

Fix: open the link as that account and finish it. Do it once per deployment: a redeploy keeps the Slack app, so when `npx --yes @cursor/bdk@0.2.28 secret list foreman` already shows `FOREMAN_SLACK_BOT_TOKEN`, skip `slack create`.

Symptom: going hosted only, `npm run doctor -- --hosted` fails `OTel collector: fetch failed`.

Cause: the doctor runs every local check as well as the hosted ones, and metrics stay required, though a hosted Foreman can't reach a collector ([Known issues](docs/reference.md#known-issues)).

Fix: start the collector from the tutorial's Step 6 on the machine that runs the doctor.

Symptom: a Slack test as a separate test person (for example a `you+tester@example.com` Gmail alias) stops at Slack's "We don't recognize this browser" page asking for a 6-digit code.

Cause: Slack emails a security code to that address each time a new browser signs in with the password.

Fix: read the code from the inbox the alias delivers to, and enter it. Sign in once per browser profile and keep it. Clear any unsent draft Slack restores in the message box before you type, so you never send a draft that holds a sign-in email or password.

Symptom: `npm run verify -- drive` prints `claimed`, but the issue has two claim comments with different Foreman ids, and your `dev.log` says `closed: another Foreman (factory …) claimed #N first`.

Cause: another person's local Foreman watches the same repository with the same local intake label (for example `factory:run-dev`), and it claimed the issue first.

Fix: give your local config a label with your name in it, such as `intakeLabel: factory:run-dev-alice` in `factory.local.yaml`, then run cleanup and drive again. Drive fails when a second Foreman claims the issue.

Symptom: `npm run doctor -- --hosted` prints `FAIL  hosted release: foreman runs release …, and no deploy of it is recorded`.

Cause: the release was made with `bdk deploy` directly, so nothing recorded its source; `deployment get` doesn't report one.

Fix: deploy with `npm run deploy` and commit `setup/verdicts/deploys.jsonl`.
