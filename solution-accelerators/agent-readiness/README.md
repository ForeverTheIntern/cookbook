# Agent Readiness

A Cursor skill that finds what would stop a coding agent in a repository, and helps fix the two things that matter most: a working environment and a way to verify changes.

It answers one question: what level is this repo at, and each app or component in it, and what are the top three things holding them back? Each of the three comes with a fix that can be proved and the outcome it should deliver.

It is not a gate to pass before you start using agents. When it finds no blocker, the report says so and recommends starting to delegate.

## How it works

- **It scores only what it ran.** Scripts install, build and test the repo in a clean container, plant faults its tests should catch, and replay every command in AGENTS.md, rules, skills and the README. The presence of a file never passes a check.
- **The agent can't grade its own work.** The skill's scripts create the evidence, choose the planted faults, compute every level and seal the audit with a digest of the scripts and rubric. The agent picks the scope, explains the result and stops.
- **Levels follow the work, in three tiers.** The repo gets one rollup level. Each app or component the scan finds gets one standard level, and part 4 lists every component included or left out, with the reason. Scenarios, such as bug fixes or repo-wide changes, are optional breakdowns nested under the components they cover, present only when someone adds them. A monorepo can be at Level 2 in one package and not bootable in another.
- **The rollup rule is explicit.** The repo level is the lowest standard level among active components: the assessed ones with at least 10% of changes over 90 days, where a component joins or leaves that set only after two audits on the same side of the line. Components the audit can't assess never set it, and scenarios never change it. With no real check result there is no level at any tier. See [references/levels.md](skill/agent-readiness/references/levels.md).
- **It keeps score over time.** A roadmap with stable item IDs, a weekly recheck, and agent PR outcomes against other PRs show whether fixes paid off.

| Level | Name | Measured by |
|---|---|---|
| 0 | Not bootable | audit |
| 1 | Bootable: a clean checkout installs, builds and passes every test | audit |
| 2 | Verifiable: the commands pass, the tests catch planted faults, the instructions are accurate and normal work needs no production access | audit |
| 3 | Delegable: agent PRs meet the outcome targets your team set | outcomes |
| 4 | Scalable: those targets held while agent PR volume at least doubled | outcomes |

An audit never claims Level 3 or 4 by itself. Those need team-set targets over at least 20 agent PRs, compared with other PRs in the same window.

## Quickstart

Copy the skill into the repository you want to audit:

```bash
cp -R solution-accelerators/agent-readiness/skill/agent-readiness <repo>/.cursor/skills/agent-readiness
```

Then ask the agent in that repo: "Run an agent readiness audit." To see one kind of work broken out, ask for it, for example "and break out bug fixes for web".

It needs Node 22.14 or later and no packages. Docker or Podman proves Level 1; without one, the audit still runs in a scrubbed throwaway copy and says "Level 1 not provable on this machine".

To run it without an agent, from the repo root:

```bash
node --experimental-strip-types --no-warnings .cursor/skills/agent-readiness/scripts/readiness.ts audit --tier local-exec
```

## Reading the report

`.agent-readiness/latest/report.md` has four parts:

1. **Where you stand.** One screen: the level and what it means, a one-message headline that names the component setting the level, three numbers each with a comparison, the scale, at most three gaps and one ask.
2. **Next actions and how they move the needle.** Effort against impact, where impact is the share of recent changes in components whose level rises when only that action's checks flip to passing. Each action names the metric to watch and its baseline.
3. **Where you are on the roadmap.** Every step and its status, and from the second audit on, levels over time and what each closed step delivered against what it was expected to.
4. **Details.** Exact steps, every check with why it matters and its evidence, levels by component with any scenarios nested under each, the repo level and its rule, agent PR outcomes, agent assets and their authors, and the evidence log.

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
- **No container runtime:** the replay falls back to a fresh copy on the host, and part 1 says Level 1 can't be proved on that machine. A tool the host lacks, and every step behind it, is reported as blocked on this machine, never as a repo defect, and commands that use `sudo` are listed by the safety check and never run on the host. When nothing produced a real result, the report gives no level and says why. The scheduled workflow on a hosted runner can prove Level 1.
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

