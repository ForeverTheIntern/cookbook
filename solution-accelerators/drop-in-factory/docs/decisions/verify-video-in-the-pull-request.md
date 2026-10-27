# The verify walkthrough lives in the pull request, and plays in Slack

The verify role records a short walkthrough video and embeds it in the pull request description the way any cloud agent embeds an artifact: a `<video src="/opt/cursor/artifacts/…">` tag passed to the agent's pull-request tool, which uploads the file and rewrites the `src` to a public URL. Verify copies that URL into `verify.json` as `video`. Foreman adds the link to its review on the pull request.

In Slack, Foreman uploads the mp4 into the run's status thread so Slack's own player shows it: it reads the file from the verify agent's artifacts through the Cloud Agents API (`/v1/agents/{id}/artifacts`), then calls `files.getUploadURLExternal` and `files.completeUploadExternal` with the thread's `thread_ts`. Pass or fail and the pull request link go in the same message. A plain link to a private pull request unfurls into nothing, which is why the upload is worth it.

If the agent saved no mp4, the file is over the upload limit, or the upload fails (for example, a Slack app without `files:write`), Foreman posts the link instead: the `video` from `verify.json`, else the first `<video src="https://…">` or `.mp4`, `.webm` or `.mov` link in the pull request description, else a line saying no video was recorded with a link to the verify agent. A missing video never holds a run or fails verify.

The upload needs `files:write` on the Slack app (in both manifests, and checked by the doctor) and, when hosted, `files.slack.com` and the artifact bucket `agent-stores.s3.us-east-1.amazonaws.com` in `hosting.egressDomains`.
