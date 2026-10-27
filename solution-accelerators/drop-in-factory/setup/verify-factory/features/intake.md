# Intake

Labeling an issue is how an operator starts a run. Foreman claims it with a comment and a run id. That claim is the start of the pipeline.

## Sub-features

- `open` creates one issue whose body says `Opened by verify-factory.`
- `label` adds the repository's intake label.
- `claim` waits until Foreman's claim comment names `factory/f-<key>-<issue>`.

## How to get to it (user POV)

- Launch is ready and the doctor exited 0.
- The operator runs the drive command. The issue appears on GitHub with the intake label, then a factory comment.

## Driving it with verify-factory

Preconditions:

- `npm run verify -- launch` has printed `ready`.
- `npm run doctor` exited 0.
- `SA_VERIFY_DRIVE=1`.
- `SA_VERIFY_REPO` is a repository from `factory.yaml`, or it is unset and the first repository is the one to use.

- **Drive.** `npm run verify -- drive`. It prints `opened owner/name#N` and then `claimed factory/f-<key>-N`.
- **Confirm.** `gh issue view N --repo owner/name --comments` shows `started by this factory` and `<!-- factory:claim`. `.factory/verify/drive.json` has the same issue number and branch.
- **Stop.** `npm run verify -- cleanup` closes that issue, deletes the run branch, and stops a cloud agent on that branch. Do not merge.

## Gotchas

- A timeout leaves the issue open. `started.json` is already written. Cleanup closes it. Do not open a second issue first.
- The claim is not a merged pull request. Gates stay for a person on GitHub. This journey does not approve them.
- Two Foremen on the same repository can both claim. The earliest claim wins. Drive against the Foreman this launch started.
- A hosted Foreman takes issues that carry its intake label. A local proof uses a different label in a git-ignored `SA_FACTORY_CONFIG`, or it starts a run the hosted Foreman would have taken.
