# Evals

Two suites check the skill against more than its fixtures.

- **Skill evals** (`npm run evals`) run the real Cursor agent on each fixture with a pinned prompt and grade what the scripts wrote. The [README](../README.md#skill-evals) covers the drivers and the flags. [HILLCLIMB.md](HILLCLIMB.md) logs every round and every field run.
- **Public goldens** (`npm run goldens`) run the scripts alone, with no agent, on pinned public repositories. They check that the levels rank those repos in the expected order and that no report claims a config, script or path its tree doesn't have.

## Public goldens

### How the repos were chosen

The plan was to draw candidates from the readiness scanner's 51 pinned real-world repos. That list (`anysphere/solution-accelerators`, `softwarefactory/readiness/evals/realworld/labels.json`) isn't readable from this account, so the repos below are well-known public projects picked against the same bar:

- a permissive license;
- a clean-container install and test run in about 5 minutes, with no secrets needed to boot;
- together, a span from low to high readiness;
- together, coverage of JS/TS, Python, Go, .NET and one monorepo with nested apps.

Each is pinned at a full commit SHA in [goldens/goldens.json](goldens/goldens.json). The audit's clock is set to the day after that commit, so change shares are the same on every run. The planted-fault seed is fixed per repo.

| Golden | Repo at SHA | License | Toolchain | Why it's in the set | Level at pinning |
|---|---|---|---|---|---|
| `slugify` | [sindresorhus/slugify](https://github.com/sindresorhus/slugify/tree/3b17b2e84b97624a683aafaa38184bf2746fab22) `3b17b2e` | MIT | JS | A small, well-tested npm package with no services and no secrets: the high end | 2 |
| `starlette` | [encode/starlette](https://github.com/encode/starlette/tree/2745bbc5afa2f8ce900d290bedca2bc5d3f3cfe8) `2745bbc` | BSD-3-Clause | Python | Installs with uv from a lockfile and runs about 1,400 pytest tests, including file-permission tests that pass only as an ordinary user | 2 |
| `express` | [expressjs/express](https://github.com/expressjs/express/tree/1c6f1b0fe4000977b9a7b4f34097e4d527dd9824) `1c6f1b0` | MIT | JS | A widely used package whose tests require a folder; one stale command in its docs holds it at Level 1: the middle | 1 |
| `create-t3-turbo` | [t3-oss/create-t3-turbo](https://github.com/t3-oss/create-t3-turbo/tree/8f945b7bb3bfb3ca8358d48b1ff0214079bc11ee) `8f945b7` | MIT | TS, pnpm | A Turborepo monorepo with nested apps (Expo, Next.js, TanStack Start) and shared packages, with config packages under `tooling/`. No app has a test command: the low end | 0 |
| `uuid` | [google/uuid](https://github.com/google/uuid/tree/2d3c2a9cc518326daf99a383f07c4d3c44317e4d) `2d3c2a9` | BSD-3-Clause | Go | Must be listed as not assessed (Go), with no level and no claims | not assessed |
| `serilog` | [serilog/serilog](https://github.com/serilog/serilog/tree/43105b35095337d77f022561a8f2d3db2f9a7937) `43105b3` | Apache-2.0 | .NET | Must be listed as not assessed (.NET) under its solution, with no level and no claims | not assessed |

### What is asserted

- **Order, not scores.** `rank` in `goldens.json` lists tiers from highest to lowest. Every component in a tier must sit strictly above every component in the next one; there is no order within a tier, and no exact level is asserted. The expected order is:
  1. `slugify` and `starlette`;
  2. above `express`;
  3. above `create-t3-turbo`'s `nextjs` and `ui`.
- **Components.** Each golden names the components it must assess, and the unsupported ones it must list as not assessed, with their toolchain.
- **No claims outside the tree.** [lib/claims.ts](lib/claims.ts) checks every path, manifest, lockfile, agent asset, toolchain pin, CI config and contract script the report states as present against the files git tracks at the audited commit. A path the report quotes as missing, such as a stale instruction's target, isn't a claim of presence. The same check runs in the skill evals' report gate.

`npm run goldens` needs network access and Docker or Podman, so it isn't part of `npm run check`. Use `-- --only slugify,uuid` for a subset and `-- --keep` to keep the clones. Each run writes [goldens/last-run.json](goldens/last-run.json). Offline, `tests/goldens.test.ts` checks the manifest against the selection bar, the ranking rule and the claims check.

### Runtime

Install and test fit the 5-minute bar for every repo. Planting faults reruns a repo's tests once per fault, so `express`, with a large test suite, takes about 11 minutes in all. `starlette` takes about 5, `create-t3-turbo` about 4, and the rest under a minute.

### What the goldens found

The first passes surfaced bugs in the audit's own environment, not in the repos. Each is fixed, with a test:

- **Folder imports crashed planting faults.** express's tests require a folder, and the replay died with EISDIR. Fixed in `mutate.ts`.
- **uv projects ran in an image without uv,** and the tests pointed at the wrong virtualenv. uv projects now use `ghcr.io/astral-sh/uv` and `.venv`.
- **The container ran as root,** so starlette's permission tests failed. The repo's commands now run as the host user, as in CI. The repo's own declared setup keeps its image's user.
- **A root-level `test.js` wasn't read as a test file,** so no faults could be planted in slugify. The headline also blamed the machine for it. Both are fixed.
- **Native npm builds need python3 and a compiler,** which the slim Node image lacks. Node repos now use the full `node:<major>-bookworm` image, like a CI runner.
- **Config packages listed as workspace members were components.** Members under `tooling/` and similar folders are now satellites.

The first monorepo candidate, [GoogleCloudPlatform/microservices-demo](https://github.com/GoogleCloudPlatform/microservices-demo), was dropped. Its Python services need `python3-venv`, which the Node image lacks. The audit now adds it when apt is reachable, but this machine's network blocks the Debian mirrors.
