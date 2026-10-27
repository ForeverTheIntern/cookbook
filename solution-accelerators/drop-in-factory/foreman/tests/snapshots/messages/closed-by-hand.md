# Slack posts

## 1.0001 in C0FACTORY

````
<https://github.com/acme/app/issues/1|gh #1> Add an audit log · 🔄 *starting*
````

````
[
 {
  "type": "header",
  "text": {
   "type": "plain_text",
   "text": "Add an audit log (acme/app)",
   "emoji": true
  }
 },
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "🔄 *starting*"
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://github.com/acme/app/issues/1|gh #1>  ·  run `f-gh-1`"
   }
  ]
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": ":speech_balloon: Reply here and mention @foreman, for example `@foreman approve` at a gate, or `@foreman abandon: <why>` to stop the run. React :wastebasket: here to abandon."
   }
  ]
 }
]
````

## 2.0001 in C0FACTORY thread 400.1

````
Opened <https://github.com/acme/app/issues/1|gh #1 Add an audit log> as run *f-gh-1*. Questions, approvals and results go to <https://slack.com/archives/C0FACTORY/p10001|its status thread>: reply there and mention @foreman. I still answer here.
````

## 3.0001 in C0FACTORY thread 1.0001

````
*triage* · Triage is checking for duplicates and related work. branch factory/f-gh-1
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "*triage* · Triage is checking for duplicates and related work. branch factory/f-gh-1"
  }
 }
]
````

## 4.0001 in C0FACTORY thread 1.0001

````
*triage* agent started: <https://cursor.com/agents/bc-2|open the session in Cursor>
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": ":robot_face: *triage* agent started"
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://cursor.com/agents/bc-2|open the session in Cursor>  ·  <https://github.com/acme/app/issues/1|issue #1>"
   }
  ]
 }
]
````

## 5.0001 in C0FACTORY thread 1.0001

````
*spec* · PM is writing the spec. no duplicates, 0 related
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "*spec* · PM is writing the spec. no duplicates, 0 related"
  }
 }
]
````

## 6.0001 in C0FACTORY thread 1.0001

````
*spec* agent started: <https://cursor.com/agents/bc-5|open the session in Cursor>
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": ":robot_face: *spec* agent started"
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://cursor.com/agents/bc-5|open the session in Cursor>  ·  <https://github.com/acme/app/issues/1|issue #1>"
   }
  ]
 }
]
````

## 7.0001 in C0FACTORY thread 1.0001

````
*awaiting_spec_approval* · Spec gate open. spec score 100
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "*awaiting_spec_approval* · Spec gate open. spec score 100"
  }
 }
]
````

## 8.0001 in C0FACTORY thread 1.0001

````
<@U2> Spec gate: please approve or ask for changes
<https://github.com/acme/app/blob/c6/specs/f-gh-1.md|specs/f-gh-1.md> is ready at `c6`.
Reply here and mention @foreman, for example `@foreman approve` or `@foreman changes: <what to change>`. Or react :white_check_mark: to approve, :x: to ask for changes.
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": ":ballot_box_with_check: <@U2> *Spec gate: please approve or ask for changes*"
  }
 },
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "<https://github.com/acme/app/blob/c6/specs/f-gh-1.md|specs/f-gh-1.md> is ready at `c6`."
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://github.com/acme/app/issues/1|issue #1>  ·  <https://github.com/acme/app/pull/2|PR #2>"
   }
  ]
 },
 {
  "type": "divider"
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": ":speech_balloon: Reply here and mention @foreman, for example `@foreman approve` or `@foreman changes: <what to change>`. Or react :white_check_mark: to approve, :x: to ask for changes."
   }
  ]
 }
]
````

## 9.0001 in C0FACTORY thread 1.0001

````
*closed* · Run closed. pull request #2 was closed without merging
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "*closed* · Run closed. pull request #2 was closed without merging"
  }
 }
]
````

## 10.0001 in C0FACTORY thread 1.0001

````
<@U2> The run ended because pull request #2 was closed without merging. Why was it stopped?
A one-line reason goes into the post-mortem on the issue.
Reply here and mention @foreman, for example `@foreman abandon: no longer needed`.
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": ":memo: <@U2> *The run ended because pull request #2 was closed without merging. Why was it stopped?*"
  }
 },
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "A one-line reason goes into the post-mortem on the issue."
  }
 },
 {
  "type": "divider"
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": ":speech_balloon: Reply here and mention @foreman, for example `@foreman abandon: no longer needed`."
   }
  ]
 }
]
````

## 11.0001 in C0FACTORY thread 1.0001

````
*Post-mortem* · got as far as *awaiting_spec_approval* · 0 send-backs · 0 PR findings · 2 agents
*Why:* we bought a vendor tool instead (someone, on GitHub)
````

