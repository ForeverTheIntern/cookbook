# Reply hints

The one line that ends every ask: how to answer in Slack, and how to answer
on the GitHub issue. The Slack reaction names come from `slack.reactions` in
factory.yaml.

## slack.approval
Reply here and mention @foreman, for example `@foreman approve` or `@foreman changes: <what to change>`. Or react :{{approve}}: to approve, :{{reject}}: to ask for changes.

## slack.question
Reply here and mention @foreman, for example `@foreman Admins only`. `@foreman go ahead` uses the assumptions shown.

## slack.reason
Reply here and mention @foreman, for example `@foreman abandon: no longer needed`.

## slack.findings
Reply here and mention @foreman, for example `@foreman abandon: <why>`, or push a fix or merge on GitHub.

## slack.status
Reply here and mention @foreman, for example `@foreman approve` at a gate, or `@foreman abandon: <why>` to stop the run. React :{{abandon}}: here to abandon.

## issue.approval
_To respond, comment `approve` or `changes: <what to change>`, or add the `{{approveLabel}}` or `{{changesLabel}}` label._

## issue.question
_To respond, comment with your answers, or `go ahead` to use the assumptions shown._

## issue.reason
_To respond, comment with the reason in one line._

## issue.findings
_To respond, push a fix, merge as is, or close the pull request._
