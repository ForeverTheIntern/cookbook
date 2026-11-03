# What the audit supports

A running list of the stacks and machines the audit has been checked on, and of what the scripts do with tools and files they recognize. The checks themselves are described in [checks.md](checks.md). Every entry sits in one tier and names the fixture (under `fixtures/` in the accelerator) or the pinned public repo that shows how the audit behaves on it. `scripts/lib/support.ts` holds the same list, and a test fails when the two drift apart.

- **Supported:** the audit installs, builds and tests it, and gives a level.
- **Not yet supported:** the scan recognises it and gives no level for it, because a specific piece is missing. The report says "isn't supported yet" with the reason, and links here.
- **Not assessed:** the scan lists it by name with its share of recent changes, and gives no level. The audit has no install, test or planted-fault support for it. For a machine, nothing has proved how the audit behaves on it.

A component outside the supported tier never sets the repo level. When it holds a share of recent changes, part 1 of the report says how much. The sections after the tiers say how supported tools, agent assets and services are handled: lint and format tools run check-only, vendored skills are skipped, and the environment draft starts Postgres and Redis. Anything not listed here hasn't been tried: the scan may not recognise it, so check part 4 of the report for what it found.

## Supported

| Id | Stack or machine | What the scan looks for | Notes | Proven by |
|---|---|---|---|---|
| `npm` | Node with npm | `package.json`, with `package-lock.json` for a frozen install | | `fixtures/healthy-node`, `sindresorhus/slugify@3b17b2e` |
| `npm-workspaces` | npm workspaces | `workspaces` in the root `package.json` | | `fixtures/monorepo-mixed`, `fixtures/sampled-scope` |
| `pnpm` | Node with pnpm | `pnpm-lock.yaml`, `pnpm-workspace.yaml` or a `pnpm@` pin | | `fixtures/standalone-nested-mixed`, `t3-oss/create-t3-turbo@8f945b7` |
| `yarn` | Node with Yarn 1 | `yarn.lock` from Yarn 1, or a `yarn@1` pin | | `fixtures/yarn-classic` |
| `pip` | Python with pip | `requirements.txt`, `pyproject.toml` or `setup.py` | | `fixtures/python-unpinned` |
| `uv` | Python with uv | `uv.lock` in a single project | | `encode/starlette@2745bbc` |
| `docker` | Docker | `docker info` | | `tests/fixtures.test.ts` |
| `host-fallback` | No container runtime on Linux or macOS | no Docker or Podman answers | setup runs in a scrubbed copy on the host, so Level 1 can't be proved there | `fixtures/declared-image-missing-toolchain`, `fixtures/sudo-start` |

A repo with more than six supported components is sampled: the six with the largest share of recent changes are assessed, and the rest are listed with their share as left out. Part 1 says what the level doesn't cover, and confidence drops to medium (`fixtures/sampled-scope`).

## Not yet supported

| Id | Stack or machine | What the scan looks for | Why not yet | Proven by |
|---|---|---|---|---|
| `poetry` | Poetry | `poetry.lock`, or `[tool.poetry]` in `pyproject.toml` | the audit's Python image has no Poetry | `fixtures/poetry-only`, `python-poetry/cleo@fd264ef` |
| `bun` | Bun | `bun.lock`, `bun.lockb` or a `bun@` pin | the audit has no frozen Bun install and its images have no Bun | `fixtures/bun-lock`, `elysiajs/elysia@e037eca` |
| `yarn-berry` | Yarn 2 or later | a `yarn@2` or later pin, `.yarnrc.yml`, or a Berry `yarn.lock` | the audit only runs Yarn 1's frozen install | `medusajs/medusa@e8762ca` |
| `uv-workspace` | A uv workspace | `[tool.uv.workspace]` in a `pyproject.toml` | members need the root uv.lock and its dependency groups | `fastapi/full-stack-fastapi-template@f4bcfab` |
| `python-behind-root-package` | A Python app next to a root package.json | a root `pyproject.toml`, `setup.py` or `requirements.txt` beside a root `package.json` | the audit runs one image per repo, and it picks Node's | `fixtures/python-behind-root-package`, `saleor/saleor@dfbf139` |
| `task-graph` | A package that needs a sibling package built first | a build or test that fails because a sibling workspace package's module is missing | the audit builds packages one by one, not in Turbo's or Nx's order | `fixtures/turbo-depends-on-build`, `spree/spree@cdd9a02` |
| `windows` | Windows without Docker or Podman | `process.platform` is `win32` and no container runtime answers | the host fallback runs bash; run the audit in WSL 2 or with Docker Desktop | `tests/supported.test.ts` |

A Python, PHP or Ruby app next to a root `package.json` is listed with its own share of changes. When the root package has no tests of its own, it isn't assessed either, so the audit never says the repo "has no tests" because it looked only at release tooling. A sibling package that wasn't built first, and a network, TLS or proxy error or a package mirror's HTTP error during install or build, are reported as blocked, never as a repo defect.

## Not assessed