````
[
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "*Post-mortem* · got as far as *awaiting_spec_approval* · 0 send-backs · 0 PR findings · 2 agents\n*Why:* we bought a vendor tool instead (someone, on GitHub)"
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://github.com/acme/app/issues/1|post-mortem on issue #1>"
   }
  ]
 }
]
````

# Slack edits

## edit of 1.0001

````
<https://github.com/acme/app/issues/1|gh #1> Add an audit log · 🔄 *spec* · PM is writing the spec · <https://cursor.com/agents/bc-5|spec agent (open in Cursor)>
````

````
[
 {
  "type": "header",
  "text": {
   "type": "plain_text",
   "text": "Add an audit log (acme/app)",
   "emoji": true
  }
 },
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "🔄 *spec* · PM is writing the spec"
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://github.com/acme/app/issues/1|gh #1>  ·  run `f-gh-1`  ·  <https://cursor.com/agents/bc-5|spec agent (open in Cursor)>"
   }
  ]
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": ":speech_balloon: Reply here and mention @foreman, for example `@foreman approve` at a gate, or `@foreman abandon: <why>` to stop the run. React :wastebasket: here to abandon."
   }
  ]
 }
]
````

## edit of 1.0001

````
<https://github.com/acme/app/issues/1|gh #1> Add an audit log · ⏳ *spec gate* · waiting on spec approval, in this thread or on GitHub · <https://github.com/acme/app/pull/2|PR #2>
````

````
[
 {
  "type": "header",
  "text": {
   "type": "plain_text",
   "text": "Add an audit log (acme/app)",
   "emoji": true
  }
 },
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "⏳ *spec gate* · waiting on spec approval, in this thread or on GitHub"
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://github.com/acme/app/issues/1|gh #1>  ·  run `f-gh-1`  ·  <https://github.com/acme/app/pull/2|PR #2>"
   }
  ]
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": ":speech_balloon: Reply here and mention @foreman, for example `@foreman approve` at a gate, or `@foreman abandon: <why>` to stop the run. React :wastebasket: here to abandon."
   }
  ]
 }
]
````

## edit of 1.0001

````
<https://github.com/acme/app/issues/1|gh #1> Add an audit log · ⚪ *closed* · pull request #2 was closed without merging · <https://github.com/acme/app/pull/2|PR #2>
````

````
[
 {
  "type": "header",
  "text": {
   "type": "plain_text",
   "text": "Add an audit log (acme/app)",
   "emoji": true
  }
 },
 {
  "type": "section",
  "text": {
   "type": "mrkdwn",
   "text": "⚪ *closed* · pull request #2 was closed without merging"
  }
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": "<https://github.com/acme/app/issues/1|gh #1>  ·  run `f-gh-1`  ·  <https://github.com/acme/app/pull/2|PR #2>"
   }
  ]
 },
 {
  "type": "context",
  "elements": [
   {
    "type": "mrkdwn",
    "text": ":speech_balloon: Reply here and mention @foreman, for example `@foreman approve` at a gate, or `@foreman abandon: <why>` to stop the run. React :wastebasket: here to abandon."
   }
  ]
 }
]
````

# Slack uploads

# GitHub

## issue #1 Add an audit log (open)

### factory-bot comment 1

````
<!-- factory:claim id=<factory-id> run=f-gh-1 -->
Run `f-gh-1` started by this factory (Foreman `<factory-id>`).
````

### factory-bot comment 3

````
<!-- factory:status -->
**Factory status** for run `f-gh-1`: **closed** · Run closed
Pull request: #2
Running agent sessions: none
Slack status thread: https://slack.com/archives/C0FACTORY/p10001
````

### factory-bot comment 7

````
<!-- factory:gate:4 -->
**Spec gate.** [specs/f-gh-1.md](https://github.com/acme/app/blob/c6/specs/f-gh-1.md) is ready at c6. An approver (alice) responds here or on #2, or the requester or a listed approver responds in the Slack status thread.

_To respond, comment `approve` or `changes: <what to change>`, or add the `factory:spec-approved` or `factory:spec-changes` label._
````

### factory-bot comment 8

````
<!-- factory:closed-reason -->
The run ended because pull request #2 was closed without merging. Foreman asked in Slack for the reason, for the post-mortem.

_To respond, comment with the reason in one line._
````

### factory-bot comment 9

````
<!-- factory:postmortem -->
**Post-mortem: run `f-gh-1`**

- **Asked:** Add an audit log
- **How far it got:** awaiting_spec_approval, after 4 stage changes (intake → triage → spec → awaiting_spec_approval → closed)
- **Send-backs to Implement:** 0
- **Pull request findings sent back:** 0
- **Agents:** [triage](https://cursor.com/agents/bc-2), [spec](https://cursor.com/agents/bc-5)
- **Why it stopped:** we bought a vendor tool instead (someone, on GitHub)
````

## pull #2 (closed, draft)
