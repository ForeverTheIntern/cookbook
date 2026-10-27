# Post-mortem

Written on the issue, and summed up in the status thread, when a run stops
without merging. `{{cost}}` is "" when no invoice figure has been read yet.

## issue
**Post-mortem: run `{{run}}`**

- **Asked:** {{asked}}{{#request}} — {{request}}{{/request}}
- **How far it got:** {{reached}}, after {{changes}} stage changes ({{path}})
- **Send-backs to {{to}}:** {{sendBacks}}{{#reasons}} ({{reasons}}){{/reasons}}
- **Pull request findings sent back:** {{findings}}
- **Agents:** {{#agents}}{{agents}}{{/agents}}{{^agents}}none{{/agents}}{{#cost}}, ${{cost}} {{costState}}{{/cost}}
- **Why it stopped:** {{why}}

## slack
*Post-mortem* · got as far as *{{reached}}* · {{sendBacks}} · {{findings}} · {{agents}}{{#cost}}, ${{cost}} {{costState}}{{/cost}}
*Why:* {{why}}

## slack.send-backs.one
{{n}} send-back

## slack.send-backs.many
{{n}} send-backs

## slack.findings.one
{{n}} PR finding

## slack.findings.many
{{n}} PR findings

## slack.agents.one
{{n}} agent

## slack.agents.many
{{n}} agents
