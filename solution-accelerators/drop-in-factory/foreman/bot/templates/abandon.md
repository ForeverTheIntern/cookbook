# Abandoning and closing

A run stopped from Slack (abandon) or on GitHub (closed by hand), and the
question Foreman asks for the post-mortem's reason.

## reason.title
Abandon run {{run}}? Give a one-line reason first.

## reason.issue
{{name}} asked in Slack to abandon this run. Waiting for a one-line reason.

## abandoning.issue
**Abandoning** run `{{run}}`, asked by {{name}} in Slack.

Reason: {{reason}}

## abandoning.slack
Abandoning run *{{run}}*: {{reason}}

## abandoned
abandoned by {{name}}: {{reason}}

## why.slack
{{reason}} ({{name}}, in Slack)

## why.github
{{reason}} ({{name}}, on GitHub)

## closed.pull
pull request #{{pr}} was closed without merging

## closed.issue
issue #{{issue}} was closed{{#by}} by @{{by}}{{/by}}

## closed.someone
someone

## closed.no-reason
{{what}}; no reason was given

## closed.ask.title
The run ended because {{what}}. Why was it stopped?

## closed.ask.body
A one-line reason goes into the post-mortem on the issue.

## closed.ask.issue
The run ended because {{what}}. Foreman asked in Slack for the reason, for the post-mortem.

## postmortem.link
<{{url}}|post-mortem on issue #{{issue}}>
