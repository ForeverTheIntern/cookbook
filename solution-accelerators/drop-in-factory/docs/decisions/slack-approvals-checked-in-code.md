# Slack approvals, checked in code

People want to approve where they already are, so a gate can also be decided in the run's Slack status thread: `@foreman approve`, `@foreman changes: <what>`, or the approve or reject reaction (`white_check_mark` and `x` by default, `slack.reactions` in `factory.yaml`) on the approval message.

Code, not Foreman's model, decides whether a Slack vote counts ([`maySteer`](../../foreman/bot/lib/pipeline/reconcile.ts)). It counts only from the person who asked for the run in Slack, or a Slack user id listed in `slack.approvers`. Anyone else gets one reply naming who can. The vote is recorded on the issue as "Approved by @person via Slack reply" (or "via Slack reaction"), with the Slack user id, the message timestamp and the reaction, so the issue stays the record.

The model stays out of the decision: the command is parsed before the model sees the message, the model is told it never approves, and Foreman's own posts carry no commands. Slack users are not mapped to GitHub logins; the two lists are separate on purpose, because a requester in Slack often has no GitHub seat.

GitHub gates work the same way: approvers' comments and labels, only after the gate opened, only on the head it opened on. A Slack vote follows the same timing rules. Whichever valid vote comes first decides.

Reaction events trigger a reconcile, which then reads the reactions on the approval and status messages with `reactions.get`. The tick does the same for every run with a status message, so a missed `reaction_added` event (for example, on hosted Slack) changes nothing.

The same check covers abandoning a run from Slack ([Abandoned runs get a post-mortem](abandoned-runs-get-a-post-mortem.md)).
