# Hosted deploy

The hosted checks compare the running `foreman` release with the last `npm run deploy` record, and its secret names with the ones the factory reads. They read the deployment; they do not deploy.

## Sub-features

- `flag` leaves both lines as info while `SA_VERIFY_HOSTED` is unset.
- `release` reads `deployment get` and fails when its `releaseId` is not the last record in `setup/verdicts/deploys.jsonl`, or when that record's file digest differs from this folder at HEAD.
- `secrets` fails when the deployment lacks `SA_GH_TOKEN`, `SA_CURSOR_API_KEY`, or `FOREMAN_SLACK_BOT_TOKEN` (with a slack block).

## How to get to it (user POV)

- The operator deploys with `npm run deploy`, commits `setup/verdicts/deploys.jsonl`, sets the flag, then re-runs the doctor. There is no local button.

## Driving it with verify-factory

Preconditions:

- `SA_VERIFY_HOSTED=1`.
- `SA_DEPLOYMENT_SLUG` is the deployment's slug. The default is `foreman`.
- The CLI credential is the account that owns the deployment. Doctor's `CLI auth` and `team` lines already passed.
- The deploy under test was made with `npm run deploy` from this checkout's pushed branch.

- **Compare.** `npm run doctor`. The line `ok    hosted release:` names the release and `repo@sha` from the record and says the files match HEAD.
- **Secrets.** The line `ok    hosted secrets:` lists every required name.
- **Verdict.** `npm run verdict -- append --pr <n> --verdict live-verified --verifier "<agent, model>" --evidence "<paths>" --note "hosted release matches HEAD"`. The deployed release and team come from the deploy record.

## Gotchas

- With the flag unset both lines are `info`, and a verdict for the hosted path is `blocked`, not `live-verified`.
- `deployment get` reports no commit; only the deploy record ties a release to its source. A release made with `bdk deploy` directly fails as unrecorded.
- The digest covers file contents and skips `setup/verdicts/`, so a copy of the folder in another repository verifies the same, and committing the record changes nothing.
- A deploy failing with "not accessible through this team's installation" is a failed GitHub App check for the team. Do not deploy again to see it a second time.
