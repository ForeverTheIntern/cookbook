# Factory verification map

Read this index, then the feature file. Drive the factory the way an operator does. Do not drive an instance this run did not start.

## Baseline preconditions

- The factory folder is the working directory. Every `npm run` script reads `.env` there itself.
- `SA_VERIFY_EVIDENCE` is `.factory/verify` and `SA_VERIFY_PID_FILE` is `.factory/verify/pids.json`.
- `SA_PORTAL_INGEST_SECRET` is set before launch. `SA_PORTAL_URL` is `http://127.0.0.1:8787`.
- `OTEL_EXPORTER_OTLP_ENDPOINT` is `http://127.0.0.1:4318` and `otelcol-contrib` is available.
- `SA_VERIFY_HOSTED` is unset unless the hosted feature says to set it.
- Never kill a process by name. Cleanup reads the pid file.

## Driving conventions

- Commands are literal. Run them from the factory folder.
- The harness is `npm run doctor`, `npm run verify` and `npm run verdict`.
- A proof keeps the command output and the resulting GitHub or dashboard state.
- Cleanup does not delete the evidence folder.

## Proof and skip reporting

- Doctor proof is `doctor.log` with exit code 0.
- Drive proof is the claim comment on the issue and `drive.json`.
- Dashboard proof is `portal.png` plus the issue URL.
- Hosted proof is the `hosted deploy` line. Skipping it because the flag is off is `blocked`, not a pass.
- Record the verdict with `npm run verdict`.

## Features

- [Doctor](./doctor.md) — accounts, ports, team, GitHub App, missing keys.
- [Launch](./launch.md) — local collector, dashboard and Foreman.
- [Intake](./intake.md) — one labeled issue claimed by Foreman.
- [Dashboard](./dashboard.md) — the overview page after a claim.
- [Hosted deploy](./hosted.md) — deployed SHA against HEAD. Off unless flagged.
