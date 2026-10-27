# Security

Threat model for the drop-in software factory. The customer copies this folder into their own repository and runs Foreman on a host they control.

## What can change the repository

- **Cloud agents** push only to the run branch `factory/<run>`, through the Cursor GitHub app. After each agent the worker checks that it reported that branch and changed only the files its step may write (see ARCHITECTURE.md). Anything else holds the run.
- **The worker** (with the token for `github.identity`: a GitHub App installation token, a bot user's token, or `GH_TOKEN`) creates the run branch, opens and marks ready the run's pull request, comments, posts reviews, closes a duplicate's issue, and creates the factory labels from `npm run doctor`. It closes the pull request and the issue of a run someone abandoned. It never merges and never pushes code.
- **No step merges.** A person merges.

## Who can move a run

On GitHub, only an approver listed in `factory.yaml` (a login or a `team:org/slug` member) can pass a gate or `retry` a held run; GitHub signs in the author of a comment and the actor on a label event.

In Slack, a gate vote (`@foreman approve`, `@foreman changes: …`, or the approve or reject reaction) and an abandon count only from the person who asked for the run in Slack or a Slack user id in `slack.approvers`. Slack signs in the author of a message and the user on a reaction, and code compares that user id with the list before anything moves; Foreman's model never decides. Every Slack vote is recorded on the issue with the Slack user id, the message and the reaction. Anyone who can post in the factory channel can start a run and then steer that run, so keep the channel to people you would let file issues and approve their own specs, or turn off the gates that matter in `factory.yaml` only where that is acceptable.

A vote from before the gate opened, or before the branch last changed, does not count, wherever it was given.

## Untrusted text

Issue bodies, comments, pull request text, Slack messages and repository files are data. `foreman/bot/subagents/common.md` tells every step so, and Foreman's instructions say the same. An instruction hidden in that text cannot move a stage: stage moves are code that reads only gate commands from approvers and the step's result file. Pull request findings from bots in `review.bots`, people's change requests and check summaries reach Implement as feedback, which is data in the same way; a bot outside `review.bots` can't send work back.

## Secrets

`GH_TOKEN`, `CURSOR_API_KEY`, `CURSOR_ADMIN_API_KEY`, the GitHub App's private key or bot user's token (`SA_GH_APP_PRIVATE_KEY`, `SA_GH_BOT_TOKEN`) and the Slack tokens live in Foreman's environment (`.env`, git-ignored). `foreman/bot/lib/config/env.ts` is the only reader. Cloud agents never receive them; an agent gets only its prompt, which contains the issue and the run context. `gh` is run with only `PATH`, `HOME` and `GH_TOKEN` in its environment.

## Dashboard and collector

The dashboard (`dashboard/`) is optional (`dashboard.enabled`). It holds a copy of each run: issue titles, stages, who approved, hold reasons and agent links, but no code, issue bodies or secrets. It cannot change anything: it has no credentials for GitHub, Cursor or Slack, and Foreman reads nothing from it except the list of runs to resend.

- **Viewers.** `SA_PORTAL_AUTH=none` (the default) is only for `127.0.0.1`, where `npm run dev` binds it. Anywhere else use `basic` (a shared login) or `proxy` behind your SSO proxy, and let only the proxy reach it.
- **Ingest.** `POST /api/ingest` accepts only requests signed with HMAC-SHA256 under `SA_PORTAL_INGEST_SECRET`, over a timestamp within 5 minutes and the exact body, and refuses a signature it has already seen. The secret never crosses the wire and never goes in `factory.yaml`. Rotate it by setting a new value on both sides; pushes fail (logged, runs unaffected) until both match, then the next heartbeat catches the dashboard up.
- **Off.** With `dashboard.enabled: false`, Foreman makes no dashboard requests at all.

`setup/compose.yaml` publishes the collector on `127.0.0.1` only. Metrics carry run counts and durations, not issue text.

## Customer responsibilities

- Copy `examples/github-workflows/security-scan.yml` into `.github/workflows/`.
- Keep the approver lists short and current.
- Use a `GH_TOKEN` scoped to this repository.
- Check that your Cursor privacy settings fit sending issue text to cloud agents.

## Data leaving the machine

Issue text and the repository go to Cursor cloud agents, which is the point of the factory. Metrics stay in the local collector unless you add an exporter.

`npm run doctor` checks each Cursor key against the documented `api.cursor.com/v0` API and with `agent-sdk whoami`. Only when `SA_EXPECTED_TEAM_ID` is set does it also send each key to two undocumented Cursor account endpoints on `api2.cursor.sh` to read its team id, which no documented API returns. The agent-sdk CLI uses the same endpoints to resolve a team. That call is isolated in `setup/lib/doctor/team-id.ts`.
