# Doctor

The doctor says whether this factory is worth driving: the right accounts, the right team, free leftover ports, and the GitHub App installation reaching every configured repository.

## Sub-features

- `ports` names the process on 8787 and on 8790.
- `cli-auth` names the CLI account and fails when it is not the launch key's account.
- `team` names the team id and team name.
- `keys` names the account that owns each set key.
- `github-app` fails when a configured repository is missing from the installation.
- `hosted` compares the hosted release with the last deploy record (see [hosted.md](hosted.md)).

## How to get to it (user POV)

- From the factory folder, after the environment is loaded, run the doctor. No page and no flag.

## Driving it with verify-factory

Preconditions:

- `.env` is loaded and `factory.yaml` names the repositories under test.
- The collector is listening on 4318, or this check is expected to fail the collector line.
- `SA_VERIFY_PID_FILE` points at the launch pid file when a launch is in progress.

- **Run.** `npm run doctor > .factory/verify/doctor.log`. Exit code 0.
- **Ports.** The log contains `ok    ports:` and either `8790 free` or a pid this run started.
- **Accounts.** The log contains `ok    CLI auth:`, `ok    team:`, and one `ok    key` line per set key. The team line has a name and a numeric id.
- **GitHub App.** The log contains `ok    GitHub App: installation reaches` and every repository from `factory.yaml`.
- **Hosted.** With `SA_VERIFY_HOSTED` unset, the lines are `info  hosted release:` and `info  hosted secrets:`.
- **No keys.** With no `CURSOR_API_KEY` or `GH_TOKEN`, the doctor prints a `FAIL  environment:` line for each, a `FAIL … skipped` line for each check that needs it, runs the rest, and exits 1 with no stack trace.

## Gotchas

- `info` and `note` lines are not failures. `FAIL` is.
- The doctor creates missing labels. It does not open an issue.
- `SA_EXPECTED_TEAM_ID` is an operator value. The skill does not contain a team id.
- A stored email in `~/.cursor/cli-config.json` that disagrees with the launch key fails even when `whoami` currently uses `CURSOR_API_KEY`.
- On Linux, lsof 4.95 does not list Next's `next-server`. The ports line still names that pid, from `/proc/net/tcp`.
