# Foreman's own GitHub identity is a choice

If Foreman's own comments, reviews, labels and branches on GitHub post as whoever owns `GH_TOKEN`, a run looks like that person talking to themselves. `github.identity` in `factory.yaml` picks who they post as:

- **`app` (recommended).** A GitHub App the customer creates for the factory. Posts show as `<app-name>[bot]`. No extra seat, and permissions are scoped to the repositories it is installed on: contents, issues and pull requests write, checks and metadata read. Foreman signs an RS256 JWT with the app's private key and buys an installation token per repository owner, cached until five minutes before it expires ([`foreman/bot/lib/github/app.ts`](../../foreman/bot/lib/github/app.ts)).
- **`bot-user`.** A second GitHub account's token (`SA_GH_BOT_TOKEN`). Posts show as that user. It needs its own seat and login.
- **`personal`.** Posts as the owner of `GH_TOKEN`. The default, because it needs no extra setup.

`GH_TOKEN` stays the operator's token in every mode. It reads the issue timeline through `gh` and relays an answer a person gave in Slack, so that comment shows as a person (the operator's account) and not the bot. Slack users are not mapped to GitHub accounts; the relayed comment says it came from Slack.

The doctor checks that the chosen identity's secrets are set, resolves the login it posts as, and confirms it can write to each repository; for an app it lists any permission the installation lacks.
