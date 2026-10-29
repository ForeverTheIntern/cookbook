# The checks (rubric 2026-10-alpha)

Six checks, plus an informational inventory of agent assets. Each check lists what it runs, when it passes, the evidence strength it needs, why it matters, and the usual fixes.

Evidence strength, weakest to strongest: stated in docs (`asserted`), read from files (`static`), ran on host (`executed`), ran in a clean container (`clean_replay`), confirmed by outcomes (`outcome_validated`). A check passes only at its required strength. A pass below it reads "not proven", never "passed".

## `scope.profile`: components and where changes land

Informational. Walks the whole tree for manifests at any depth: workspace packages (npm, pnpm and yarn workspaces), standalone Node and Python packages, and projects in toolchains the rubric doesn't support yet (`.csproj`, `.fsproj` and `.vbproj` projects, `.sln` solutions, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle`, `Gemfile`, `composer.json`). Each becomes a component with its own scripts, lockfile and install. Next to a root package, a nested package counts only with its own lockfile. A solution groups the projects under it. Unsupported components are listed as not assessed with the reason and keep their share of changes.

A nested manifest under a folder that usually holds tests, samples or tooling (`test`, `tests`, `spec`, `e2e`, `sample`, `example`, `demo`, `bench`, `plugin`, `util`, `config`), or a shared config package such as `@acme/eslint-config`, is a satellite: it's listed in part 4, not made a component, and only becomes one when the repo has nothing else to assess.

Each component's share counts changed files over 90 days. Bot authors, lockfile-only commits, generated files and renames don't count. The most active six supported components are assessed; when there are more, the report labels the scope "sampled" and lists the rest. Part 4 lists every component found, included or excluded, with its path, toolchain, manifest, lockfile and reason.

## `scope.agent_assets`: agent assets in the repo

Informational and never scored. Lists AGENTS.md and CLAUDE.md, skills (`.cursor/skills`, `.claude/skills`, `.agents/skills`), rules, hooks, environment config, MCP config and Copilot instructions, with git authors, the last change and whether their commands replay. Skill frontmatter must have a `name` and a `description`. It shows who in the repo already builds agent setup; it is never a reason for a recommendation by itself.

## `bootstrap.cold_replay`: setup works from a clean checkout

