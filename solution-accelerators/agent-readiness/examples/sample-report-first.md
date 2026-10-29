# Agent readiness: monorepo-mixed

> Eval run with a pinned seed; not a production result. Scripts match the agent-readiness-v0.1.0 manifest bundled with this copy; the published release isn't checked here.

## 1. Where you stand: Level 0 of 4, not bootable

Audited Oct 27, 2026 at 7070f44. Confidence: high (every check that decides the level ran).

**Agents can't pass the tests in api from a clean checkout because its tests need Postgres running, which the setup doesn't start, and 56% of recent changes land there.**

- **Components ready for agents:** 0 of 3. Level 2 needs 3 of 3.
- **Agent PRs that pass CI the first time:** 33% (3 of 9). Other PRs: 71% (29 of 41), Sep 27 to Oct 27, 2026.
- **Recent changes in components below Level 1:** 56%. Level 1 needs 0%, counting the last 90 days.

[Level 0 Not bootable] > Level 1 Bootable > Level 2 Verifiable > Level 3 Delegable > Level 4 Scalable

Next: Level 1, bootable. Met: installs from the lockfile in a clean container. Not yet: api passes every test in a clean container.

1. **Set up Postgres for agents in api.** Blocks Level 1 for api.
2. **Fix the stale agent instructions.** Blocks Level 2 for shared.
3. **Make worker's tests catch wrong behavior.** Blocks Level 2 for worker.

> **Recommendation:** Decision needed: approve committing the setup files. Also name an owner for agent readiness.

