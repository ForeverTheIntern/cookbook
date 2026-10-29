# Agent Readiness

A Cursor skill that finds what would stop a coding agent in a repository, and helps fix the two things that matter most: a working environment and a way to verify changes.

It answers one question: for an activity (first PR, bug fixes, features and refactors, or repo-wide changes), what level is this repo and each of its components at, and what are the top three things holding it back? Each of the three comes with a fix that can be proved and the outcome it should deliver.

It is not a gate to pass before you start using agents. When it finds no blocker, the report says so and recommends starting to delegate.

## How it works

- **It scores only what it ran.** Scripts install, build and test the repo in a clean container, plant faults its tests should catch, and replay every command in AGENTS.md, rules, skills and the README. The presence of a file never passes a check.
- **The agent can't grade its own work.** The skill's scripts create the evidence, choose the planted faults, compute every level and seal the audit with a digest of the scripts and rubric. The agent picks the scope, explains the result and stops.
- **Levels follow the work.** Each component gets a level per activity, and the repo level is the lowest among components that get at least 10% of recent changes. A monorepo can be ready for bug fixes in one package and not bootable in another.
- **It keeps score over time.** A roadmap with stable item IDs, a weekly recheck, and agent PR outcomes against other PRs show whether fixes paid off.

| Level | Name | Measured by |
|---|---|---|
| 0 | Not bootable | audit |
| 1 | Bootable: a clean checkout installs, builds and passes every test | audit |
| 2 | Verifiable: everything the activity needs to check an agent's work passes | audit |
| 3 | Delegable: agent PRs meet the outcome targets your team set | outcomes |
| 4 | Scalable: those targets held while agent PR volume at least doubled | outcomes |

An audit never claims Level 3 or 4 by itself. Those need team-set targets over at least 20 agent PRs, compared with other PRs in the same window.

## Quickstart

Copy the skill into the repository you want to audit:

```bash
cp -R solution-accelerators/agent-readiness/skill/agent-readiness <repo>/.cursor/skills/agent-readiness
```

Then ask the agent in that repo: "Run an agent readiness audit for bug fixes."

It needs Node 22.14 or later and no packages. Docker or Podman proves Level 1; without one, the audit still runs in a scrubbed throwaway copy and says "Level 1 not provable on this machine".

To run it without an agent, from the repo root:

```bash
node --experimental-strip-types --no-warnings .cursor/skills/agent-readiness/scripts/readiness.ts audit --goal bug_fixes --tier local-exec
```

## Reading the report

`.agent-readiness/latest/report.md` has four parts:

1. **Where you stand.** One screen: the level and what it means, a one-message headline that names the component setting the level, three numbers each with a comparison, the scale, at most three gaps and one ask.
2. **Next actions and how they move the needle.** Effort against impact, where impact is the share of recent changes in components whose level rises when only that action's checks flip to passing. Each action names the metric to watch and its baseline.
3. **Where you are on the roadmap.** Every step and its status, and from the second audit on, levels over time and what each closed step delivered against what it was expected to.
4. **Details.** Exact steps, every check with why it matters and its evidence, levels by component and activity, agent PR outcomes, agent assets and their authors, and the evidence log.

`report.json` (schema `agent-readiness/report@1`) is the view model. The markdown and any other renderer are views of it. See [references/report.md](skill/agent-readiness/references/report.md).

The outcome numbers are a baseline and then a trend, not attribution. Every rate shows its n and window, below 5 the report shows counts only, and agent PRs always sit next to other PRs from the same window.

## Records

- **On main:** `.agent-readiness/roadmap.json` (the ordered path, owner and Level 3 targets) and `.agent-readiness/latest/` (the latest report). One small commit per audit.
- **On the `agent-readiness/history` branch, or CI artifacts:** the sealed `audits/<id>/` folders and `history.jsonl`, one line per audit and recheck. `readiness history push --push` writes them; the scheduled recheck appends there only.

Redaction runs before every write, and a final secret scan blocks anything bound for history.

## Fixing what it finds

Say "fix the primary blocker". The skill then loads [remediate.md](skill/agent-readiness/remediate.md) and produces, each proved before it's offered:

- **An environment setup:** install and start scripts and a `.cursor/environment.json` that uses only `name`, `install` and `start`, proved by a new audit in a clean container. Committing the file doesn't configure Cloud Agents by itself; a team admin points the environment at it.
- **A verify skill:** `.cursor/skills/verify/SKILL.md`, written by `readiness draft-skill` from commands the audit ran and saw pass, with a failure playbook from failures the audits observed. It refuses commands the audit didn't run.

Tests added to catch planted faults are proved against a fresh set of faults the fixing session never saw.

## Enterprise repos

- **Private registries:** `--registry-env NPM_TOKEN,PIP_INDEX_URL` passes named variables to the install. Names are recorded and values never are. Without them, a 401 reads "registry credentials not provided", not a repo blocker.
- **Network:** tests run with networking off after the install.
- **Base images:** `--image <ref>` replays on an approved internal image. A repo-declared `.cursor/Dockerfile` in `environment.json` is built and used.
- **No container runtime:** the replay falls back to a fresh copy on the host, and the report says Level 1 can't be proved on that machine. The scheduled workflow on a hosted runner can prove it.
- **Budgets:** `--budget-component` and `--budget-total` (15 and 60 minutes). Anything cut off counts as not run.
- **Org skill builders:** `readiness assets --org <owner> --tier external-systems` lists the top 10 skill authors across GitHub-visible repos, capped at 200 repos.

