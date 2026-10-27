# foreman

Foreman is the factory's one BDK agent. Everything it runs is under `bot/`:

- `bot/channels/github.ts` and `bot/channels/slack.ts` turn GitHub deliveries and Slack messages into pipeline events.
- `bot/schedules/tick.ts` is the minute tick that reconciles every open run.
- `bot/agent.ts` and `bot/instructions.md` are the Slack chat, with the tools in `bot/tools/` (`runs`, `answer`, `gate`, `abandon`, `open_request`).
- `bot/subagents/` holds one folder per step (its prompt and its `agent.ts`), `bot/skills/` the instructions steps share, and `bot/templates/` every message Foreman posts.
- `bot/lib/` is the pipeline code; `bot/hooks/audit.ts` logs each chat turn.

Run it from this directory with `npx --yes @cursor/bdk@0.2.28 serve --dir . --cursor-events --repo owner/name`, or `npm run dev` from the factory folder. Setup is in the factory's README and `docs/reference.md`; changing steps, skills and messages is in `docs/customize.md`.