The level covers 3 components and ignores infra (2% of changes, Terraform isn't supported by this rubric). Agent PRs are matched by head branch starting with cursor/.

## 2. Next actions and how they move the needle

Effort against impact (impact is the share of recent changes an action unblocks): 1. Set up Postgres for agents in api (effort small, 56%); 2. Fix the stale agent instructions (effort small, 15%); 3. Make worker's tests catch wrong behavior (effort medium, 0%).

### 1. Set up Postgres for agents in api

- **Why it matters:** In a clean container, api's tests fail because nothing starts Postgres: connection refused on port 5432.
- **How it moves the needle:** Takes api to Level 1, covering 56% of recent changes. Agents can run api's checks before they push, so fewer agent PRs fail CI the first time.
- **What to watch:** Share of agent PRs touching api that pass CI the first time. Now: 20% (1 of 5), Sep 27 to Oct 27, 2026.
- **Research:** In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%. Measured on the study's benchmark repositories. https://arxiv.org/abs/2605.15815
- **Effort and owner:** Small: setup scripts and environment config, no source changes. Repo maintainer.
- **Decision needed:** Approve committing the setup files.
- **Done when:** `readiness replay --component api` passes every test.

### 2. Fix the stale agent instructions

- **Why it matters:** 3 instructions agents would follow are wrong: npm run changelog (no "changelog" script in package.json), pnpm test (uses pnpm, but the repo uses npm).
- **How it moves the needle:** Takes shared to Level 2, covering 15% of recent changes. Agents stop following stale steps, such as running pnpm in a repo that doesn't use it.
- **What to watch:** Agent PRs that add a stray pnpm-lock.yaml. Now: 11% (1 of 9), Sep 27 to Oct 27, 2026.
- **Effort and owner:** Small: 2 instruction files. Repo maintainer.
- **Done when:** `readiness run --instructions` replays every instruction item.

### 3. Make worker's tests catch wrong behavior

- **Why it matters:** The audit planted 5 faults in worker in a throwaway copy, and the tests caught 0.
- **How it moves the needle:** Changes no level on its own: shared to Level 2, worker to Level 2 together with Fix the stale agent instructions. Changes in worker get a real pass-or-fail signal, so reviewers catch less by hand.
- **What to watch:** Share of agent PRs touching worker where a reviewer requested changes. Now: 2 of 3 (too few for a rate), Sep 27 to Oct 27, 2026.
- **Research:** In DeployBench, 53.9% of failed runs passed generic checks and failed only task-specific ones. 51 research-artifact deployment tasks. https://deploybench.vercel.app/
- **Effort and owner:** Medium: tests in worker only. Component owner.
- **Decision needed:** What the untested behavior in packages/worker/src/retry.js should be.
- **Done when:** A new audit's fresh planted faults in worker are all caught.

## 3. Where you are on the roadmap

0 of 6 steps done. Kept in `.agent-readiness/roadmap.json`.

- [ ] 1. Name an owner for agent readiness: unlocks a named owner for approvals, targets and the weekly recheck (next)
- [ ] 2. Set up Postgres for agents in api: unlocks api to Level 1 (next)
- [ ] 3. Fix the stale agent instructions: unlocks shared to Level 2 (next)
- [ ] 4. Check api's tests with planted faults: unlocks nothing on its own; first needs Set up Postgres for agents in api (waiting on step 2)
- [ ] 5. Make worker's tests catch wrong behavior: unlocks shared to Level 2, worker to Level 2 together with Fix the stale agent instructions (next)
- [ ] 6. Set your Level 3 targets: unlocks a definition of Level 3 for this repo (later)

## 4. Details: exact steps and everything we checked

### Steps for Set up Postgres for agents in api

1. **Ask the agent to fix it.** Say "fix the primary blocker". It drafts install and start scripts and a `.cursor/environment.json` with `readiness draft-env`.
2. **The agent proves it.** `readiness replay --component api` must pass every test before the fix is offered.
3. **Review and merge.** Check that the start script only starts local services and names no production URLs.
4. **Point Cloud Agents at it.** A team admin sets the Cloud Agent environment to read `.cursor/environment.json`; committing the file alone changes no environment.
5. **Re-audit.** The next audit confirms Level 1 and can now plant faults in api.

### Steps for Fix the stale agent instructions

1. **Fix each listed item.** `.cursor/skills/release-notes/SKILL.md:8` `npm run changelog`: no "changelog" script in package.json; `AGENTS.md:7` `pnpm test`: uses pnpm, but the repo uses npm; `AGENTS.md:8` `docs/architecture.md`: docs/architecture.md doesn't exist
2. **Prove it.** `readiness run --instructions` replays every command and checks every path.

### Steps for Make worker's tests catch wrong behavior

1. **Decide the intended behavior.** For the files named here, write down what correct behavior is, including edge cases.
2. **Write tests that pin it down.** Assert results and edge cases, not just that code runs.
3. **Prove it with fresh faults.** Run a new audit. It plants different faults than this one, so tests aimed at one audit's faults don't help.
4. **Review.** `readiness diff` flags any deleted test or new skip marker, so nothing was weakened to pass.

### Everything we checked, and why

| Check | Why it matters | Result | Evidence |
|---|---|---|---|
| Components and where changes land (`scope.profile`) | Levels follow the work, so the audit finds each package and its share of recent changes. | 4 components found, 3 assessed |  |
| Agent assets in the repo (`scope.agent_assets`) | Shows what agent setup already exists and who maintains it. Not scored. | 3 assets, 3 authors |  |
| Setup works from a clean checkout (`bootstrap.cold_replay`) | Every agent starts from a clean checkout, so setup that only works on a prepared machine breaks every agent run. In the BootstrapAgent study, a reusable, verified setup cut later agents' token use by 25.9% and build time by 22.3%. Measured on the study's benchmark repositories. ([source](https://arxiv.org/abs/2605.15815)) | **failed: api**; passed: shared and worker | `ev-005`, `ev-006`, `ev-007`, `ev-009`, `ev-011`, `ev-013` and 1 more |
| Build, lint, type-check and test commands pass (`verify.canonical_interface`) | Agents need one known way to check their own work. | **failed: api**; passed: shared and worker | `ev-008`, `ev-009`, `ev-010`, `ev-011`, `ev-012`, `ev-013` |
| Tests catch planted faults (`verify.behavioral_oracle`) | Green tests aren't proof that a change is right. In DeployBench, 53.9% of failed runs passed generic checks and failed only task-specific ones. 51 research-artifact deployment tasks. ([source](https://deploybench.vercel.app/)) OpenAI estimated about 30% of SWE-Bench Pro's 731 public tasks were broken, including low-coverage tests that let incomplete fixes pass. An audit of one benchmark, not of customer repositories. ([source](https://openai.com/index/separating-signal-from-noise-coding-evaluations)) | api: tests must pass before faults can be planted; shared: caught 5 of 5 planted faults; worker: caught 0 of 5 planted faults | `ev-015`, `ev-016`, `ev-017` |
| Agent instructions are accurate (`context.instructions_verified`) | Agents follow AGENTS.md, rules and skills literally, so a stale command costs more than a missing one. No outcome study yet measures how much these files help. | 4 of 7 instruction items check out, 3 wrong | `ev-001`, `ev-002`, `ev-003`, `ev-018`, `ev-019` |
| Normal work needs no production access (`safety.execution_boundary`) | Agents run with whatever access setup gives them, so normal work must never need production credentials. | passed | `ev-004` |

Not assessed by this rubric version, which is different from unknown: whether CI matches the local commands, flaky tests, the quality of error messages, how easily code can be found and outcome checks on held-out tasks.

### Levels by component

Repo shape: monorepo. Each component gets one standard level; scenarios someone added appear under the components they cover.

| Component | Path | Toolchain | Manifest | Lockfile | Share of changes | Level |
|---|---|---|---|---|---|---|
| `api` | `packages/api` | Node | `packages/api/package.json` | none | 56% | 0 Not bootable |
| `shared` | `packages/shared` | Node | `packages/shared/package.json` | none | 15% | 1 Bootable |
| `worker` | `packages/worker` | Node | `packages/worker/package.json` | none | 27% | 1 Bootable |
| `infra` | `infra` | Terraform | none | none | 2% | not assessed: Terraform isn't supported by this rubric |

Repo level: 0 Not bootable. The repo level is the lowest level among active components, the assessed components with at least 10% of changes over 90 days; a component joins or leaves that set only after two audits on the same side of the line, and components the audit can't assess never set it.

What holds the repo at Level 0:

- `api`: passes every test in a clean container, not met (test failed: connection refused on port 5432 (1 of 1 tests failed)).

- **Standard level:** Level 1 needs: installs from the lockfile in a clean container, builds in a clean container and passes every test in a clean container. Level 2 needs: build, lint, type-check and test commands pass, tests catch planted faults, agent instructions are accurate and normal work needs no production access.

### Agent PR outcomes

Sep 27 to Oct 27, 2026. Agent PRs are matched by head branch starting with cursor/. Source: a recorded PR file.

| Measure | Agent PRs | Other PRs |
|---|---|---|
| Opened | 9 | 41 |
| Merged | 78% (7 of 9) | 85% (35 of 41) |
| Passed CI the first time | 33% (3 of 9) | 71% (29 of 41) |
| Reviewer requested changes | 44% (4 of 9) | 17% (7 of 41) |
| Median days to merge | 2 | 2 |

| Component | Agent PRs | Passed CI the first time | Changes requested |
|---|---|---|---|
| `api` | 5 | 20% (1 of 5) | 40% (2 of 5) |
| `shared` | 2 | 2 of 2 (too few for a rate) | 0 of 2 (too few for a rate) |
| `worker` | 3 | 1 of 3 (too few for a rate) | 2 of 3 (too few for a rate) |

1 agent PR touched more than one component, so the component rows can add up to more than the total. A baseline, not proof that readiness explains these numbers. Model updates and the mix of tasks move them too.

Matched PRs: #201, #203, #206, #209, #212, #214, #217, #219, #221.

### Agent assets already in the repo

| Asset | Path | Authors | Last changed | Status |
|---|---|---|---|---|
| rules | `.cursor/rules/style.mdc` | Contributor A | Jun 29 | Replays |
| skill | `.cursor/skills/release-notes/SKILL.md` | Contributor A, Contributor C | Sep 17 | 1 stale item |
| agents_md | `AGENTS.md` | Contributor A, Contributor B | Sep 27 | 2 stale items |

Missing: an environment setup and hooks.

### Other signals (informational, not scored)

| Signal | Found | Detail |
|---|---|---|
| CI config | yes | .github/workflows/ci.yml, and it runs tests |
| A way to run one test file | yes | api: node --test takes file paths; shared: node --test takes file paths; worker: node --test takes file paths |
| Sample env file | n/a | the code reads no environment variables of its own |
| Worktree and port isolation | yes | no fixed ports or machine-specific absolute paths in the setup and scripts |
| AGENTS.md length | yes | 42 words |

These don't set a level or add a roadmap step.

### Evidence log

<details><summary>All evidence</summary>

| ID | Check | Component | What ran | Where | Result |
|---|---|---|---|---|---|
| `ev-001` | `context.instructions_verified` | repo | .cursor/skills/release-notes/SKILL.md:8 `npm run changelog`: no "changelog" script in package.json | read from files | fail: .cursor/skills/release-notes/SKILL.md:8 `npm run changelog`: no "changelog" script in package.json |
| `ev-002` | `context.instructions_verified` | repo | AGENTS.md:7 `pnpm test`: uses pnpm, but the repo uses npm | read from files | fail: AGENTS.md:7 `pnpm test`: uses pnpm, but the repo uses npm |
| `ev-003` | `context.instructions_verified` | repo | AGENTS.md:8 `docs/architecture.md`: docs/architecture.md doesn't exist | read from files | fail: AGENTS.md:8 `docs/architecture.md`: docs/architecture.md doesn't exist |
| `ev-004` | `safety.execution_boundary` | repo | no blocking findings; 0 items listed for review | read from files | pass: no blocking findings; 0 items listed for review |
| `ev-005` | `bootstrap.cold_replay` | repo | toolchain pinned in .nvmrc | read from files | pass: toolchain pinned in .nvmrc |
| `ev-006` | `bootstrap.cold_replay` | repo | node --version && npm --version | ran in a clean container | pass: doctor passed |
| `ev-007` | `bootstrap.cold_replay` | repo | npm ci | ran in a clean container | pass: install passed |
| `ev-008` | `verify.canonical_interface` | api | npm run lint | ran in a clean container | pass: lint passed |
| `ev-009` | `bootstrap.cold_replay` | api | npm run test | ran in a clean container | fail: test failed: connection refused on port 5432 (1 of 1 tests failed) |
| `ev-010` | `verify.canonical_interface` | shared | npm run lint | ran in a clean container | pass: lint passed |
| `ev-011` | `bootstrap.cold_replay` | shared | npm run test | ran in a clean container | pass: test passed (3 of 3 tests) |
| `ev-012` | `verify.canonical_interface` | worker | npm run lint | ran in a clean container | pass: lint passed |
| `ev-013` | `bootstrap.cold_replay` | worker | npm run test | ran in a clean container | pass: test passed (2 of 2 tests) |
| `ev-014` | `bootstrap.cold_replay` | repo | frozen install reproduced the lockfile | ran in a clean container | pass: frozen install reproduced the lockfile |
| `ev-015` | `verify.behavioral_oracle` | api | tests must pass before faults can be planted | not run | not_run: tests must pass before faults can be planted |
| `ev-016` | `verify.behavioral_oracle` | shared | caught 5 of 5 planted faults (tried: drop_throw_or_return, change_constant, negate_condition) | ran in a clean container | pass: caught 5 of 5 planted faults (tried: drop_throw_or_return, change_constant, negate_condition) |
| `ev-017` | `verify.behavioral_oracle` | worker | caught 0 of 5 planted faults; missed: change_constant at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9,  | ran in a clean container | fail: caught 0 of 5 planted faults; missed: change_constant at packages/worker/src/retry.js:2, change_constant at packages/worker/src/retry.js:9, change_constant at p |
| `ev-018` | `context.instructions_verified` | repo | npm run lint -w api | ran in a clean container | pass: .cursor/rules/style.mdc:6 `npm run lint -w api` replays |
| `ev-019` | `context.instructions_verified` | repo | npm run test -w shared | ran in a clean container | pass: AGENTS.md:6 `npm run test -w shared` replays |

</details>

Evidence strength, weakest to strongest: stated in docs, read from files, ran on host, ran in a clean container, confirmed by outcomes. A check passes only at its required strength.

### Audit record

- **Audit:** aud-2026-10-27-7070f44-e101
- **Commit:** 7070f44 (clean tree)
- **Rubric:** 2026-10-alpha
- **Permission tier:** local-exec
- **Seal:** Scripts match the agent-readiness-v0.1.0 manifest bundled with this copy; the published release isn't checked here
- **Skill digest:** 38b6a0a90a39
- **Planted faults:** seed pinned (eval run; not a production result)
- **Replay environment:** docker container, node:22-bookworm-kernel-mirror
- **Stored in:** .agent-readiness/history/audits/aud-2026-10-27-7070f44-e101
