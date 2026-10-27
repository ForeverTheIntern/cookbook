# Runs

A run's lifecycle: claiming the issue, the queue, moving between stages,
holds and retries, the status comment on the issue, and the end on GitHub.
Text in `*stars*` is Slack bold; `**stars**` is GitHub bold.

## claim
Run `{{run}}` started by this factory (Foreman `{{factory}}`).

## claimed-elsewhere
another Foreman (factory {{factory}}) claimed #{{issue}} first

## transition
*{{stage}}* · {{line}}. {{reason}}

## started
branch {{branch}}

## queued.next
Queued: it starts when a running run finishes. The factory runs at most {{perRepo}} per repository and {{total}} in all (`limits` in factory.yaml).

## queued.ahead.one
Queued: {{n}} run is ahead of it. The factory runs at most {{perRepo}} per repository and {{total}} in all (`limits` in factory.yaml).

## queued.ahead.many
Queued: {{n}} runs are ahead of it. The factory runs at most {{perRepo}} per repository and {{total}} in all (`limits` in factory.yaml).

## hold.slack
Run held at *{{stage}}*: {{reason}}

## hold.issue
Run held at *{{stage}}*: {{reason}}

Fix the cause, then an approver comments `retry` on this issue.

## held.reconcile-failed
the factory could not reconcile it {{n}} times in a row: {{error}}

## held.unknown-stage
{{stage}} is no longer in steps: in factory.yaml. Put it back, or move the run on by hand.

## retry
retry by @{{login}}

## issue-status
**Factory status** for run `{{run}}`: **{{stage}}** · {{line}}{{#hold}} (held: {{hold}}){{/hold}}
{{#pr}}Pull request: #{{pr}}
{{/pr}}Running agent sessions: {{#agents}}{{agents}}{{/agents}}{{^agents}}none{{/agents}}{{#thread}}
Slack status thread: {{thread}}{{/thread}}

## issue-status.agent
{{role}} agent

## merged.issue
Merged in #{{pr}}. Run closed.

## merged.slack
Merged: <{{url}}|#{{pr}}>

## merged.title
Merged #{{pr}}

## merged.body
by @{{by}}

## merged.reason
merged by @{{by}}
