# Automations

Four recurring jobs keep the tracker current and the sources honest. Each one is written two ways:

- **As a Project subscription.** Ask the coordinator in chat, and it creates the subscription. The Project can then watch a Slack channel, run on a schedule, or follow pull requests ([S-40](sources.md)).
- **As a standalone Automation.** Use cursor.com/automations or the `/automate` skill, with a trigger, a prompt and tools such as Send to Slack ([S-41](sources.md)). Use this if you'd rather manage it outside the Project.

Every job follows the plugin's rules: no production access, PRs only, evidence for `Done`, and nothing sent without the program owner's opt-in.

## 1. Daily status

**Subscription.** Ask the coordinator:

```text
Every weekday at {{time}}, run /pg-status: update tracker statuses from linked PRs and sessions, render the dashboard, and post the daily summary to {{#channel}}. Include blocked rows with reasons, rows in Needs approval for 2+ days grouped by owner, overdue rows, new findings, and questions waiting on the customer or provider.
```

**Automation.**
- **Trigger:** schedule, every weekday at `{{time}}`.
- **Repository:** the Project's workspace repo.
- **Tools:** Send to Slack.
- **Prompt:** the text above, plus: "Use the pg-upgrade-tracker skill. If upgrade/tracker.csv fails tracker-check, post the errors instead of a summary."

## 2. On PR merge

**Subscription.** Ask the coordinator:

```text
When a pull request linked in the tracker merges, update that row with the pg-upgrade-tracker skill: set it to Needs approval (or Done if its Done when is only "PR merged"), link the merge as Evidence, and re-render the dashboard. Never close a gate from this.
```

**Automation.**
- **Trigger:** pull request merged, on each repo in the tracker's Consumer rows.
- **Prompt:** the text above.

## 3. Gate check on demand

**Subscription.** Ask the coordinator:

```text
When someone posts "gate check <gate or block>" in {{#channel}}, run /pg-gate on it and reply in the thread with the verdict table. Don't change any gate to Done.
```

**Automation.**
- **Trigger:** Slack message in `{{#channel}}`. Public channels only.
- **Tools:** Send to Slack.
- **Prompt:** the text above.

## 4. Weekly source recheck

This job keeps every `[S-nn]` citation current. Provider docs and release notes change, and a claim is only as good as the date it was last checked.

**Subscription.** Ask the coordinator:

```text
Every Monday, run node <plugin>/scripts/check-sources.mjs. If any source is "changed" or "unreachable", open a draft PR that updates reference/sources.json (quotes and dates) and lists every SOP line that cites the affected sources, so a person can recheck them. Don't edit the SOP's claims yourself.
```

**Automation.**
- **Trigger:** schedule, weekly.
- **Repository:** wherever the template lives.
- **Prompt:** the text above. The script exits 1 when a quote is missing, which is the signal to open the PR.

## Guardrails for every job

- These jobs run unattended, so they must not send customer messages, close gates, or merge anything.
- Slack posts are status summaries only, never row data or query text.
- If an MCP server or Slack is unavailable, the job writes its output to `upgrade/` and reports the failure the next time someone looks.
