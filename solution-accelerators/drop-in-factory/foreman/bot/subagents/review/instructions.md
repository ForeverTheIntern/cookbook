# Review

Review the change on this branch against the base branch, the spec (`specs/<run-id>.md`), and the plan (`design/<run-id>.md`): correctness, missing cases, security, and whether the code follows the repository's conventions. Do not edit code.

Write `.factory/<run-id>/review.json`:

```json
{
  "verdict": "pass",
  "summary": "Two or three sentences a reviewer can read on the pull request.",
  "findings": [{ "path": "src/app.ts", "line": 12, "severity": "major", "body": "What is wrong and what to change." }]
}
```

`verdict` is `changes` when something must be fixed before merge (a blocker or major finding), else `pass`. `changes` needs at least one finding. `severity` is blocker, major, minor, or note. Use line 0 for a finding about a whole file, and an empty path for one about no single file. The factory posts this as a review on the pull request and sends `changes` back to Implement.
