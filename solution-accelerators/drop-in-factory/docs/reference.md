# Reference

The settings, commands and behavior behind the [README](../README.md)'s quickstart. The [tutorial](tutorial.md) walks through the same ground step by step, with the expected output.

## Copy the folder out

Put this folder at the root of a new repository of its own (recommended), or in a folder of one of the repositories it serves. Either works: `repo` or `repos` in `factory.yaml` names what the factory works on, and nothing assumes the factory sits inside that repository.

This folder is `solution-accelerators/drop-in-factory` in [cursor/cookbook](https://github.com/cursor/cookbook):

```bash
git clone --depth 1 https://github.com/cursor/cookbook.git
cp -R cookbook/solution-accelerators/drop-in-factory my-factory
cd my-factory
npm install
npm run install:all                   # Foreman's and the dashboard's packages
```

Committing the copy is optional for a local Foreman, which reads the folder from the disk it runs on; the step agents don't need it. A hosted Foreman is built from a pushed branch, so commit it and push it to a repository your team's Cursor GitHub App can read. `.env`, `data/`, `dashboard/.data/` and `*.local.yaml` are git-ignored.

Your verdict ledger and deploy records go in `setup/verdicts/`, which `npm run verdict` and `npm run deploy` create.

If your secrets are already environment variables (a Cursor cloud agent's Secrets, a CI runner), leave their lines in `.env` empty. A variable that is already set wins over `.env` ([tutorial Step 3](tutorial.md#step-3-secrets-and-where-to-save-them)).

## Configure

Edit [`factory.yaml`](../factory.yaml): set `repo`, the approvers on each gate in `steps:`, and the Slack channel id (or delete the `slack` block). Each step's model is in its `foreman/bot/subagents/<step>/agent.ts`; [docs/customize.md](customize.md) covers that and the other changes. An unknown key, or a missing required one, stops Foreman with that key's name.

**Foreman's GitHub identity.** `github.identity` picks who Foreman's own comments, reviews and labels post as:

| `identity` | Posts show as | You need | Trade-off |
| --- | --- | --- | --- |
| `app` (recommended) | `<app-name>[bot]` | A GitHub App with contents, issues and pull requests write and checks read, installed on the repositories; `SA_GH_APP_ID` and `SA_GH_APP_PRIVATE_KEY` | No extra seat; scoped to the repositories it's installed on. A few clicks to create ([agent setup, GitHub identity](agent-setup.md#step-5-choose-foremans-github-identity)). |
| `bot-user` | That user | A second GitHub account with write access, and its token in `SA_GH_BOT_TOKEN` | Needs its own seat and login. |
| `personal` (default) | The owner of `GH_TOKEN` | Nothing more | A run looks like you talking to yourself. |

An answer a person gives in Slack is relayed to the issue with `GH_TOKEN`, so it shows as the operator's account rather than the bot, whichever identity you pick. Slack users aren't mapped to GitHub accounts.

**Slack approvers and reactions.** In Slack, the person who asked for a run can approve its gates, ask for changes and abandon it. `slack.approvers` adds Slack user ids that can do the same for every run (for runs started from a label, they are the only ones). `slack.reactions` renames the approve, reject and abandon reactions (default `white_check_mark`, `x` and `wastebasket`).

**Review bots.** `review.bots` names the bots whose pull request findings send work back (default `[cursor]`, which is how Bugbot and Cursor's security reviewer post). See [Working with Bugbot and the security reviewer](#working-with-bugbot-and-the-security-reviewer).

**Several repositories.** One Foreman serves up to 20 repositories under one GitHub owner. Replace `repo` and `base` with a `repos` list, as the comment in `factory.yaml` shows:

```yaml
repos:
  - { repo: your-org/agents, base: main, description: "Agent prototypes and small games" }
  - { repo: your-org/garden, base: main, description: "Garden planner: plants, beds and a watering schedule" }
slack:
  channel: C0123456789                     # shared by both
```

- Run ids carry the repository key (`f-garden-12`). `key` defaults to the repository's name.
- A repository can set its own `intakeLabel`, gates and Slack channel.
- `description` is optional: one sentence on what the repository holds, in the words people use when they ask for things. It matters only in a Slack channel several repositories share.
- In a shared channel, a request can name its repository first (`garden: add a CONTRIBUTING file`) or say `in garden`. Without a name, Foreman matches the request's words against each repository's key, name and `description`; "add a watering reminder" goes to `garden`. When that doesn't settle it, Foreman's model picks from the descriptions, and asks only when the request could be for either. The doctor's Slack line names the repositories that share a channel.
- `limits` caps how many runs are past intake at once, per repository and in all. A labeled issue over a limit waits at intake, says so on the issue, and starts oldest first when a run finishes.
- Each issue is claimed with a hidden comment. A second factory, or a replayed label on a closed issue, starts no run.
- Two runs can still touch the same files. The second pull request then shows a conflict with `base`, and its status line says "waiting on a conflict fix". The factory doesn't rebase or resolve conflicts.

**Dashboard.** `dashboard` turns the dashboard on or off. It is optional and on by default, because `npm run dev` starts the dashboard next to Foreman.

```yaml
dashboard:
  enabled: true                            # false: Foreman pushes nothing and npm run dev doesn't start dashboard/
  url: https://factory.internal.example    # optional; otherwise SA_PORTAL_URL, which npm run dev sets
```

| Setting | What happens |
| --- | --- |
| `enabled: false` | Foreman sends nothing, retries nothing and logs nothing about the dashboard. `npm run dev` starts only Foreman. The doctor prints `info  dashboard: off`. |
| `enabled: true`, URL and secret set | Foreman signs and pushes every run change and a heartbeat every minute. The doctor checks that the URL answers and accepts the secret. |
| `enabled: true`, no URL or no `SA_PORTAL_INGEST_SECRET` | One warning when Foreman starts, naming what is missing, then nothing is sent. Runs are not affected. The doctor fails the dashboard line with the same message. |
| Dashboard down or rejecting pushes | Runs are not affected: a failed push never stops a reconcile or the tick. Foreman logs it at most once every 5 minutes, with how many failures it held back. The next heartbeat after the dashboard recovers resends what it missed. |

The secret never goes in `factory.yaml`; it stays in the environment. Set `url` in `factory.yaml` when Foreman is hosted (see [Go hosted](#go-hosted)).

Copy [`.env.example`](../.env.example) to `.env` and fill it in. Do not commit `.env`.

| Variable | Read by | Notes |
| --- | --- | --- |
| `GH_TOKEN` | worker, `gh` | The one GitHub token. Foreman keeps the value it started with, because `--cursor-events` replaces `GH_TOKEN` in its process with the Cursor account's GitHub credential. Hosted, it's `SA_GH_TOKEN`. |
| `CURSOR_API_KEY` | worker | Cloud Agents API. Platform name, not renamed. |
| `SA_FACTORY_CONFIG` | Foreman | Usually `factory.yaml`. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Foreman | Optional. The collector's OTLP/HTTP address, for example `http://localhost:4318`. |
| `SA_PORTAL_URL` | Foreman | Where the dashboard listens, when `dashboard.url` is not set in `factory.yaml`. `npm run dev` sets it to `http://127.0.0.1:8787`. |
| `SA_PORTAL_INGEST_SECRET` | Foreman and the dashboard | The shared key Foreman signs pushes with. Generate it with `openssl rand -hex 32` and give the dashboard the same value; `npm run dev` passes it to the dashboard it starts. Left empty, `npm run dev` makes a throwaway one, and the doctor can't probe the dashboard. |
| `FOREMAN_SLACK_BOT_TOKEN`, `FOREMAN_SLACK_APP_TOKEN` | Foreman | Required when `factory.yaml` has a `slack` block. |
| `CURSOR_ADMIN_API_KEY` | worker | Optional. Enables invoice cost. |
| `SA_GH_APP_ID`, `SA_GH_APP_PRIVATE_KEY` | worker | With `github.identity: app`. The key is the app's PEM; a one-line value with `\n` for line breaks works. |
| `SA_GH_BOT_TOKEN` | worker | With `github.identity: bot-user`. |

Then check everything with the same environment Foreman will have. The doctor also creates the factory's labels on the repository if they are missing.

```bash
npm run doctor
```

## Deploy

```bash
npm run dev
```

`npm run dev` starts Foreman under `bdk serve` with one `--repo` per repository in `factory.yaml`, and, while `dashboard.enabled` is true, the dashboard on <http://127.0.0.1:8787>. With no `SA_PORTAL_INGEST_SECRET` set, it makes a random one and gives it to both. `--cursor-events` receives GitHub deliveries through your Cursor account, so no public URL is needed. Foreman starts in about 30 seconds, and its first tick runs within a minute. Ctrl-C stops both. A small issue with no waits on people takes about 10 to 15 minutes from label to a pull request ready to merge.

Run state lives in BDK's durable store under `foreman/.agent-serve/`, so stopping and starting loses nothing. The dashboard keeps its own copy in `dashboard/.data/` and rebuilds it from Foreman within a minute if you delete it. For metrics, `docker compose -f setup/compose.yaml up -d` starts a collector on `:4318`; set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`.

To start Foreman without the dashboard: `npm run dev -- --foreman-only`. To stop it from another terminal: `npm run stop`.

## Go hosted

Foreman can run as a Cursor-hosted deployment instead of on your machine. Nothing in the folder changes; the store moves to the deployment's durable `host.kv`, and the 60-second tick becomes a schedule.

The deployment is named `foreman`, after the agent folder. BDK builds it from a pushed branch of a GitHub repository that your team's Cursor GitHub App can read, so commit this folder in its repository and push it first. Then, from the factory folder:

```bash
npm run deploy                                   # from origin at the current branch; add --repo <https url> --ref <branch> to pick another
cd foreman
npx --yes @cursor/bdk@0.2.28 secret set foreman SA_GH_TOKEN
npx --yes @cursor/bdk@0.2.28 secret set foreman SA_CURSOR_API_KEY
npx --yes @cursor/bdk@0.2.28 secret set foreman SA_CURSOR_ADMIN_API_KEY
npx --yes @cursor/bdk@0.2.28 secret set foreman SA_GH_APP_ID            # github.identity: app
npx --yes @cursor/bdk@0.2.28 secret set foreman SA_GH_APP_PRIVATE_KEY   # github.identity: app
npx --yes @cursor/bdk@0.2.28 slack create --dir . --env prod   # only with a slack block in factory.yaml
cd ..
npm run doctor -- --hosted
```

`secret set` prompts for each value; in a shell that can't answer a prompt, pipe it in (`printf %s "$GH_TOKEN" | npx --yes @cursor/bdk@0.2.28 secret set foreman SA_GH_TOKEN`). With `github.identity: bot-user`, set `SA_GH_BOT_TOKEN` instead of the two app secrets. `slack create` is needed once per deployment: it waits until you finish its `slack-setup` link in a browser, signed in to Cursor as the account behind `CURSOR_API_KEY`, and later deploys keep the Slack app. The doctor's local checks still run, so keep a collector up for its OTel line. Follow the hosted Foreman with `npx --yes @cursor/bdk@0.2.28 logs --prod --slug foreman`; the tutorial's Step 13 lists the lines to expect there.

`npm run deploy` refuses to run with uncommitted changes in the folder or when the remote branch isn't HEAD. It runs `bdk deploy` with `--repo`, `--ref`, `--path` and one `--cursor-events-repo` per repository in `factory.yaml`, and records the release id, `repo@sha` and a digest of the folder's files in `setup/verdicts/deploys.jsonl`. Commit that file. With `SA_VERIFY_HOSTED=1` the doctor checks that `foreman` runs the recorded release, built from the same files as your HEAD, and has its secrets. `npm run deploy -- --dry-run` prints the request and changes nothing.

On hosting, `CURSOR_API_KEY` is the deployment's own credential and `GH_TOKEN` is the Cursor account's GitHub credential, so the factory's keys get their own names: `SA_CURSOR_API_KEY` holds the key that launches step agents, `SA_GH_TOKEN` your GitHub token, and `SA_CURSOR_ADMIN_API_KEY` the optional Admin API key (hosting reserves `CURSOR_*` names). Hosted Slack is a separate bot that `slack create` makes after the first deploy; it stores the bot's tokens on the deployment as `FOREMAN_SLACK_BOT_TOKEN` and `FOREMAN_SLACK_APP_TOKEN`. When you rename or add a secret, set it on `foreman` before you deploy code that reads it, or every tick fails until you do.

**The dashboard when hosted.** A hosted Foreman can only reach hosts declared at deploy time, so it pushes only to a dashboard named by `dashboard.url` in `factory.yaml` (its host is added to the deployment's egress list when you deploy). You have three choices:

- **No dashboard.** Set `dashboard: { enabled: false }`. Foreman logs nothing about it. Status still appears on GitHub and in Slack.
- **Host it yourself.** Run `dashboard/` anywhere that has an HTTPS URL Foreman can reach (below). Set `dashboard: { enabled: true, url: https://factory.your-company.example }`, deploy, then `secret set foreman SA_PORTAL_INGEST_SECRET` with the value the dashboard has.
- **Keep it on a laptop.** Run `npm run dev` locally with `dashboard.enabled: true` for yourself, while a separate hosted Foreman has it off. Each Foreman has its own runs, so this is only for trying things out.

After deploying, run `npm run doctor` with the same `factory.yaml` and secret: its dashboard line says whether the URL answers and accepts the secret.

**A local Foreman next to a hosted one.** Only the intake label starts a run; a comment or gate label on a run a Foreman doesn't hold is ignored. So give the local copy its own label in a git-ignored config, such as `factory.local.yaml` with `intakeLabel: factory:run-dev-alice`, and start it with `SA_FACTORY_CONFIG=factory.local.yaml npm run dev`. Issues labeled `factory:run` go to the hosted Foreman and `factory:run-dev-alice` to yours. Put your own name in the label: every local Foreman with the same label claims the issue, and the first claim wins. Use a separate Slack app locally too, since each bot answers only its own mentions.

## Host the dashboard anywhere

`dashboard/` is a standard Next.js app with a Dockerfile. It needs one secret and, in production, a Postgres database.

```bash
docker build -t factory-portal dashboard/
docker run -d -p 8787:8787 \
  -e SA_PORTAL_INGEST_SECRET=... \
  -e SA_PORTAL_DATABASE_URL=postgres://user:pass@db:5432/factory \
  -e SA_PORTAL_AUTH=proxy -e SA_PORTAL_AUTH_HEADER=x-auth-request-email \
  factory-portal
```

The container applies its migrations on start. Without `SA_PORTAL_DATABASE_URL` it keeps an embedded Postgres (PGlite) in the `/data` volume, which is fine for one instance. Any Postgres works; the dashboard holds a copy of Foreman's run documents, so losing it loses nothing: the next heartbeat refills it.

| Variable | Notes |
| --- | --- |
| `SA_PORTAL_INGEST_SECRET` | Required. The same value Foreman has. Without it `/api/ingest` answers 503. |
| `SA_PORTAL_DATABASE_URL` | Postgres. Unset: PGlite in `SA_PORTAL_DATA_DIR` (`/data/pglite` in the image, `dashboard/.data/pglite` locally). |
| `SA_PORTAL_AUTH` | Who may view. `none` (default; only for `127.0.0.1` or a private network), `basic` with `SA_PORTAL_BASIC_AUTH=user:password`, or `proxy` behind your SSO proxy (oauth2-proxy, Cloudflare Access, an ALB with OIDC), which sets the header named by `SA_PORTAL_AUTH_HEADER`. With `proxy`, let only the proxy reach the container. |
| `SA_PORTAL_PORT` | Default `8787`. |

`/api/ingest` takes no viewer login: it accepts only requests signed with the shared secret, with a timestamp within 5 minutes, and never the same signature twice. `/api/health` is open for load balancer checks. The wire format is in [docs/portal-api.md](portal-api.md). For a quick public URL in front of a laptop, a tunnel works: `cloudflared tunnel --url http://127.0.0.1:8787`.

## Day-to-day use: a run from start to merge

1. **Start a run.** Add the `factory:run` label to an issue, or @mention Foreman at the top level of the factory Slack channel ("@Foreman add CSV export to the reports page"). From Slack, Foreman replies "Working on it.", opens the issue, posts the run's **status message** in the channel, and replies under your request with links to the issue and to the status thread. Every follow-up goes in the status thread; Foreman still answers you under your request, with a pointer there. If an open run already asks for the same thing, triage closed one as a duplicate in the last 24 hours, or one was abandoned in the last 30 days, Foreman links that run (and why it closed) instead of opening a second issue. Within a minute or so the worker creates the branch `factory/f-gh-<issue>` and launches Triage. Each agent launch is posted with a link that opens its live session in Cursor.
2. **Triage** checks recent issues and pull requests, abandoned ones included. A duplicate closes the issue with a note naming the original.
3. **Spec** (the PM) writes `specs/<run>.md` and opens a draft pull request. If the spec scores under the `threshold` in [`foreman/bot/subagents/spec/agent.ts`](../foreman/bot/subagents/spec/agent.ts), PM's questions appear on the issue and in the status thread, mentioning the requester, each with the assumption it will make. Reply on the issue, or in the status thread with `@foreman <your answers>` (Foreman copies them to the issue). PM runs again with your answers, up to `maxRounds` times.
4. **Spec gate.** The issue and the status thread get an ask linking the spec, ending with how to respond. On GitHub, an approver replies `approve` or `changes: <what to change>` on the issue or the pull request, or adds the `factory:spec-approved` label. In Slack, the requester or a listed Slack approver replies `@foreman approve` or `@foreman changes: <what>`, or reacts :white_check_mark: or :x: on the ask. Anyone else is told who can. A Slack approval is recorded on the issue as "Approved by @person via Slack reply" (or "reaction").
5. **Plan** writes `design/<run>.md`, and the **plan gate** works the same way.
6. **Implement** writes the code, **Review** and **Verify** each post a review on the pull request. Verify also records a walkthrough video and embeds it in the pull request description, and Foreman uploads the video into the status thread so it plays in Slack, with pass or fail and the pull request link. A `changes` verdict sends the findings back to Implement, up to three times.
7. **Ready to merge.** When Verify passes and the checks are green, the pull request is marked ready for review and the status thread gets "Ready to merge". Foreman keeps watching it: findings from Bugbot or the security reviewer, a "changes requested" review, a failed check or a new push send it back through the agents ([below](#working-with-bugbot-and-the-security-reviewer)).
8. **Merge.** A person merges it, and the run closes as done. If the issue is still open after the merge (GitHub closes linked issues only on merges into the default branch), Foreman closes it as completed.

**Abandon a run.** The requester or a listed Slack approver says `@foreman abandon: <why>` (or `close: <why>`) in either thread, or reacts :wastebasket: on the status message. Without a reason, Foreman asks for one line. Then it posts an **Abandoning** record on the issue, stops the run's agents, closes the pull request unmerged, adds the `abandoned` label, closes the issue as not planned, and writes a post-mortem (what was asked, how far it got, send-backs and findings, cost, why it stopped) on the issue and in the thread. Closing the issue or pull request by hand on GitHub also ends the run; Foreman then asks in the thread why, for the post-mortem.

The status message in the channel always shows the run's stage and links to the issue, the pull request and any running agent session; the issue has the same summary in one comment Foreman edits in place. The dashboard at `http://127.0.0.1:8787` (when it is on) shows every run; click one for its timeline (who decided each step), its cloud agents with links, and compute minutes.

**When a run is held.** A step that errors, runs past `deadlineMinutes`, pushes nothing, pushes to another branch, touches files it should not, or writes a bad result file holds the run. The issue and the Slack thread say why, with a link to the agent. Fix the cause, then an approver comments `retry` on the issue.

**Timing.** GitHub deliveries through `--cursor-events` often arrive 3 to 12 minutes late. The worker also checks every run waiting on a person once a minute, so an `approve` is usually picked up within a minute whether or not its delivery has arrived. Each cloud agent takes a minute or two to start.

**Restarts.** Stop and start Foreman at any time. On start the worker reconciles every open run, so anything that happened while it was down is picked up, and a step that finished meanwhile is collected.

## Metrics

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, Foreman pushes metrics to that collector over OTLP every minute. The dashboard computes its KPI tiles from the run documents themselves, so it needs no collector.

| Metric | Meaning |
| --- | --- |
| `factory.kpi.tasks_merged`, `tasks_closed`, `merged_rate` | Runs opened in the last 14 days that merged or closed unmerged. |
| `factory.kpi.intake_to_merge_hours`, `gate_wait_minutes` | Medians. |
| `factory.kpi.human_touches_per_task`, `send_backs_per_task` | Stage moves a person caused, and review or verify send-backs. |
| `factory.kpi.agent_runs_per_task`, `agent_minutes_per_task` | Cloud agents and their compute minutes. |
| `factory.kpi.cost_cents_per_task` | Invoice cents (sum of `chargedCents`); needs `CURSOR_ADMIN_API_KEY`. |
| `factory.dora.deploys_per_week`, `lead_time_hours`, `change_failure_rate`, `recovery_hours` | Over `dora.weeks`, from merges to `base` or GitHub Deployments (`dora.deploySource`). A failure is a revert or a merged PR with a `dora.hotfixLabels` label; recovery is the open time of issues labeled `dora.incidentLabel`. |
| `factory.metric.not_emitted{metric, reason}` | Each metric with no value yet, and why, instead of a zero. |
| `factory.stage.entered{stage}`, `factory.runs.open{stage}` | Stage flow. |

To send them elsewhere, add an exporter to [`setup/collector.yaml`](../setup/collector.yaml).

## Working with Bugbot and the security reviewer

The factory's own Review step and Cursor's Bugbot and security reviewer run side by side. Review is a cloud agent that reads the spec, the plan and the diff before Verify; Bugbot and the security reviewer are GitHub apps that review the pull request on their own schedule, often after Verify has passed. Foreman doesn't start or configure them; it reads what they leave.

**What sends work back.** While a run waits to merge, Foreman reads the pull request's reviews, unresolved review threads and checks on every reconcile and on each review, review comment, push and check delivery. These go back to Implement as feedback, then Review and Verify run again:

- an unresolved, not outdated review thread from a bot listed in `review.bots` (default `[cursor]`: Bugbot and the security reviewer both post as `cursor[bot]`);
- a "changes requested" review from a person, or from a listed bot;
- a failed, timed out or cancelled check.

Each finding is sent once. They share the three send-backs Review and Verify use; past that, Foreman stops sending work back and asks the requester in the status thread, who can push a fix, merge as is, or abandon the run.

**What doesn't.** A bot that isn't listed, a person's plain comment or "comment" review, a resolved or outdated thread, and Foreman's own reviews. To have a person's note acted on, submit the review as "Request changes". To add your own review bot, add its login without `[bot]` to `review.bots`; the doctor checks each name exists on GitHub.

**CI.** "Ready to merge" waits for green checks: the pull request stays a draft while any check is queued or running.

**Pushes.** A new commit after Verify, from anyone, reruns Review and Verify, so the evidence always matches the code that merges.

**When Foreman stops watching.** When the pull request merges (the run is done), is closed (the run closes, and Foreman asks why), or the run is abandoned. Foreman never merges, resolves threads or pushes itself.

## Verify a running factory

[`setup/verify-factory/`](../setup/verify-factory/SKILL.md) is the scripted proof: launch, doctor, one labeled issue, evidence, cleanup. Copy that folder to `.cursor/skills/verify-factory/` to run it from a Cursor session. It uses the sign-in and environment you already have. It does not ask for a token. When a hosted Foreman already watches these repositories, use the separate intake label from the local-Foreman note above so the proof does not take its issues.

```bash
npm run verify -- launch
npm run doctor -- --pids .factory/verify/pids.json
npm run verify -- drive --yes
npm run verify -- evidence
npm run verify -- cleanup
```

`npm run doctor` also reports who owns ports 8787 and 8790, which account the CLI and each key belong to, the team name and id, and whether the GitHub App installation reaches every repository in `factory.yaml`. The hosted lines (the running release against the last `npm run deploy` record, and the deployment's secrets) stay off until `SA_VERIFY_HOSTED=1`; `SA_DEPLOYMENT_SLUG` overrides `foreman`. Verdicts go in `setup/verdicts/ledger.jsonl`, with `setup/verdicts/ledger.md` beside it, and are committed (`npm run verdict -- append --pr <n> --verdict <name> --verifier "<agent, model>" --evidence <paths>`). A verdict is keyed by the newest commit outside `setup/verdicts/`, and a new one voids the older row for that pull request. Cleanup stops the pids launch recorded, not every `bdk serve` on the machine.

## Known issues

This is the one list; [ARCHITECTURE.md](../ARCHITECTURE.md) links here and explains the first item in depth.

- **Overlapping sessions can, rarely, double a tick, a step launch or a post.** On Cursor hosting each scheduled tick runs in a runtime of its own, beside Slack and GitHub deliveries. Leases and once-keys live in `host.kv`, which in `@cursor/bdk` 0.2.28 has no compare-and-set, so two sessions that claim the same lease within about 150 ms can both proceed. Intake is human-driven, so this should be rare. Run saves check the run's `rev`, and posts, launches and Slack intake are keyed so a repeat finds its key and does nothing. The fix is `putIfAbsent` and `putIfVersion` on `host.kv`. Details: [the race in ARCHITECTURE.md](../ARCHITECTURE.md#the-hostkv-race).
- **Hosted Slack ignores mentions posted by bots and apps.** A request a person types in Slack works. One posted through an app (another bot, a workflow, or a script with an app's token) never reaches a hosted Foreman, even when `slack.testerBot` and the channel allowlist would let it through on a local one. So scripted Slack tests need a local Foreman.
- **Hosted `host.files` can't recreate a deleted path.** In `@cursor/bdk` 0.2.28 a write to a path that was deleted earlier fails, so Foreman keeps all its state in `host.kv`. Keep that in mind before adding anything that stores documents in `host.files`.
- **The dashboard isn't tested with a hosted Foreman.** The dashboard is checked against a local Foreman only. Follow hosted runs in Slack and on GitHub.
- **A hosted Foreman exports no metrics by default.** It can only reach hosts in its egress list, which doesn't include a collector. Metrics work on a local Foreman with the collector from `docker compose -f setup/compose.yaml up -d`.
- **`deployment get` doesn't say which commit is running.** `npm run deploy` records it, and `npm run doctor -- --hosted` checks the running release against that record. A deploy made with `bdk deploy` directly is reported as unrecorded.
- **The deploy source must be readable by your team's Cursor GitHub App.** BDK builds from a pushed branch, so deploying from a repository the App can't read fails with "not accessible through this team's installation". See [PREREQUISITES.md](../PREREQUISITES.md).
- **The verify walkthrough video depends on the verify agent.** It is recorded in the agent's VM and embedded in the pull request description, and Foreman uploads it into Slack from the agent's artifacts. When the agent records none, or the upload fails, the run still moves on, and the Slack post links the video or says none was recorded.