## Permission tiers

| Tier | Runs repo code | Reads GitHub |
|---|---|---|
| `read-only` | no | no |
| `local-exec` (default) | in a clean container or scrubbed copy | no |
| `external-systems` | yes | PR outcomes through `gh`, published release manifest |

Repo commands get an allowlisted environment: `PATH`, a temporary `HOME` and isolated package caches. `--inherit-env` passes the user's environment and should only be used with their approval.

## CI

- [static-checks.yml](examples/github-workflows/static-checks.yml): read-only static checks on PRs that touch agent instructions or package scripts.
- [scheduled-recheck.yml](examples/github-workflows/scheduled-recheck.yml): a weekly recheck from a pinned accelerator release, with `verify-seal` against that release, appending to the history branch.
- [skill-evals.yml](examples/github-workflows/skill-evals.yml): for this accelerator. The deterministic suite on every PR and the skill evals against the real Cursor agent.

## How this differs from checklist tools

Every open-source readiness tool we found is static: [AgentReady](https://github.com/napetrov/agentready), [agentsmd-check](https://github.com/7y-9/agentsmd-check), [agent-pipx](https://github.com/kyizinlatt/agent-pipx), [RepoReady](https://github.com/shidesheng0218/repo-ready), and the OpenHands [`agent-readiness-report`](https://github.com/OpenHands/extensions/tree/main/plugins/onboarding/skills/agent-readiness-report) skill, which gathers filesystem signals across 5 pillars and 74 features. [Factory's Agent Readiness](https://github.com/Factory-AI/factory/blob/main/docs/web/agent-readiness/overview.mdx) uses 5 levels, 9 pillars and an 80% gate. This skill borrows their detector lists and safety patterns, but scores only executed evidence, grades per component and activity instead of one percentage, and never acts as a gate.

## Develop

```bash
npm ci
npm run check            # typecheck and every test; fixture audits need Docker
npm run evals -- --tag smoke
npm run sample           # regenerate examples/ from the monorepo-mixed fixture
npm run release-manifest # after changing the skill's scripts, rubric, schemas or templates
```

Nine fixtures under `fixtures/`, each a tiny repo with one planted defect and an `expected.json`, are the diagnostic ground truth. [AGENTS.md](AGENTS.md) holds the rule for adding checks and goal packs, and for turning field feedback bundles into fixtures.

## Known gaps

- Not assessed yet: whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found, and outcome checks on held-out tasks.
- Planted faults target files the tests import, most recently changed first. Targeting by coverage is a follow-up. Faults are planted in TypeScript, JavaScript and Python only.
- Components are found in npm, pnpm and yarn workspaces and in single Node or Python packages. Other toolchains are listed as not assessed.
- First-time CI pass is read from the check runs on a PR's first commit.
- Follow-ups outside this folder: the cookbook index row, a docs page, a blog post, and running the recheck from a Cursor automation.

## Design notes

Only verified sources, each with its caveat:

- **Clean replay before trust.** BootstrapAgent reports 92.9% bootstrap success with warm repair and clean replay, and a verified setup cut later agents' token use by 25.9% and build time by 22.3%, on its benchmark repositories ([arXiv 2605.15815](https://arxiv.org/abs/2605.15815)). RepoLaunch's setup records (base image and setup commands) shaped the replay record ([repo](https://github.com/microsoft/RepoLaunch)).
- **Green tests aren't proof.** In DeployBench, 53.9% of failed runs passed generic checks and were caught only by task-specific verification, and 97 of 154 failed runs declared themselves done after validating a weaker target. Caveat: 51 research-artifact deployment tasks ([site](https://deploybench.vercel.app/)). OpenAI estimates about 30% of SWE-Bench Pro's 731 public tasks are broken, including low-coverage tests that let incomplete fixes pass ([Jul 8, 2026](https://openai.com/index/separating-signal-from-noise-coding-evaluations)). OpenAI's SWE-bench Verified audit found material test or description flaws in 59.4% of 138 inconsistently failed tasks, a selected subset of about 27.6% of the benchmark (Feb 23, 2026; secondary-confirmed).
- **Separate the grader from the worker.** Factory reports 89.8% on a held-out GDAL suite with a validation system against 35.8% for the same model as a single agent. Caveat: one reported task ([write-up](https://factory.ai/news/what-it-takes-for-coding-agents-to-complete-large-software-tasks)).
- **The harness changes outcomes.** SWE-agent (Yang et al., NeurIPS 2024, arXiv 2405.15793; secondary-confirmed) is why later outcome probes will pin the agent.
- **Instruction files.** The scanned conventions are AGENTS.md, GitHub's `copilot-instructions.md` and `.instructions.md`, and Cursor's `.cursor/rules`. No outcome study yet measures how much these files help.
- **Environment config.** Generated `environment.json` files use only fields in the [schema](https://cursor.com/schemas/environment.schema.json).