| Id | Stack or machine | What the scan looks for | Notes | Proven by |
|---|---|---|---|---|
| `go` | Go | `go.mod`, or `.go` files in a top-level folder | | `fixtures/unsupported-go-service`, `google/uuid@2d3c2a9` |
| `rust` | Rust | `Cargo.toml`, or `.rs` files in a top-level folder | | `BurntSushi/ripgrep@91f5d22` |
| `jvm` | JVM | `pom.xml`, `build.gradle` or `build.gradle.kts`, or `.java`, `.kt` or `.scala` files | | `spring-projects/spring-petclinic@500158f` |
| `dotnet` | .NET | `.sln`, `.csproj`, `.fsproj` or `.vbproj`, or `.cs` or `.fs` files | | `fixtures/nested-apps-dotnet`, `fixtures/standalone-nested-mixed`, `ShareX/ShareX@12d6342` |
| `ruby` | Ruby | `Gemfile`, or `.rb` files in a top-level folder | | `spree/spree@cdd9a02` |
| `php` | PHP | `composer.json`, or `.php` files in a top-level folder | | `laravel/laravel@def7ce1` |
| `swift` | Swift | `Package.swift`, or `.swift` files in a top-level folder | | `fixtures/swift-package`, `apple/swift-argument-parser@38ca4ec` |
| `dart` | Dart | `pubspec.yaml`; a workspace's root `pubspec.yaml` lists its packages instead | | `fixtures/dart-packages`, `dart-lang/http@8c0d66a` |
| `terraform` | Terraform | a folder of `.tf` files at any depth, the root module included | | `fixtures/terraform-modules`, `fixtures/monorepo-mixed`, `terraform-aws-modules/terraform-aws-vpc@b3abd6d` |
| `podman` | Podman | `podman info` | the audit drives it like Docker, but no fixture run has used it | none yet |

A .NET repo with several root solutions is named after the solution that matches the repo's name, or after the repo, never after whichever solution sorts first.

Folders named `examples`, `samples`, `tests`, `bench`, `tooling` and the like, and packaging or platform folders such as `HomebrewFormula`, `pkg`, `packaging`, `android` and `ios`, are satellites: part 4 lists them, and they never become components while the repo has anything else to assess.

## Lint and format tools run check-only

Lint and type-check commands run without their write flags, so they report problems instead of rewriting the copy the audit plants faults in. A script call such as `npm run lint` is inlined, including the package scripts it calls, and run with the package's binaries on `PATH` (`npm exec -c`, `pnpm exec`, `yarn exec`).

| Tool | What the audit runs instead |
|---|---|
| any tool | removes `--fix`, `--write`, `--fix-type`, `--unsafe-fixes`, `--apply` and `--apply-unsafe` |
| Biome | also removes `--unsafe` |
| Prettier | `--check` in place of `--write` or `-w` |
| Ruff | `ruff format --check` in place of `ruff format` |
| Black | `black --check` |
| isort | `isort --check-only` |
| dprint | `dprint check` in place of `dprint fmt` |
| SQLFluff | `sqlfluff lint` in place of `sqlfluff fix` |

Anything else that still changes the repo's files fails the commands condition ("it changed N files, so it rewrites code instead of checking it"), and the files are put back before faults are planted. A tool that only writes through a config file setting, such as a formatter configured to fix on run, is caught this way rather than by name.

## Vendored agent skills

Commands in a third-party skill copied into `.agents/skills`, `.claude/skills` or `.cursor/skills` are listed as skipped and never run, because they document that tool, not this repo. A skill counts as vendored when:

- `skills-lock.json` at the repo root lists it, as the `skills` CLI writes;
- a `LICENSE` file ships in its folder, or its frontmatter has a `license` field; or
- its frontmatter names a `source`, `repository` or `upstream`.

A first-party skill has none of these, and its commands are checked and replayed like any other instruction. The same skill reached twice, through a symlink or as an identical copy, is checked once.

## Services tests need

When tests fail because nothing answers on a local port, the diagnosis names the service: Postgres (5432), MySQL (3306), Redis (6379), MongoDB, Elasticsearch, RabbitMQ, Kafka or Memcached. `readiness draft-env --remediate` drafts install and start scripts for Postgres and Redis. It takes them from the diagnosis and from the images in a root `compose.yml` or `docker-compose.yml`, and starts them without Docker, since an agent's machine may have none. When the repo has a `.env.example`, the install script copies it to `.env` if there is none. `--service postgres,redis` replaces both lists.

| Service | Drafted by `draft-env` | Proven by |
|---|---|---|
| Postgres | yes: apt's `postgresql`, started and waited for with `pg_isready` | `fixtures/hidden-service`, `fixtures/compose-services` |
| Redis | yes: apt's `redis-server`, started and waited for with `redis-cli ping` | `fixtures/compose-services` |
| MySQL, MongoDB, Elasticsearch, RabbitMQ, Kafka, Memcached | no: diagnosed only | none yet |

The drafted install uses apt, so the audit proves it only where Debian's package mirrors are reachable.

## Adding an entry

1. Add a fixture under `fixtures/` that shows the behaviour, or pin a public repo at a SHA.
2. Add the entry to `scripts/lib/support.ts` and to the matching table here, in the same tier, with the same reason and proof.
3. Moving an entry to **Supported** needs a fixture or repo whose audit gives the expected level.
