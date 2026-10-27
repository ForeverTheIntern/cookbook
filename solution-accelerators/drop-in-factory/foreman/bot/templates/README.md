# templates

The wording of every message Foreman posts: Slack posts and replies, the status line, issue comments, pull request bodies and reviews, the post-mortem, and the lines its chat model is told about a thread. Code decides when to post and what goes into a message. The words are here.

Each file is a topic (`gates.md`, `merge.md`, `status.md`, ...). In a file, each `## name` heading starts one template, which runs to the next heading. Code asks for `<file>.<name>`, like `gates.ask.title`. Text above the first heading describes the file and is never posted.

| Syntax | Meaning |
| --- | --- |
| `{{name}}` | A value the code passes, like `{{pr}}` or `{{reason}}`. |
| `{{#name}}...{{/name}}` | Shown only when `name` has a value. |
| `{{^name}}...{{/name}}` | Shown only when `name` is empty. |
| `*bold*`, `<url\|text>`, `<@U123>` | Slack formatting, in templates posted to Slack. |
| `**bold**` | GitHub formatting, in templates posted to GitHub. A GitHub link arrives as one value, such as `{{doc}}`, because the code builds it. |

To change one:

- **Reword a message:** edit the text and keep the `{{...}}` names it uses. Then run `UPDATE_SNAPSHOTS=1 npm test`. `foreman/tests/snapshots/messages/` shows every message in context; review the diff and commit it with the template.
- **Name a value the code doesn't pass:** that is a code change. A template that uses a name the code doesn't pass fails in `npm test`.
- **Rename or delete a template:** `foreman/tests/templates.test.ts` fails until the code and the files agree.

A step's own Slack status line ("Implement is writing the code") is `status` in its `subagents/<step>/agent.ts`, not here. [docs/customize.md](../../../docs/customize.md#reword-slack-messages) has an example.
