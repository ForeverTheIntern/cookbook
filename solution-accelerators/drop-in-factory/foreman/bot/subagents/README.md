# subagents

Each folder here is one pipeline step. Foreman runs it as a Cursor cloud agent on the run's branch when `steps:` in `factory.yaml` reaches it.

| File | What it controls |
| --- | --- |
| `<step>/instructions.md` | The step's prompt: what it reads, what it writes and the shape of its result file. |
| `<step>/agent.ts` | `cloudStep({...})`: the model, the deadline, the Slack status line, the skills it gets, and its `kind`, which says what its result means (triage, spec, document, change or verdict). `defineAgent` gives BDK the description and model. |
| `common.md` | Rules added to every step's prompt, after its own instructions. |

The folder name is the step's id. It is the stage name in Slack and on the issue, the entry in `steps:`, and the result file `.factory/<run-id>/<step>.json`.

To change one:

- **Reword a step:** edit its `instructions.md`. The next run that reaches the step uses it.
- **Change its model or deadline:** edit `model` or `deadlineMinutes` in its `agent.ts`. `npm run doctor` checks the model id.
- **Add a step:** copy the folder closest to what you want, rename it, then edit both files. Add the name to `steps:` in `factory.yaml`.
- **Remove a step:** take it out of `steps:`. The folder can stay.

`kind` is the only part tied to code (`foreman/bot/lib/steps/`). Each kind's result shape is in `lib/steps/results.ts`. [docs/customize.md](../../../docs/customize.md) walks through each change.