- **Runs:** the frozen install (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `uv sync --frozen`, or a virtualenv install from requirements), then each component's build and full test suite, in a clean container started from the repo's pinned toolchain. The network is on for install and build, and off for tests. A repo-declared `.cursor/environment.json` install and start replace the defaults, and a declared `.cursor/Dockerfile` is built and used as the image.
- **Passes:** each step exits 0 in the container. A pass on the host or in a fresh copy on the host is "blocked on this machine", because it can't rule out a service or tool the machine already had.
- **Blocked, not failed:** with no container runtime, a step that fails because this machine lacks a tool (`dotnet: command not found`), a setup command that uses `sudo`, and every step behind a blocked install are blocked. Blocked never counts against the repo and never counts as met. When the repo's declared image installs the missing tool, the report says so.
- **Also records:** whether a frozen install left the lockfile unchanged, and whether the toolchain is pinned (`.nvmrc`, `engines.node`, `packageManager`, `.python-version`). Repo-wide changes need both.
- **Needs:** ran in a clean container.
- **Why:** every agent starts from a clean checkout, so setup that only works on a prepared machine breaks every agent run. In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%, measured on the study's benchmark repositories ([arXiv 2605.15815](https://arxiv.org/abs/2605.15815), [code](https://github.com/Vossera/BootstrapAgent)).
- **Usual fixes:** a service the tests expect on localhost (start it in the setup's start script), a credential the tests read (fake it), a lockfile that isn't committed, a registry token (pass its name with `--registry-env`).

## `verify.canonical_interface`: build, lint, type-check and test commands pass

- **Runs:** every discovered or documented build, lint, type-check and test command at `HEAD`.
- **Passes:** all of them exit 0, and a test command exists. Stale documented commands count as failed, not missing.
- **Needs:** ran on host or stronger.
- **Why:** agents need one known way to check their own work before they push.
- **Usual fixes:** fix the failing command on the main branch; add a missing test or lint script.

## `verify.behavioral_oracle`: tests catch planted faults

- **Runs:** in a throwaway copy, the scripts plant up to 5 faults per component in files the component's tests import, most recently changed first. The operators flip a comparison boundary, negate a condition, shift by one, swap a boolean return, drop a throw or early return, or change a constant. The seed is fresh for each audit, so planted faults can't be learned. TypeScript, JavaScript and Python are supported.
- **Flake guard:** the suite must pass twice before any fault is planted. A fault counts as caught only if the suite fails on two runs. A fault that breaks compilation is discarded, not counted.
- **Passes:** every counted fault is caught, and at least 3 gave a clear result. Coverage alone never passes.
- **Needs:** ran on host or stronger. Level 2 also needs Level 1, which needs a clean container.
- **Why:** green tests aren't proof that a change is right.
  - In DeployBench, 53.9% of failed runs passed generic checks and were caught only by task-specific verification, and 97 of 154 failed runs declared themselves done after validating a weaker target. Caveat: 51 research-artifact deployment tasks ([site](https://deploybench.vercel.app/)).
  - OpenAI's SWE-Bench Pro audit flagged 200 of the 731 public tasks automatically (27.4%) and found 249 in human review (34.1%), so OpenAI estimates about 30% are broken, including low-coverage tests that let incomplete fixes pass. Caveat: an audit of one benchmark ([Jul 8, 2026](https://openai.com/index/separating-signal-from-noise-coding-evaluations)). It also sets a design rule here: a planted fault must be one any correct suite catches, not one tied to a particular implementation.
  - OpenAI's SWE-bench Verified audit found material test or description flaws in 59.4% of 138 tasks that o3 failed inconsistently. Caveat: that rate is within a selected subset of about 27.6% of the benchmark, not the whole benchmark. Secondary-confirmed: the primary page (openai.com/index/why-we-no-longer-evaluate-swe-bench-verified, Feb 23, 2026) wasn't reachable when this was written.
- **Usual fixes:** tests that assert results and edge cases instead of only calling the code.

## `context.instructions_verified`: agent instructions are accurate

- **Reads:** AGENTS.md and CLAUDE.md at any depth, `.cursor/rules`, `.github/copilot-instructions.md` and `.instructions.md` files, skills, and the root README.
- **Static pre-pass:** each command and path is checked first, by file and line: the wrong package manager, a script missing from `package.json`, a missing Make target, a path that doesn't exist.
- **Replay:** every remaining command runs in the clean container. Install commands are checked statically, since the replay runs the frozen install. Long-running commands (dev servers, watchers) and risky ones (deploy, publish, delete, network piped into a shell) are listed and not run.
- **Passes:** no item fails and every replayable command replayed.
- **Needs:** ran on host or stronger.
- **Why:** agents follow these files literally, so a stale command costs more than a missing one. The conventions scanned are AGENTS.md (Codex's `/init` and its root-to-folder discovery), GitHub's `copilot-instructions.md` and path-specific `.instructions.md`, and Cursor's `.cursor/rules` plus AGENTS.md. No outcome study yet measures how much these files help.

## `safety.execution_boundary`: normal work needs no production access

- **Fails on:** committed secrets (reported by type and line, never the value), tests that read production credentials (environment variables named `*PROD*`, `*PRODUCTION*`, `*LIVE*`, or a test failure that names a missing key, secret, token or password), and install hooks that pipe a download into a shell.
- **Lists for review without failing:** other install hooks, destructive scripts, deploy or publish scripts, and any setup or script that runs `sudo`.
- **Needs:** read from files.
- **Why:** agents run with whatever access setup gives them, so normal work must never need production credentials, and setup must not need more privilege than a container gives it. When a hook pipes a download into a shell, the replay installs with `--ignore-scripts` instead of running it. A command that uses `sudo` runs only inside the throwaway container, never on the host.

## Other signals (informational)

Part 4 lists five signals read from files. None of them sets a level, adds a roadmap step or appears in part 1.

- **CI config:** a GitHub Actions, GitLab CI, CircleCI or Buildkite config, and whether it runs tests.
- **A way to run one test file:** whether each assessed component's test runner takes a file or a name filter (`node --test`, vitest, jest, mocha, pytest), so an agent can rerun only the tests near its change.
- **Sample env file:** when the code reads environment variables of its own, whether a `.env.example` or similar names them.
- **Worktree and port isolation:** fixed ports and machine-specific absolute paths in package scripts, the environment setup, Makefiles, shell scripts and compose files, which collide when two agents work in separate worktrees.
- **AGENTS.md length:** the root AGENTS.md's word count, marked long over 900 words, since agents load all of it on every task.

An environment setup whose install or start uses `sudo` is listed in the agent assets as not a working setup.

## Met, not met, blocked and unknown

Every condition ends in one of four states. Met and not met come from a run at the strength the check needs. Blocked means a limit of this machine kept the deciding run from happening. Unknown means it didn't run for another reason, such as the time budget. A level needs every condition met.

No real results, no level: when no Level 1 check ran and passed, or failed for a reason in the repo, the report gives no level, plans no actions, adds no roadmap steps and says why. That covers an audit where no component could be assessed, where every check was blocked on this machine, and the read-only tier.

The report names each condition that holds the level where it is, and gives a confidence (high, medium or low) with its reasons. Confidence drops when setup ran on the host, a deciding check was blocked, part of the recent changes isn't assessed, or the scope was sampled. It's reported next to the level and never raises it.

## Why scripts own the results

An agent grading its own work is the weak point. Factory's GDAL result reports 89.8% on a held-out suite with a separate validation system, against 35.8% for the same model working as a single agent. Caveat: one reported task ([repo](https://github.com/Factory-AI/pb-gdal-fable), [write-up](https://factory.ai/news/what-it-takes-for-coding-agents-to-complete-large-software-tasks)). So this skill keeps the grading out of the agent's hands: scripts create the evidence, plant the faults, compute the levels, seal the audit with a digest of the scripts and rubric, and flag weakened tests in `diff`.

## Not assessed by this rubric

Whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found, and outcome checks on held-out tasks. The report names these as "not assessed", which is different from unknown.
