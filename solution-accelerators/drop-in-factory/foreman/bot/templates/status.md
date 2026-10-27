# Status message

Each run's top-level message in the factory channel, edited as the run
moves. Its first line is the state, then a detail; links follow. The parts
are joined with ` · `.

## header
{{title}} ({{repo}})

## title
{{issue}} {{title}}

## run
run `{{run}}`

## link.issue
{{key}} #{{issue}}

## link.pull
PR #{{pr}}

## link.agent
{{role}} agent (open in Cursor)

## cost
${{cost}} {{state}}

## done
✅ *done*

## done.detail
{{#pr}}merged in PR #{{pr}}{{/pr}}{{^pr}}merged{{/pr}}

## closed
⚪ *closed*

## abandoned
🗑️ *abandoned*

## ended.detail
run closed

## failed
⛔ *failed* at {{stage}}

## failed.hint
comment `retry` on the issue

## starting
🔄 *starting*

## queued
🕒 *queued*

## queued.next
starts when a running run finishes

## queued.ahead.one
{{n}} run ahead

## queued.ahead.many
{{n}} runs ahead

## merge.ready
⏳ *ready to merge*

## merge.waiting
waiting on review and merge on GitHub

## merge.conflict
waiting on a conflict fix: the PR conflicts with {{base}}

## merge.checks
⏳ *checks running*

## merge.checks.detail
waiting on CI before it is ready to merge

## merge.findings
⚠️ *needs a decision*

## merge.findings.detail
review findings remain after the send-back limit

## questions
⏳ *questions*

## questions.detail
waiting on answers to the {{asker}}'s questions

## gate
⏳ *{{gate}} gate*

## gate.detail
waiting on {{gate}} approval, in this thread or on GitHub

## running
🔄 *{{stage}}*