Most open-source readiness tools we found score what's in the repo's files: [AgentReady](https://github.com/napetrov/agentready), [agentsmd-check](https://github.com/7y-9/agentsmd-check), [agent-pipx](https://github.com/kyizinlatt/agent-pipx), [RepoReady](https://github.com/shidesheng0218/repo-ready), and the OpenHands [`agent-readiness-report`](https://github.com/OpenHands/extensions/tree/main/plugins/onboarding/skills/agent-readiness-report) skill, which gathers filesystem signals across 5 pillars and 74 features. Some tools also have an agent try the setup or the checks, and grade that attempt. [Factory's Agent Readiness](https://github.com/Factory-AI/factory/blob/main/docs/web/agent-readiness/overview.mdx) uses 5 levels, 9 pillars and an 80% gate. This skill borrows their detector lists and safety patterns, but scores only evidence its scripts produced by running the repo's commands, never the agent's own grade. It grades each component and rolls the repo up by a stated rule instead of one percentage, and never acts as a gate.

## Develop

```bash
npm ci
npm run check            # typecheck and every test; fixture audits need Docker
npm run evals -- --tag smoke
npm run goldens          # audit the pinned public repos; needs network and Docker
npm run sample           # regenerate examples/ from the monorepo-mixed fixture
npm run release-manifest # after changing the skill's scripts, rubric, schemas or templates
```

Fifteen fixtures under `fixtures/`, each a tiny repo with one planted defect or repo shape and an `expected.json`, are the diagnostic ground truth. Five cover repo shapes from the field: tests that import a folder (`folder-import`), standalone apps next to .NET projects with no root package (`standalone-nested-mixed`), a setup that needs a tool only the declared image installs (`declared-image-missing-toolchain`), a start command that runs sudo (`sudo-start`), and a toolchain the rubric doesn't support (`unsupported-go-service`). Two of them also run with no container runtime. [AGENTS.md](AGENTS.md) holds the rule for adding checks and scenarios, and for turning field feedback bundles into fixtures.

### Skill evals

The evals run the real Cursor agent on each fixture with a pinned prompt and grade what the scripts wrote: at most five hard gates per case (a sealed audit that `verify-seal` accepts, levels, top items, the part 1 rules, no forbidden action), plus two soft judge scores for part 1. The headline judge carries the bar of 0.8; the page judge is tracked.

- `npm run evals -- --tag smoke|full --repeats 3 --json out.json --junit out.xml --compare evals/baseline.json` drives the agent through `@cursor/sdk` and needs a `CURSOR_API_KEY`. CI runs this.
- Without a key, any agent can be the driver: `--prepare` builds the workspaces and a manifest of prompts, the agent runs each prompt, `--grade <root>` grades one workspace, and `--collect <dir>` summarizes. `--rerender <root>` rebuilds a run's report with the current scripts, so a rendering change can be judged on earlier runs.

[evals/baseline.json](evals/baseline.json) is the result CI compares against, and [evals/HILLCLIMB.md](evals/HILLCLIMB.md) logs how it was reached, one failure mode per round.

### Public goldens

Six pinned public repos, from a well-tested npm package down to a monorepo with no tests, plus a Go module and a .NET solution, check that the levels rank real repositories in the expected order and that no report claims a config, script or path its tree doesn't have. [evals/README.md](evals/README.md) lists the repos, why each is there, the expected order and what the first runs found.

## Known gaps

- Not assessed yet: whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found, and outcome checks on held-out tasks.
- Planted faults target files the tests import, most recently changed first. Targeting by coverage is a follow-up. Faults are planted in TypeScript, JavaScript and Python only.
- Components are found by walking the whole tree for manifests: workspaces, standalone Node and Python packages at any depth, each with its own install, and .NET, Go, Rust, JVM, Ruby and PHP projects, which are listed as not assessed. Manifests under test, sample or tooling folders are listed as satellites, not components.
- The instruction check reads a fenced `npm test` after a `cd apps/web` line as a root command.
- Node and Python components in one repo share the Node image, which needs `python3-venv` from apt for the Python ones. Where apt is blocked, their installs fail and read as repo failures.
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
