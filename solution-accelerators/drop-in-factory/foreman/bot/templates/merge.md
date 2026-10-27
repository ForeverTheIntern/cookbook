# Watching the pull request

After the last verdict passes, Foreman watches the pull request until it
merges: findings it sends back, the ask when the send-back limit is hit,
"ready to merge", and conflicts. `{{Change}}` is the change step's name with
a capital, like `Implement`.

## finding.thread
@{{login}} on `{{path}}{{#line}}:{{line}}{{/line}}`: {{body}}

## finding.review
@{{login}} requested changes: {{#body}}{{body}}{{/body}}{{^body}}(no summary; see the review comments){{/body}}

## finding.check
check `{{name}}` {{conclusion}}{{#summary}}: {{summary}}{{/summary}} ({{url}})

## finding.item
- {{what}}

## new-commit
new commit {{sha}} on #{{pr}} after verify

## cap.title
#{{pr}} has new findings, and {{Change}} has had {{max}} rounds already. How do you want to go on?

## cap.issue
#{{pr}} has new findings after {{max}} rounds with {{Change}}, so Foreman stopped sending work back:

{{list}}

## findings.feedback
Findings on pull request #{{pr}} after verify:

{{list}}

## findings.issue
Sending #{{pr}} back to {{Change}} for:

{{list}}

## findings.slack
Sending #{{pr}} back to {{Change}} for:
{{list}}

## findings.reason.one
{{n}} finding on #{{pr}}

## findings.reason.many
{{n}} findings on #{{pr}}

## ready.issue
Verify passed and checks are green. #{{pr}} is ready for review and merge.

## ready.slack
Ready to merge: <{{url}}|#{{pr}}>

## ready.title
Ready to merge: #{{pr}}

## ready.body
Verify passed and checks are green. Foreman keeps watching it for findings and pushes until it merges or closes.

## conflict
#{{pr}} conflicts with `{{base}}`: another merge changed the same files. Merge `{{base}}` into `{{branch}}` and resolve the conflict, then review the result before merging. The factory doesn't rebase or resolve conflicts itself.
