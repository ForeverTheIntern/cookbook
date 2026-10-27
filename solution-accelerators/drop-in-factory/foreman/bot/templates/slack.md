# Slack

Foreman's replies in Slack threads: opening a request, repeat requests,
steering commands and who may give them, plus the links and icons every
Slack message uses. Slack links are `<url|text>`; `<@U123>` mentions a person.

## suggested.title
Open runs

## suggested.message
Which runs are waiting on a person?

## intake.working
Working on it.

## intake.failed
I couldn't open the issue in {{repo}}: {{error}}

## intake.opened
Opened <{{url}}|{{key}} #{{issue}} {{title}}> as run *{{run}}*. Questions, approvals and results go to <{{status}}|its status thread>: reply there and mention @foreman. I still answer here.

## repeat.open
This is run *{{run}}*, already open: {{issue}} ({{stage}}).{{#thread}} Follow it in <{{thread}}|its thread>.{{/thread}} If it is a different request, say how it differs in a new message.

## repeat.duplicate
This was asked as run *{{run}}*, which triage closed as a duplicate of {{links}}, so the work goes on there.{{#thread}} Follow it in <{{thread}}|its thread>.{{/thread}} If it is a different request, say how it differs in a new message.

## repeat.abandoned
This was asked before as run *{{run}}* ({{issue}}), which {{name}} abandoned on {{date}}: {{reason}}. The post-mortem is on the issue.{{#thread}} Follow it in <{{thread}}|its thread>.{{/thread}} If something has changed since, say what in a new message.

## repeat.issue
<{{url}}|{{key}} #{{issue}} {{title}}>

## repeat.someone
someone

## repeat.no-reason
no reason recorded

## mention
<@{{user}}>

## who.requester
<@{{user}}> (who asked)

## who.none
no one yet: list Slack user ids under slack.approvers in factory.yaml

## stranger
<@{{user}}>, your :{{reaction}}: doesn't count: only {{who}} can approve, ask for changes or abandon this run.

## steer.not-allowed
Only {{who}} can approve, ask for changes or abandon this run.

## steer.reason-needed
Give the reason in one line, for example `@foreman abandon: no longer needed`.

## steer.ended
Run {{run}} already ended ({{stage}}).

## steer.no-gate
There is no gate open on run {{run}}; it is at {{stage}}.

## steer.busy
Another runtime is working on this run; try again in a minute.

## steer.done
Done.

## steer.done.tool
Done. The run's status thread has the update.

## steer.no-run
There is no run {{run}}.

## steer.pointer
Updates for run *{{run}}* are in <{{url}}|its status thread>.

## link.issue
<{{url}}|issue #{{issue}}>

## link.pull
<{{url}}|PR #{{pr}}>

## link.agent
<{{url}}|{{role}} agent (open in Cursor)>

## icon.approval
:ballot_box_with_check:

## icon.question
:question:

## icon.reason
:memo:

## icon.findings
:warning:

## icon.passed
:white_check_mark:

## icon.failed
:x:

## hint-line
:speech_balloon: {{hint}}
