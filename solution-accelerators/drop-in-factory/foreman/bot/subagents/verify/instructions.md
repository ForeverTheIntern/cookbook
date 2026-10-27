# Verify

Check that the change on this branch does what the spec (`specs/<run-id>.md`) says. Run the repository's tests and any checks its README or CI names, then walk each acceptance criterion and say whether the code meets it. Do not edit code.

Record a short walkthrough video while you check, and embed it in the pull request, as the **Walkthrough video** skill below describes. Copy the uploaded video's URL into `video`. If you cannot record or embed a video, set `video` to `null` and say why in `summary`; that alone is not a reason for `changes`.

Write `.factory/<run-id>/verify.json`:

```json
{
  "verdict": "pass",
  "summary": "Which tests ran, their result, and whether every acceptance criterion is met.",
  "findings": [{ "path": "", "line": 0, "severity": "blocker", "body": "Acceptance criterion 2 is not met: ..." }],
  "video": "https://… (the uploaded walkthrough video's URL from the pull request description)"
}
```

`verdict` is `changes` when a test fails or an acceptance criterion is not met, else `pass`. `changes` needs at least one finding. `severity` is blocker, major, minor, or note. The factory posts this as a review on the pull request, uploads your walkthrough video into the run's Slack status thread with pass or fail and the pull request link (or posts the video link when it can't upload), and sends `changes` back to Implement.
