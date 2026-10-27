---
name: verify-factory
description: "Prove a running Drop-in Software Factory the way an operator would: launch it, run the doctor, label one issue, and keep the screenshot and logs. Use for verify-factory, a factory proof, or when ports, CLI auth, the team, or a deployed SHA look wrong."
---

# Verify the factory

This skill proves one copy of Drop-in Software Factory. Run it from the factory folder (the directory that contains `package.json` and `factory.yaml`). It uses the Cursor sign-in and the environment already loaded for Foreman. Do not ask the person to paste an API token. If a check names a missing variable, say which variable and stop.

Copy this folder to `.cursor/skills/verify-factory/` to install it. The factory folder stays where it is.

Hosted deploy checks are off unless `SA_VERIFY_HOSTED=1`. Leave it unset while GitHub App installation for the team is blocked. A local proof does not deploy.

## Launch

Reach a usable factory from an empty local dashboard. Set the variables in `.env.example`.

The scripts read `.env` themselves. Add the verification settings to the shell (bash shown; in PowerShell use `$env:NAME = "value"`):

```bash
export SA_VERIFY_EVIDENCE=.factory/verify
export SA_VERIFY_PID_FILE=.factory/verify/pids.json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
export SA_PORTAL_URL=http://127.0.0.1:8787
export SA_PORTAL_INGEST_SECRET="$(openssl rand -hex 32)"
```

`SA_PORTAL_INGEST_SECRET` has to be set before launch. `npm run dev` invents one when it is empty, and the doctor then cannot probe the dashboard.

The collector binary is `otelcol-contrib` on `PATH`, or `SA_OTELCOL_BIN`. The tutorial's Step 6 is the install. Docker is not required.

```bash
npm run verify -- launch
```

Ready means `http://127.0.0.1:8787/api/health` returns 200 and the command prints `ready`. The dev log is `.factory/verify/dev.log`. Ports 8787 and 8790 must be free before launch. The command exits 1 and stops nothing when they are taken.

## Doctor

Run this after launch, and whenever something looks wrong. It is read-only except for creating missing factory labels.

```bash
npm run doctor -- --pids .factory/verify/pids.json
```

Every `FAIL` line exits 1. `info` and `note` are not failures. The lines that answer the usual questions:

| Line | What it answers |
| --- | --- |
| `ports` | Who owns 8787 and 8790 (or `SA_DOCTOR_PORTS`). 8787 may be the dashboard. Anything else listening is a leftover. With `SA_VERIFY_PID_FILE` set, 8787 must be a process this launch started. |
| `CLI auth` | `agent-sdk whoami`: the email, the credential source (`env`, `login`, `service-account`, …), and the team name. It must be the launch key's account. A different email in `~/.cursor/cli-config.json` fails. `CURSOR_AUTH_TOKEN` is named when set; the Agent SDK CLI does not read it. |
| `team` | Team name from `agent-sdk whoami`, and the team id when `SA_EXPECTED_TEAM_ID` is set (an undocumented lookup; see `setup/lib/doctor/team-id.ts`). Set `SA_EXPECTED_TEAM_ID` and `SA_EXPECTED_TEAM_NAME` to require a match. Nothing is hardcoded. |
| `key <NAME>` | Which account owns each set key: `CURSOR_API_KEY` or `SA_CURSOR_API_KEY`, `GH_TOKEN` or `SA_GH_TOKEN`, and `CURSOR_SERVICE_ACCOUNT_KEY` when it is set. A service-account key on another team fails. |
| `GitHub App` | The launch account's GitHub App installation reaches every repository in `factory.yaml`. |
| `hosted release` | Off unless `SA_VERIFY_HOSTED=1`. Then `deployment get` (a read, not a deploy) must report the release in the last `npm run deploy` record, and that record's file digest must match this folder at HEAD. |
| `hosted secrets` | Off unless `SA_VERIFY_HOSTED=1`. Then the deployment must have the secret names the factory reads there. |

`Cloud Agents API`, `GitHub repository`, Slack, the collector, the dashboard and the Admin API are the same checks as before.

## Drive

One issue, on one configured repository. This opens a real issue and adds the intake label. Foreman launches a cloud agent for triage, so run cleanup when the claim appears.

