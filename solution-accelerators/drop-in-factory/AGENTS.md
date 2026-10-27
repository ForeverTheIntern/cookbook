# AGENTS.md

Rules for agents that change the code of Drop-in Software Factory. To set the factory up for someone instead, follow [docs/agent-setup.md](docs/agent-setup.md). This folder is a template a customer copies, into its own repository or one it serves. It is self-contained: docs, config, scripts and the example CI all live here.

## Secrets and identifiers

- Do not commit credentials, tokens, `.env`, `data/` or local override files.
- Do not commit customer names, tenant ids or real email addresses. Use Example Corp and `@example.com` in samples.

## Shape of the code

- TypeScript only, run by Node 22.14 or later with type stripping. One package; Foreman imports `foreman/bot/lib/`.
- Code moves runs; models only do step work and chat. Do not give Foreman's model a tool that moves a stage.
- Every outside call goes through `foreman/bot/lib/pipeline/ports.ts`. `gh` is used only in `foreman/bot/lib/github/gh.ts`.
- Ingress only inserts events. Only the worker writes runs. Handlers re-read GitHub and stay idempotent: posts through `postOnce`, launches through the one `role_runs` row per visit.
- `foreman/bot/lib/config/env.ts` is the only reader of `process.env`. No fallbacks and no aliases: a setting has one name and a missing one fails with that name.

## Environment variables

A variable this accelerator defines starts with `SA_`. Record it in `.env.example` and the table in `docs/reference.md`. Platform variables (`CURSOR_*`, `OTEL_*`, `GH_TOKEN`) keep their names.

## Docs

Keep `README.md`, `docs/reference.md`, `ARCHITECTURE.md`, `docs/security.md` and `docs/decisions/` in step with the code. When a setup snag shows up, add it to `PREREQUISITES.md` or the reference's setup.

## Before committing

Run `npm run check` from this folder.
