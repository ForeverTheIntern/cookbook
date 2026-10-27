# Foreman watches the pull request until it merges

Verify passing is not the end of a pull request's review. Bugbot, Cursor's security reviewer, a person's change request and CI all happen after that, and each of them needs to reach a step.

So the run stays at `awaiting_merge` and Foreman reads the pull request on every reconcile: reviews, unresolved review threads and check runs at the head commit. It is woken by `pull_request_review`, `pull_request_review_comment`, `pull_request` `synchronize`, and completed `check_run` and `check_suite` deliveries, and the tick covers missed ones.

- **What sends work back.** An unresolved, not outdated thread from a bot in `review.bots` (default `cursor`, which is how Bugbot and the security reviewer post), a "changes requested" review from a person or an allowlisted bot, and a failed check. Each finding is handled once. They go to Implement as feedback, then Review and Verify run again.
- **What doesn't.** Other bots, a person's plain review comment, and Foreman's own reviews. A person who wants a change says so with "Request changes".
- **The cap.** The same three send-backs as Review and Verify. Past it, Foreman stops and asks the requester in the status thread.
- **CI.** "Ready to merge" waits until no check is queued or running and none failed. The pull request stays a draft until then.
- **Pushes.** A new commit after verify, from anyone, sends the run back to Review (or Verify, with Review off), so the evidence matches the code that merges.

Foreman stops watching when the pull request merges or closes, or the run is abandoned. It never merges, resolves threads or pushes itself.
