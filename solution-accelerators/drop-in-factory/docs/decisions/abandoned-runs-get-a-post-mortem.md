# Abandoned runs get a post-mortem

Stopping a run should take one message, not several manual steps on GitHub, and should leave a record of why. The requester or a listed Slack approver says `@foreman abandon: <why>` (or `close`) in either of the run's threads, or reacts with `wastebasket` on the status message. The same code check as Slack approvals decides who may. With no reason, Foreman asks for one line and waits.

Then Foreman posts an **Abandoning** record with the reason on the issue, stops the run's agents, closes the pull request without merging, adds the `abandoned` label, closes the issue as not planned, and moves the run to the `abandoned` end state. Last, it writes a post-mortem on the issue (what was asked, the stages it went through, send-backs, pull request findings, agents and cost, and why it stopped) and a summary in the status thread ([`foreman/bot/lib/pipeline/postmortem.ts`](../../foreman/bot/lib/pipeline/postmortem.ts)).

Closing the issue or pull request by hand on GitHub still ends the run as `closed`. Foreman then asks in the status thread why, and writes the post-mortem from the answer; with no Slack thread, it writes one at once saying no reason was given.

Abandoned work stays history, not open work. Triage sees abandoned issues marked as such, and a repeat Slack request within 30 days gets a link to the abandoned issue and its reason instead of a new issue. Saying what changed in a new message starts a fresh run.
