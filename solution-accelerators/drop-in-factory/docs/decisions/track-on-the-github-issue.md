# Track the run on its GitHub issue

The factory tracks a run on the GitHub issue that starts it. It does not use a GitHub Projects board, Linear or Jira.

The `factory:run` label (or a Slack mention, which opens the issue) starts the run. Questions, gate notices, holds and the duplicate note are comments on the issue. Review and Verify findings are pull request reviews. The stage lives in the store and is shown on the portal and in the Slack thread.
