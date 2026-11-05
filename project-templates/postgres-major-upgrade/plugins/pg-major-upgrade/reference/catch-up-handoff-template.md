# Catch-up handoff template

Use this shape to bring a new upgrade Project up to date with work that started elsewhere. `/pg-catch-up` reads it. Keep it factual. Every claim says where it came from.

Keep private material (call notes, chats, internal links) in a private copy of this document. The catch-up skill notes those links but never cites them as sources.

```markdown
# <Team> Postgres upgrade: catch-up handoff

Written <date> by <name>. Newest information is from <date>.

## Project facts

| Field | Value | Source (result file, or "reported by X on date") |
|---|---|---|
| Provider and instance | | |
| Source version (major.minor) | | |
| Target version | | |
| Databases | | |
| Size | | |
| Replicas (live and stale) | | |
| Window | | |
| Data-loss rule | | |
| Deadline and target date | | |
| Program owners | | |
| Go or no-go owner | | |
| Repos and orgs | | |
| Compliance limits | | |

## Results already in hand

List each pasted output, attached as-is: precheck files, provider JSON, assessment dumps.
Say for each where it ran (primary or replica), how (psql or another client) and when.

## Decisions made

| Decision | Who decided | When | Where recorded |
|---|---|---|---|

## Work done

| Item | Evidence link | Status (done / reported done / in progress) |
|---|---|---|

## Consumers known

| Consumer | Owner | Connection path | Auth | CDC connector and plugin | Source |
|---|---|---|---|---|---|

## Findings so far

Blockers, prework and follow-ups, each with an owner if known.

## Open questions

| Original ID | Question | Who answers | Why it matters |
|---|---|---|---|

## Known conflicts

Where a result and a statement disagree: list both, and say which one you trust and why.
```
