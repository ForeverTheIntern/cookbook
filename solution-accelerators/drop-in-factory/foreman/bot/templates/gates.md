# Gates

A gate's ask for approval, what happens when the branch moves under it,
votes from people who are not approvers, and the record of a decision made
in Slack. `{{Gate}}` is the gate's name with a capital, like `Spec`.

## ask.title
{{Gate}} gate: please approve or ask for changes

## ask.issue
**{{Gate}} gate.** {{ready}} An approver ({{approvers}}) responds {{#pr}}here or on #{{pr}}{{/pr}}{{^pr}}here{{/pr}}, or the requester or a listed approver responds in the Slack status thread.

## ready.document.slack
<{{url}}|{{path}}> is ready at `{{sha}}`.

## ready.document.issue
{{doc}} is ready at {{sha}}.

## ready.work.slack
{{Step}}'s work is ready at `{{sha}}`.

## ready.work.issue
{{Step}}'s work is ready at {{sha}}.

## moved
The branch changed after the {{gate}} gate opened (now {{sha}}). Earlier approvals are stale; approve again.

## ignored
@{{login}} is not an approver for the {{gate}} gate, so their `{{kind}}` was ignored.

## approved
{{gate}} approved by @{{by}}

## changes.reason
changes requested by @{{by}}

## changes.feedback
Changes requested at the {{gate}} gate by @{{by}}:

{{text}}

## slack.via-reply
via Slack reply

## slack.via-reaction
via Slack reaction

## slack.verb.approve
Approved

## slack.verb.changes
Changes requested

## slack.record
**{{verb}} by @{{name}} {{how}}** at the {{gate}} gate.{{#text}}

{{text}}{{/text}}

<sub>Slack user {{user}}, message {{ts}}{{#reaction}}, reaction :{{reaction}}:{{/reaction}}</sub>

## slack.notice
{{verb}} by {{name}} {{how}}.

## slack.approved
{{gate}} approved by {{name}} {{how}}

## slack.changes.reason
changes requested by {{name}} {{how}}

## slack.changes.feedback
Changes requested at the {{gate}} gate by {{name}} in Slack:

{{text}}

## slack.reaction-changes
changes requested with :{{reaction}}: in Slack
