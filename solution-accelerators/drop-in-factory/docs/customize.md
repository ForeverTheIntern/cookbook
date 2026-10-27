# Customize the factory

Most changes to what the factory does are edits to text files: a step's prompt, a line in `factory.yaml`, or a message template. None of the changes below touch the pipeline's code. After each one, run `npm test` and `npm run doctor`, then restart `npm run dev` (or `npm run deploy` for a hosted Foreman). Foreman reads these files when it starts.

| To change | Edit |
| --- | --- |
| What a step does | `foreman/bot/subagents/<step>/instructions.md` |
| A step's model, deadline or status line | `foreman/bot/subagents/<step>/agent.ts` |
| Which steps run, their order, and the gates | `steps:` in `factory.yaml` |
| Who approves a gate | `approvers` on the gate in `steps:` |
| Instructions several steps share | `foreman/bot/skills/<name>/SKILL.md`, listed in each step's `agent.ts` |
| Rules every step follows | `foreman/bot/subagents/common.md` |
| What Foreman says in Slack and on GitHub | `foreman/bot/templates/*.md` |
| How Foreman's Slack chat behaves | `foreman/bot/instructions.md` and `foreman/bot/tools/` |

## Edit a step's prompt

Each step is a folder in `foreman/bot/subagents/`. Its `instructions.md` is the prompt the step's cloud agent gets. Foreman adds `subagents/common.md`, the step's skills, and a **Run** section with the run id, branch, issue and the earlier steps' documents.

For example, to make Review check accessibility, add a line to `foreman/bot/subagents/review/instructions.md`:

```markdown
Also check that any UI change has labels for screen readers and works with the keyboard alone. Report a missing one as a major finding.
```

Keep the result file's shape as the prompt describes it. Foreman reads `.factory/<run-id>/<step>.json` when the step finishes, and holds the run when the file is missing or malformed. `<run-id>` and `<step>` in a prompt are replaced with the run's values.

## Change a model, a deadline or a gate

**Model or deadline.** Edit `model` or `deadlineMinutes` in the step's `agent.ts`:

```ts
export const step = cloudStep({
  kind: "change",
  model: "cursor-grok-4.5-high",   // any id from GET https://api.cursor.com/v0/models
  deadlineMinutes: 90,             // stopped and held after this long
  runsAs: "cloud-agent",
  status: "Implement is writing the code",
});
```

`npm run doctor` checks that every step's model exists for your key. The spec step also sets `threshold` (the score from 0 to 100 at which it stops asking questions) and `maxRounds` (how many rounds of questions it may ask).

**A gate's approvers.** A gate is an entry in `steps:` right after the step whose work it approves:

```yaml
steps:
  - spec
  - gate: spec
    approvers: [octocat, team:example-org/factory-approvers]   # GitHub logins, or team:org/slug
```

Other gate settings are optional:

- `enabled: false` skips the gate and keeps its settings.
- `approveLabel` and `changesLabel` rename its labels. They default to `factory:<gate>-approved` and `factory:<gate>-changes`, and the doctor creates them.

With several repositories, a repository's entry can override any field of a gate by name: `gates: { spec: { approvers: [alice] } }`. In Slack, the requester and the ids in `slack.approvers` can approve every gate.

**Add or remove a gate.** Add `- gate: <name>` with `approvers` after any step, or delete the entry. A gate's "changes" sends the run back to the step right before it.

## Add or remove a step

**Remove a step.** Delete its line from `steps:`. For example, without a plan:

```yaml
steps:
  - triage
  - spec
  - gate: spec
    approvers: [octocat]
  - implement
  - review
  - verify
```

Delete a gate together with the step it approves. Then check the later steps' prompts for the removed step's document: `review/instructions.md` mentions `design/<run-id>.md`, which only the plan step writes.

**Add a step.** Copy the folder closest to what you want, rename it, edit both files, and add its name to `steps:`. The folder name is the step's id and its stage name: lowercase letters, digits and dashes.

For example, a threat model before implement. Copy `foreman/bot/subagents/plan/` to `foreman/bot/subagents/threat-model/`, keep the two `import` lines at the top of its `agent.ts`, and change the rest to:

```ts
export const step = cloudStep({
  kind: "document",
  document: "security/<run-id>.md",
  model: "cursor-grok-4.5-high",
  deadlineMinutes: 20,
  runsAs: "cloud-agent",
  status: "Threat model is listing the risks",
});

export default defineAgent({
  description: "Threat model: lists what this change could expose and how the code should guard it.",
  model: step.model,
});
```

Then create `foreman/bot/subagents/threat-model/instructions.md`, which says what to write in `security/<run-id>.md` and to write `{"summary": "..."}` to `.factory/<run-id>/threat-model.json`. Last, add `threat-model` to `steps:`, after `plan`, with a gate if a person should approve it. Later steps are told where the document is.

`kind` says what Foreman does with the step's result:

| Kind | Result file | What Foreman does |
| --- | --- | --- |
| `triage` | `duplicates`, `related`, `summary` | A duplicate closes the run. At most one triage step. |
| `spec` | `grades`, `questions`, `assumptions` | Below `threshold`, asks the questions on the issue and in Slack, then reruns. Writes `document`. At most one. |
| `document` | `summary` | Writes `document` on the branch, and may change nothing else. |
| `change` | `summary` | Changes the code. Verdicts and pull request findings send work back to the last change step before them. At least one. |
| `verdict` | `verdict`, `summary`, `findings` | Posts a review on the pull request. `changes` sends the run back to the change step. `video: true` adds the walkthrough video upload. Goes after a change step. |

Each kind's exact result shape is in `foreman/bot/lib/steps/results.ts`, and the shipped prompts show it to the agent. A `steps:` list that can't run (no change step, a verdict before any change, a name with no folder) stops Foreman at start with what to fix.

**Reorder steps.** Move their lines in `steps:`. The same rules apply, and a gate moves with its step.

## Add a skill

A skill is a block of instructions several steps can share. Create `foreman/bot/skills/<name>/SKILL.md`:

```markdown
---
name: screenshots
description: Take before and after screenshots of a UI change and attach them to the pull request.
---

# Screenshots

Open the page the change touches, take a screenshot before and after the change, save them under `/opt/cursor/artifacts/`, and add them to the pull request description under `## Screenshots`.
```

Then list it in each step that needs it, in that step's `agent.ts`: `skills: ["screenshots"]`. Foreman appends the skill, without its frontmatter, to the step's prompt. A listed skill with no `SKILL.md` stops Foreman at start. The shipped example is `walkthrough-video`, which `verify` uses.

## Reword Slack messages

Every message Foreman posts in Slack and on GitHub comes from a template in `foreman/bot/templates/`. Each file is a topic, and each `## name` heading starts one template. For example, the gate's ask is in `gates.md`:

```markdown
## ask.title
{{Gate}} gate: please approve or ask for changes
```

Change the text and keep the `{{...}}` names. `{{#name}}...{{/name}}` shows its text only when the value is set. `foreman/bot/templates/README.md` lists the syntax, and each file's top line says what its templates are for.

Then see every message in context:

```bash
UPDATE_SNAPSHOTS=1 npm test
git diff foreman/tests/snapshots/messages/
```

`foreman/tests/snapshots/messages/` has the full Slack and GitHub transcript of seven scenarios. Review the diff, then commit the snapshots with the template. `npm test` fails if a template uses a value the code doesn't pass, or if a template is renamed or deleted without the code.

A step's status line ("Implement is writing the code") is `status` in its `agent.ts`, and the reply hints that end each ask are in `templates/hints.md`.
