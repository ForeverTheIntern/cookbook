# skills

Skills a step can use. Each folder holds a `SKILL.md`: YAML frontmatter with `name` and `description`, then the instructions.

A step lists the skills it wants in its `agent.ts`, for example `skills: ["walkthrough-video"]` in `subagents/verify/agent.ts`. Foreman appends each listed `SKILL.md`, without its frontmatter, to that step's prompt as a `## Skill:` section. A skill no step lists is never sent.

To change one:

- **Change what a skill does:** edit its `SKILL.md`.
- **Add a skill:** create `skills/<name>/SKILL.md` with `name: <name>` in its frontmatter, then add `<name>` to `skills` in the `agent.ts` of each step that needs it.
- **Stop using a skill:** take it out of that step's `skills`.

A step that lists a missing skill stops Foreman at start, with the step's and the skill's names. [docs/customize.md](../../../docs/customize.md#add-a-skill) has an example.

BDK also offers every skill here to Foreman's own Slack chat model, and it reads any `.md` file in this folder as a skill. That is why this file is `README.markdown`.
