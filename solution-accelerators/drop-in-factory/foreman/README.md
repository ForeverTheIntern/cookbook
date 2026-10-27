# foreman

Foreman is the factory's one Agent SDK agent. Everything it runs is under `bot/`:

- `bot/channels/github.ts` and `bot/channels/slack.ts` turn GitHub deliveries and Slack messages into pipeline events.
- `bot/schedules/tick.ts` is the minute tick that reconciles every open run.
- `bot/agent.ts` and `bot/instructions.md` are the Slack chat, with the tools in `bot/tools/` (`runs`, `answer`, `gate`, `abandon`, `open_request`).
- `bot/subagents/` holds one folder per step (its prompt and its `agent.ts`), `bot/skills/` the instructions steps share, and `bot/templates/` every message Foreman posts.
- `bot/lib/` is the pipeline code; `bot/hooks/audit.ts` logs each chat turn.

Run it from this directory with `npx --yes @grok/agent-sdk@0.3.0 serve --dir . --cursor-events --repo owner/name`, or `npm run dev` from the factory folder. The Agent SDK (`@grok/agent-sdk`) installs its CLI as both `agent-sdk` and `bdk`, so after `npm install` here `npx agent-sdk serve …` and `npx bdk serve …` work the same. Setup is in the factory's README and `docs/reference.md`; changing steps, skills and messages is in `docs/customize.md`.
