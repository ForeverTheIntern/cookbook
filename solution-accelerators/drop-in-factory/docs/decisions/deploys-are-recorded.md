# Hosted deploys are recorded

`bdk deployment get` reports the release id, status and secret names of a hosted deployment, but not the repository, ref or commit it was built from. So "the hosted Foreman runs this code" can't be read from BDK.

`npm run deploy` closes that gap. It refuses to deploy unless the factory folder is committed and the remote branch is at HEAD, deploys with an explicit `--repo`, `--ref` and `--path`, and appends a record to `setup/verdicts/deploys.jsonl`: the release id, the team, `repo@sha`, and a sha256 digest of `git ls-tree -r` over the folder (without `setup/verdicts/`). With `SA_VERIFY_HOSTED=1`, `npm run doctor` checks that the running release is the last recorded one and that its digest matches this folder at HEAD, and that the deployment has the secrets the factory reads.

The digest covers file contents, not commits, so a copy of the folder in another repository, a mirror or a subtree split verifies the same. Comparing commit SHAs would not work: `deployment get` returns no commit, and a mirror or subtree split rewrites SHAs.

Verdicts are committed to `setup/verdicts/ledger.jsonl` with a markdown twin, keyed by the newest commit outside `setup/verdicts/`, so committing a verdict or a deploy record does not void the row it records.
