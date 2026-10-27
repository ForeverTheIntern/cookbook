# Steps

What Foreman says as each step's cloud agent starts and finishes: the
launch notice, holds when a step goes wrong, triage's duplicates, the spec
step's questions, a verdict step's review and walkthrough video, and the
draft pull request. `{{step}}` is the step's folder name, like `implement`;
`{{Step}}` is the same with a capital, like `Implement`.

## launch
*{{step}}* agent started: <{{url}}|open the session in Cursor>

## launch.title
:robot_face: *{{step}}* agent started

## launch.link
<{{url}}|open the session in Cursor>

## held.deadline
{{step}} did not finish within {{minutes}} minutes ({{url}}).

## held.ended
{{step}} ended with {{status}} ({{url}}).

## held.branch
{{step}} worked on branch {{branch}}, not {{expected}} ({{url}}).

## held.nothing
{{step}} finished but pushed nothing to {{branch}} ({{url}}).

## held.disallowed
{{step}} changed {{file}}, which it may not touch ({{url}}).

## held.result
{{error}} at {{path}} ({{url}}).

## held.send-backs
{{step}} still asks for changes after {{max}} rounds with {{Change}}.

## held.no-spec
the run waits for answers, but steps: in factory.yaml has no spec step to take them.

## pull.title
{{title}} ({{run}})

## pull.body
Closes #{{issue}}

Opened by the factory for run `{{run}}`.{{#spec}} Spec: `{{spec}}`.{{/spec}}

## document.written
{{path}} written

## triage.clear
no duplicates, {{related}} related

## triage.duplicate.issue
Closing this request as a duplicate of:

{{list}}

## triage.duplicate.slack
Closed as a duplicate of:
{{list}}

## triage.duplicate.item
- {{link}} — {{reason}}

## duplicate.link
<{{url}}|{{name}}>{{#thread}} (run *{{run}}*, <{{thread}}|its thread>){{/thread}}

## duplicate.name.here
{{key}} #{{issue}}

## duplicate.name.other
{{repo}}#{{issue}}

## spec.asker
PM

## spec.intro
The {{asker}} has questions (spec score {{score}}/100, round {{round}} of {{max}}).

## spec.question
{{n}}. {{text}}{{#assumption}}
   _If unanswered: {{assumption}}_{{/assumption}}

## spec.issue
{{intro}} Anything you leave out uses the assumption shown.

{{list}}

## spec.low
spec score {{score}} is under {{threshold}}

## spec.ok
spec score {{score}}

## spec.answered.slack
answered in Slack, relayed by @{{login}}

## spec.answered.github
answered by @{{login}}

## verdict.review
**{{step}}: {{verdict}}**

{{summary}}{{#findings}}

{{findings}}{{/findings}}{{#video}}

Walkthrough video: {{video}}{{/video}}

## verdict.finding
- `{{path}}{{#line}}:{{line}}{{/line}}` **{{severity}}**: {{body}}

## verdict.passed
{{step}} passed

## verdict.changes
{{step}} asked for changes

## verdict.feedback
{{step}} asked for changes:

{{summary}}

{{findings}}

## video.passed
{{Step}} passed on #{{pr}}

## video.failed
{{Step}} failed on #{{pr}}, sent back to {{Change}}

## video.agent
<{{url}}|{{step}} agent>

## video.below
Walkthrough video below.

## video.link
Walkthrough video: <{{url}}|watch>

## video.none
No walkthrough video was recorded{{#agent}} (<{{agent}}|{{step}} agent>){{/agent}}.
