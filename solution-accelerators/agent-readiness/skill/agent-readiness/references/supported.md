# What the audit supports

What the scripts recognize, and what happens with anything they don't. The checks themselves are described in [checks.md](checks.md).

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
