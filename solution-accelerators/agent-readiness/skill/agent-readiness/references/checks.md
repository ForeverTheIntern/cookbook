# The checks (rubric 2026-10-alpha)

Six checks, plus an informational inventory of agent assets. Each check lists what it runs, when it passes, the evidence strength it needs, why it matters, and the usual fixes.

Evidence strength, weakest to strongest: stated in docs (`asserted`), read from files (`static`), ran on host (`executed`), ran in a clean container (`clean_replay`), confirmed by outcomes (`outcome_validated`). A check passes only at its required strength. A pass below it reads "not proven", never "passed".

## `scope.profile`: components and where changes land

Informational. Finds workspace packages and apps (npm, pnpm and yarn workspaces, single Node or Python packages) and counts each one's share of changed files over 90 days. Bot authors, lockfile-only commits, generated files and renames don't count. The most active six supported components are assessed. Folders in toolchains the rubric doesn't support yet (Terraform, Go, Rust, JVM, .NET, Ruby) are listed as not assessed with the reason.

## `scope.agent_assets`: agent assets in the repo

Informational and never scored. Lists AGENTS.md and CLAUDE.md, skills (`.cursor/skills`, `.claude/skills`, `.agents/skills`), rules, hooks, environment config, MCP config and Copilot instructions, with git authors, the last change and whether their commands replay. Skill frontmatter must have a `name` and a `description`. It shows who in the repo already builds agent setup; it is never a reason for a recommendation by itself.

## `bootstrap.cold_replay`: setup works from a clean checkout

- **Runs:** the frozen install (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `uv sync --frozen`, or a virtualenv install from requirements), then each component's build and full test suite, in a clean container started from the repo's pinned toolchain. The network is on for install and build, and off for tests. A repo-declared `.cursor/environment.json` install and start replace the defaults, and a declared `.cursor/Dockerfile` is built and used as the image.
- **Passes:** each step exits 0 in the container. A pass on the host or in a fresh copy on the host is "not proven", because it can't rule out a service or tool the machine already had.
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
- **Lists for review without failing:** other install hooks, destructive scripts, and deploy or publish scripts.
- **Needs:** read from files.
- **Why:** agents run with whatever access setup gives them, so normal work must never need production credentials. When a hook pipes a download into a shell, the replay installs with `--ignore-scripts` instead of running it.

## Why scripts own the results

The session that audits may later remediate. Factory's GDAL result reports 89.8% on a held-out suite with a separate validation system, against 35.8% for the same model working as a single agent. Caveat: one reported task ([repo](https://github.com/Factory-AI/pb-gdal-fable), [write-up](https://factory.ai/news/what-it-takes-for-coding-agents-to-complete-large-software-tasks)). So this skill keeps the grading out of the agent's hands: scripts create the evidence, plant the faults, compute the levels, seal the audit with a digest of the scripts and rubric, and flag weakened tests in `diff`.

## Not assessed by this rubric

Whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found, and outcome checks on held-out tasks. The report names these as "not assessed", which is different from unknown.
