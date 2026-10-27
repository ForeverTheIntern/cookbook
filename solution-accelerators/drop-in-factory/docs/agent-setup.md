# Agent setup guide

You are a coding agent setting up the Drop-in Software Factory for a person. Follow this page from top to bottom. It gets them to a working local factory, then offers a hosted one. The [tutorial](tutorial.md) has the same steps with screenshots and more troubleshooting; link the person to a section of it when they want to see what a screen looks like.

## How to work

- **Start with the overview below.** Show the person the table, say the total time, and say which steps need them. Then ask whether to begin.
- **Before each step, say three things:** what you are about to do, how long it should take (the step's estimate), and whether you need them for it. Use the step's tag: *agent* means you do it, *person* means only they can, *both* means you guide and they click or paste.
- **Ask one question at a time,** and wait for the answer. Don't batch questions.
- **Run the commands yourself and check the result** against the step's *Check* before you move on. Report the result in a sentence. If a check fails, use the step's fixes, then the tutorial's [common errors](tutorial.md#common-errors-and-fixes).
- **Never ask for a secret in chat, and never print one.** Ask the person to paste each secret into `.env` themselves (or into your environment's secret settings, such as a Cursor cloud agent's **Secrets**), then check it with the command given. If a secret appears in a log or chat, tell them to revoke it.
- **Every command runs the same in bash, zsh and PowerShell** on macOS, Linux and Windows. The `npm run` scripts read `.env` themselves; never `source` it.
- **Keep a short log** of anything that didn't match this page (a different error, a step that took much longer). Offer it to the person at the end; it's how this guide gets fixed.

## Overview

| Step | What it does | Time | Who |
| --- | --- | --- | --- |
| [1. Check the tools](#step-1-check-the-tools) | Node 22.14 or later, git, `gh`, and optionally Docker | 2 min | agent |
| [2. Give the factory its own repository](#step-2-give-the-factory-its-own-repository) | A new repository holding this folder, cloned locally | 5 min | both |
| [3. Install and run the offline tests](#step-3-install-and-run-the-offline-tests) | Packages for the factory, Foreman and the dashboard | 3 min | agent |
| [4. Cursor API key with GitHub access](#step-4-cursor-api-key-with-github-access) | The key that launches the step agents, from an account that can see the repositories | 5 min | person |
| [5. Choose Foreman's GitHub identity](#step-5-choose-foremans-github-identity) | Who Foreman's own comments post as: a GitHub App, a bot user, or the person | 5 to 10 min | both |
| [6. GitHub token](#step-6-github-token) | `GH_TOKEN`, for reading the issue timeline and relaying Slack answers | 3 min | person |
| [7. Slack app (optional)](#step-7-slack-app-optional) | Foreman's Slack bot, its two tokens, and the factory channel | 10 min | both |
| [8. factory.yaml](#step-8-factoryyaml) | Repositories, approvers, Slack channel and approvers, identity | 5 min | both |
| [9. Metrics collector](#step-9-metrics-collector) | The OTel collector the doctor expects | 2 min | agent |
| [10. Doctor](#step-10-doctor) | Checks every account, token, scope and service; creates the labels | 2 min | agent |
| [11. Start the factory and send a test request](#step-11-start-the-factory-and-send-a-test-request) | `npm run dev`, then one Slack request that opens an issue | 5 min | both |
| [12. Offer a hosted deploy](#step-12-offer-a-hosted-deploy) | Foreman as a Cursor-hosted deployment | 15 to 20 min | both |

Steps 1 to 11 take about 45 to 60 minutes, most of it the person creating keys and apps. The goal of steps 1 to 11 is a working local factory: the doctor passes, `npm run dev` is running, and one Slack request has opened an issue. Step 12 is optional; offer it, with its time, once step 11 works.

Before you start, ask the person for, one at a time:

1. The GitHub repositories the factory should work on (`owner/name`, all under one owner).
2. Whether they want Slack. Without it, skip step 7 and start runs with the `factory:run` label.

## Step 1: Check the tools

*2 min · agent*

Say: "I'll check that the tools the factory needs are installed. This takes a couple of minutes and needs nothing from you."

```bash
node --version        # v22.14.0 or later
npm --version
git --version
gh --version
docker --version      # optional, for the metrics collector
```

**Check.** Node prints `v22.14.0` or later (any newer version works). `gh` is present. Docker is optional; without it, step 9 uses the collector binary.

**Fixes.** An older Node: install 22.14 or later with `nvm install 22.14` (or `fnm`, `volta`, or the installer from nodejs.org). Don't use Bun. No `gh`: install it from <https://cli.github.com>; Foreman uses it only for the issue timeline.

## Step 2: Give the factory its own repository

*5 min · both*

Say: "The factory lives in its own repository and works on the ones you listed. I need you to create an empty private repository on GitHub (or tell me which one to use). About five minutes."

1. Ask the person to create an empty private repository, for example `your-org/factory`, under an owner whose Cursor GitHub App installation can read it (needed for a hosted deploy later).
2. Clone it, and copy this folder's contents (everything next to this `docs/` folder) to its root.
3. Commit and push:

```bash
git add -A
git commit -m "Drop-in Software Factory"
git push -u origin main
```

**Check.** `git status` is clean and `git log -1` shows the commit. `.env` doesn't exist yet, and `.gitignore` lists it.

The factory can also sit in a folder of one of the repositories it serves. Only suggest that if the person asks; a separate repository keeps factory changes out of product history.

## Step 3: Install and run the offline tests

*3 min · agent*

Say: "I'll install the packages and run the offline tests. Three minutes, nothing needed from you."

```bash
npm install
npm run install:all
node -e "require('fs').rmSync('.dev', { recursive: true, force: true })"
npm test
```

**Check.** Each install ends with `added N packages` and no `ERR!`. `npm test` ends with `# fail 0`.

## Step 4: Cursor API key with GitHub access

*5 min · person*

Say: "Next, the Cursor API key that launches the factory's agents. Only you can create it, and the account it belongs to must be able to see your repositories. About five minutes."

Ask the person to:

1. Sign in to [cursor.com](https://cursor.com) as the account Foreman will launch agents as (their own, or a service account on the team).
2. Open [cursor.com/dashboard](https://cursor.com/dashboard) → **Integrations** → **GitHub** → **Connect**, and grant access to every repository from the start.
3. On the same page, create an API key and paste it into `.env` as `CURSOR_API_KEY`.

Create `.env` for them first:

```bash
cp .env.example .env
```

On macOS and Linux, also `chmod 600 .env`. Then fill in the dashboard's signing secret, which nobody needs to see:

```bash
node -e "const fs=require('fs');fs.writeFileSync('.env',fs.readFileSync('.env','utf8').replace(/^SA_PORTAL_INGEST_SECRET=$/m,'SA_PORTAL_INGEST_SECRET='+require('crypto').randomBytes(32).toString('hex')))"
```

Without it the dashboard still runs, but the doctor's dashboard line fails because it can't probe it.

Then check, without printing the key:

```bash
node -e "process.loadEnvFile('.env'); fetch('https://api.cursor.com/v0/repositories',{headers:{authorization:'Basic '+Buffer.from(process.env.CURSOR_API_KEY+':').toString('base64')}}).then(r=>r.json()).then(j=>console.log((j.repositories||[]).map(r=>r.owner+'/'+r.name).join('\n')||JSON.stringify(j)))"
```

**Check.** Every repository from the start is listed. An empty list means the key's account hasn't connected GitHub or can't see them: the first agent launch would fail with `Failed to verify existence of branch`. Have the person redo 1 and 2 as the key's account. Optional: a Team Admin API key in `CURSOR_ADMIN_API_KEY` turns on invoice cost in the dashboard.

## Step 5: Choose Foreman's GitHub identity

*5 to 10 min · both*

Say: "Foreman posts comments, reviews and labels on GitHub. You can choose who those show as. I'll explain the three options; tell me which you want. Five to ten minutes, depending on the choice."

Explain the trade-offs, then ask which one:

| Choice | Posts show as | Needs | Trade-off |
| --- | --- | --- | --- |
| **GitHub App** (recommended) | `<app-name>[bot]` | Owner rights on the GitHub organization (or the personal account) to create and install an app | No extra seat; permissions scoped to the repositories it's installed on |
| **Bot user** | That user | A second GitHub account with write access, and its own seat | Looks like a teammate; one more account to manage |
| **Personal** | The person setting this up | Nothing more | Simplest; a run looks like them talking to themselves |

Whatever they pick, an answer someone gives in Slack is relayed to the issue with `GH_TOKEN` (step 6), so it shows as that token's account, not the bot.

**GitHub App.** Run:

```bash
npm run github-app
```

It prints a local address. Ask the person to open it in a browser signed in to GitHub as an owner of the organization, click **Continue to GitHub**, check the app name, and click **Create GitHub App**. GitHub sends the browser back to the script, which writes `SA_GH_APP_ID` and `SA_GH_APP_PRIVATE_KEY` into `.env`, then opens the app's install page. Ask them to install it on the factory's repositories. The app asks for no webhook (Foreman gets events through Cursor) and only contents, issues and pull requests write, with checks and metadata read. Use `--owner` when the repositories' owner isn't the first one in `factory.yaml`, and `--name` to pick the name.

If their browser can't reach the machine you run on (you're a cloud agent, or on a remote shell), run `npm run github-app -- --page github-app.html` instead and give them that file. They open it in their own browser and create the app the same way. GitHub then sends the browser to a `127.0.0.1` address that fails to load; that's expected. Ask them to paste that whole address to you (the code in it works once, within an hour, and isn't the key), then run `npm run github-app -- --code '<the address>'`, which writes the two secrets into `.env`. Send them the install page it prints, and delete `github-app.html`.

Or they can create it by hand: **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**, with the webhook unchecked and those five permissions, then **Generate a private key**, install it on the repositories, and paste the app id and the key (as one line, with `\n` for the line breaks) into `.env`.

**Bot user.** Ask the person to create a fine-grained token on the bot account with **Contents**, **Issues** and **Pull requests** *Read and write* on the repositories, and paste it into `.env` as `SA_GH_BOT_TOKEN`.

**Personal.** Nothing to do.

You will write the choice into `factory.yaml` in step 8 (`github.identity: app`, `bot-user` or `personal`). **Check:** the doctor's `factory identity` line in step 10.

## Step 6: GitHub token

*3 min · person*

Say: "Foreman also needs a GitHub token of yours, for reading who added a label and relaying Slack answers. Three minutes."

Ask the person to create a fine-grained token at github.com → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**, limited to the factory's repositories, with **Contents**, **Issues** and **Pull requests** *Read and write* (and organization **Members** *Read* if an approver will be a `team:org/slug`). They paste it into `.env` as `GH_TOKEN`.

**Check.**

```bash
node -e "process.loadEnvFile('.env'); fetch('https://api.github.com/user',{headers:{authorization:'Bearer '+process.env.GH_TOKEN}}).then(r=>r.json()).then(j=>console.log(j.login||JSON.stringify(j)))"
```

It prints their login.

## Step 7: Slack app (optional)

*10 min · both*

Say: "Now Foreman's Slack app. You'll create it from a file in this folder and copy two tokens. About ten minutes."

Walk the person through, one click at a time ([tutorial Step 4](tutorial.md#step-4-the-slack-app) has the screens):

1. [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From an app manifest** → their workspace → **JSON** tab. Paste the contents of [`foreman/.slack/manifest.prod.json`](../foreman/.slack/manifest.prod.json) → **Create**. The manifest sets every scope Foreman uses, including `files:write` (the walkthrough video plays in the thread) and `reactions:read` with the `reaction_added` event (approve and abandon by reaction).
2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**, scope `connections:write`. Paste the `xapp-…` token into `.env` as `FOREMAN_SLACK_APP_TOKEN`.
3. **Install App** → **Install to Workspace** → **Allow**. Paste the `xoxb-…` token into `.env` as `FOREMAN_SLACK_BOT_TOKEN`.
4. Create a channel such as `#factory` and `/invite @Foreman` in it.
5. Ask for the channel id (channel name → **About** → bottom), and for the Slack member ids of anyone besides the requester who should be able to approve or abandon any run (profile → **⋮** → **Copy member ID**). Those go in `slack.approvers` in step 8.

**Check.** The doctor's Slack line in step 10 says the bot is in the channel and that the token has `chat:write, files:write, reactions:read, users:read`.

## Step 8: factory.yaml

*5 min · both*

Say: "I'll write the factory's settings from your answers. I need the GitHub logins of the people who approve specs and plans. Five minutes."

Ask for the approvers' GitHub logins (or a `team:org/slug`). Then edit [`factory.yaml`](../factory.yaml):

```yaml
repo: your-org/your-repo            # or a repos: list; see the comment in the file
base: main
intakeLabel: factory:run
gates:
  spec: { approvers: [their-login], ... }
  plan: { approvers: [their-login], ... }
github:
  identity: app                     # app, bot-user or personal, from step 5
review:
  bots: [cursor]                    # Bugbot and the security reviewer post as cursor[bot]
slack:
  channel: C0123456789              # from step 7, or delete the slack block
  approvers: [U0123456789]          # optional: Slack member ids from step 7
```

Keep the other keys as shipped. For several repositories, use a `repos:` list with a one-sentence `description` each, so Slack requests find the right one.

**Check.** The doctor's first line in step 10 is `ok    environment and factory.yaml`.

## Step 9: Metrics collector

*2 min · agent*

Say: "I'll start the local metrics collector the doctor expects. Two minutes, nothing needed from you."

```bash
docker compose -f setup/compose.yaml up -d collector
```

Without Docker, download `otelcol-contrib` 0.163.2 for the platform from the [collector releases](https://github.com/open-telemetry/opentelemetry-collector-releases/releases) and run `otelcol-contrib --config setup/collector.yaml` in its own terminal.

**Check.** The doctor's `OTel collector` line in step 10 is `ok`.

## Step 10: Doctor

*2 min · agent*

Say: "I'll run the doctor, which checks every key, scope and service and creates the factory's labels. Two minutes."

```bash
npm run doctor
```

**Check.** Every line is `ok`, `info` or `note`. The lines that most often fail, and their fixes:

| Line | Fix |
| --- | --- |
| `GitHub App: … cannot see …` | Step 4: the key's account needs GitHub access to that repository. |
| `factory identity: … must be set` | The secrets for the identity chosen in step 5 aren't in `.env`. |
| `factory identity: the app's installation … lacks …` | The app isn't installed on that repository, or is missing a permission. Install it, or accept the new permissions on the installation. |
| `Slack …: the bot token lacks files:write, reactions:read` | The app predates those scopes. Re-paste the manifest under **App Manifest**, reinstall, and update `FOREMAN_SLACK_BOT_TOKEN`. |
| `review bots: no GitHub bot account …` | A name in `review.bots` is wrong. Use the login without `[bot]`. |
| `dashboard: on, but …` | Start `npm run dev` (step 11) first, then run the doctor again. |

The dashboard line passes only while `npm run dev` runs; it's fine to come back to it after step 11.

## Step 11: Start the factory and send a test request

*5 min · both*

Say: "I'll start the factory and leave it running. Then I need you to post one request in Slack. About five minutes, plus a couple of minutes for Foreman to answer."

Start it in a session that outlives your shell (tmux, a background terminal):

```bash
npm run dev
```

**Check.** Within 30 seconds the output has `foreman listening` and, with Slack, `Socket Mode connected`. <http://127.0.0.1:8787> answers.

Ask the person to post, at the top level of the factory channel (not in a thread): `@Foreman add docs/support.md that says where to report bugs`.

**Check.** Within a minute:

- Foreman replies "Working on it." under the request, then posts the run's status message in the channel and replies under the request with links to the new issue and the status thread.
- The issue exists on GitHub with the `factory:run` label, and its comments show as the identity from step 5.
- The status thread gets "triage agent started", with a link to open the agent's session in Cursor.

Without Slack, ask the person to add the `factory:run` label to a small issue instead.

That's a working local factory. Tell the person what happens next in the run (PM may ask questions in the status thread; they approve the spec and plan with `@foreman approve` there or on the issue; Foreman watches the pull request until it merges), and that they can stop the test run with `@foreman abandon: test` in the status thread. Run `npm run doctor` once more for the dashboard line.

## Step 12: Offer a hosted deploy

*15 to 20 min · both*

Ask: "Your factory works locally. Do you want me to deploy it on Cursor hosting, so it runs without your machine? It takes 15 to 20 minutes, and you'll need to finish one Slack link in a browser. Or we can stop here."

If they say yes, follow [Go hosted](reference.md#go-hosted) in the reference, explaining each command before you run it:

1. Commit `factory.yaml` and push. Never commit `.env`.
2. `npm run deploy`.
3. From `foreman`, `secret set` each secret on the `foreman` deployment, piping each value from the environment so nothing is printed: `SA_GH_TOKEN`, `SA_CURSOR_API_KEY`, `SA_CURSOR_ADMIN_API_KEY` if they have one, and the identity's (`SA_GH_APP_ID` and `SA_GH_APP_PRIVATE_KEY`, or `SA_GH_BOT_TOKEN`).
4. With Slack, `slack create --dir . --env prod`. It prints a `slack-setup` link the person must open, signed in to Cursor as the account behind `CURSOR_API_KEY`. Hosted Slack is a separate bot: they invite it to the channel too.
5. Give the local Foreman its own intake label (a git-ignored `factory.local.yaml` with `intakeLabel: factory:run-dev-<name>`) or stop it, so the two don't both claim issues.
6. `npm run doctor -- --hosted`.

**Check.** The hosted lines are `ok`: the running release is the recorded one, built from HEAD, and the deployment has its secrets. One more top-level Slack request to the hosted bot opens an issue the same way as in step 11.

## When you're done

Summarize for the person: what is running where, the channel and label to use, who can approve, and how to stop it (`npm run stop`, `docker compose -f setup/compose.yaml down`, and for hosted `npx --yes @grok/agent-sdk@0.3.0 deployment delete foreman`, which runs the Agent SDK's `agent-sdk` CLI, also installed as `bdk`). Offer the log of anything that didn't match this guide.
