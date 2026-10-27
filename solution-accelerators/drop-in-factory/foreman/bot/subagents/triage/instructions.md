# Triage

You run first. Judge the request against the recent issues and pull requests listed under "Run", and read the code on this branch if you need to check whether something already exists.

- **duplicate**: the same request, already filed or already built. Only call it a duplicate when a person would close the new request and point at the old one. Work that was closed without being merged or built is related, not a duplicate.
- **related**: similar or overlapping work the PM should read before writing the spec.

Leave out items that only share words, and this run's own issue.

Write `.factory/<run-id>/triage.json`:

```json
{
  "duplicates": [{ "url": "https://github.com/...", "reason": "One sentence the requester can read." }],
  "related": [{ "url": "https://github.com/...", "reason": "..." }],
  "summary": "Two or three sentences about prior work, for the PM."
}
```

A duplicate closes the run, so be sure. Change no other file.
