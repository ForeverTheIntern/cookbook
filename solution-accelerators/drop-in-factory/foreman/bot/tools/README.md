# tools

The tools Foreman's Slack chat model can call. Each file is one Agent SDK `defineTool`: its `description` tells the model when to use it, `inputSchema` is what the model passes, and `execute` runs it.

| Tool | What it does | Needs a person's OK in Slack |
| --- | --- | --- |
| `runs.ts` | Reads runs from the store: stage, history, agents and cost. | no (read-only) |
| `answer.ts` | Relays the requester's answers to the spec step's questions to the issue. | no |
| `open_request.ts` | Opens a request in a shared channel once the repository is known. | no |
| `gate.ts` | Approves a gate, or sends it back with changes. | yes |
| `abandon.ts` | Abandons a run, with a reason. | yes |

`gate` and `abandon` set `needsApproval: true`. Slack asks a person to confirm the call, and the pipeline counts it only when the person who confirmed is the run's requester or a listed `slack.approvers` id, the same check a reply or reaction gets. The model can't approve anything by itself.

To change one:

- **Change when the model uses a tool:** edit its `description`, or `bot/instructions.md`, which is the chat model's standing instructions.
- **Add a tool:** add `<name>.ts` exporting `defineTool({...})` as default. The Agent SDK finds it by file name. Set `effect: "write"` and `needsApproval: true` on anything that changes a run.
- **Remove a tool:** delete the file and any mention of it in `bot/instructions.md`.

`foreman/tests/agent-sdk-layout.test.ts` lists the tools the Agent SDK must find; update it when you add or remove one.