When a hosted Foreman already watches these repositories, point `SA_FACTORY_CONFIG` at a git-ignored file whose `intakeLabel` is not the hosted one, and not one another person's local Foreman uses. Only that label starts a run. The note on a local Foreman next to a hosted one, under Go hosted in `docs/reference.md`, is the setup.

```bash
export SA_VERIFY_DRIVE=1
export SA_VERIFY_REPO=owner/name   # optional; the first repository in factory.yaml otherwise
npm run verify -- drive
```

It worked when the command prints `claimed factory/f-<key>-<issue>`. The issue number is `.factory/verify/started.json`. The wait is `SA_VERIFY_DRIVE_TIMEOUT_MS` (default 240000). A timeout still writes `started.json` so cleanup can close the issue. Drive exits 1 when a second Foreman claims the issue too: someone else's local Foreman uses the same label, so give yours one with your name in it (`docs/reference.md`, "A local Foreman next to a hosted one").

Do not merge. Do not approve a gate. The claim comment is the proof that the pipeline took the issue.

## Evidence

Screenshots and logs stay in `SA_VERIFY_EVIDENCE` (default `.factory/verify`):

- `dev.log`, `collector.log` — the processes launch started
- `portal.png` — the dashboard after `npm run verify -- evidence`
- `drive.json` — the issue, run id and branch
- `doctor.log` — redirect `npm run doctor` here yourself

```bash
npm run doctor > .factory/verify/doctor.log
npm run verify -- evidence
```

`portal.png` needs Chrome (`google-chrome` or `SA_CHROME_BIN`). The picture is the overview: the heading Factory, the KPIs section, and the Runs table. A proof is the claim comment on the issue plus that picture, not the picture alone.

Record the verdict after a real run. The ledger is `SA_VERIFY_LEDGER` (default `setup/verdicts/ledger.jsonl`, committed), and a markdown copy is written next to it. The head SHA defaults to the newest commit outside `setup/verdicts/`, so committing the row voids nothing.

```bash
npm run verdict -- append --pr <number> --verdict live-verified --verifier "<agent, model>" --evidence ".factory/verify/doctor.log, media/…" --note "local claim; hosted not checked"
npm run verdict -- show --pr <number>
```

Verdicts are `live-verified`, `docs-run-verified`, `unit-test-verified`, `type-check-only`, `blocked` or `failed`. Appending a row for a new SHA voids older rows for that pull request. `show` exits 1 when the open row is for a different SHA. Use `live-verified` only when the doctor exited 0, drive printed `claimed`, and `portal.png` shows the dashboard. Use `blocked` when hosted deploy was the thing under test and `SA_VERIFY_HOSTED` is not 1. Commit `setup/verdicts/` with the row.

## Cleanup

Stop only the pids in `.factory/verify/pids.json`, and only when the process start time still matches. That check is followed by SIGTERM, then SIGKILL, on the same process group, so a child that ignores SIGTERM does not keep a port. Close the issue in `started.json` when its body still says `Opened by verify-factory.` Delete `factory/<run-id>` when that file recorded it. Stop a cloud agent only when it is on that branch. Evidence is kept.

```bash
npm run verify -- cleanup
```

Run cleanup after a failed launch or drive too. Confirm with `npm run doctor` (the `ports` line) or with `lsof -nP -iTCP:8787 -sTCP:LISTEN` and the same for 8790. On Linux, lsof 4.95 does not list Next's `next-server`, so a live dashboard can look free to lsof; the doctor reads `/proc/net/tcp` in that case. Do not `pkill` by process name.

## Helpers

| Command | What it does |
| --- | --- |
| `npm run doctor` | The checks in Doctor. |
| `npm run verify -- launch` | Start collector and `npm run dev`. Record pids. |
| `npm run verify -- drive` | Open one labeled issue. Requires `--yes` or `SA_VERIFY_DRIVE=1`. |
| `npm run verify -- evidence` | Screenshot the dashboard into the evidence folder. |
| `npm run verify -- cleanup` | Stop this run's processes and close this run's issue. |
| `npm run verdict -- append\|show` | The SHA-keyed ledger. |

The feature map is [features/README.md](features/README.md). Keep it honest with `/maintain-verification-skill` when routes or commands change.
