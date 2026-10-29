# Goals and their roadmaps

An audit judges one goal, an activity agents should take on. Levels for every activity come from the same evidence, so the report's component table shows all of them at no extra cost.

## The scale

| Level | Name | Measured by | Means |
|---|---|---|---|
| 0 | Not bootable | audit | A clean checkout can't install, build and pass its tests. |
| 1 | Bootable | audit | A clean checkout installs, builds and passes every test, in a clean container. |
| 2 | Verifiable | audit | Everything this activity needs to check an agent's work passes. |
| 3 | Delegable | outcomes | Agent PRs meet the outcome targets your team set. |
| 4 | Scalable | outcomes | Those targets held while agent PR volume at least doubled. |

An audit never claims Level 3 or 4 by itself. A condition the audit couldn't run counts as not met, and the report says "could be Level N" when that's the only thing missing.

## What Level 2 needs, per goal

- **First PR (`first_pr`):** build, lint, type-check and test commands pass at `HEAD`; agent instructions are accurate; normal work needs no production access.
- **Bug fixes (`bug_fixes`):** the commands pass; every planted fault in the component is caught (at least 3); normal work needs no production access.
- **Features and refactors (`features`):** the bug-fix conditions plus accurate agent instructions.
- **Repo-wide changes (`repo_wide`):** computed for the repo, not per component. Every assessed component meets the bug-fix conditions, toolchain versions are pinned, and a frozen install reproduces the lockfile.

## The repo level

The repo level is the lowest level among active components, those with at least 10% of changes over 90 days. A component joins or leaves the active set only after two consecutive audits on the same side of the line. When more than 20% of changes are in components the audit doesn't assess, the report says "partial coverage".

## The roadmap, per goal

Every roadmap opens with "Name an owner for agent readiness" until one is recorded. Then, per component, the path is:

1. **Reach Level 1:** fix the clean install, build and tests. The usual items: set up a service, remove a production credential from tests, commit a lockfile, pass registry credentials.
2. **Reach Level 2:**
   - First PR: fix failing commands and stale instructions.
   - Bug fixes: fix failing commands and make the tests catch planted faults.
   - Features and refactors: both of the above.
   - Repo-wide changes: every component at the bug-fix bar, plus pinned toolchains and a reproducible frozen install.
3. **Roll out:** for each component at Level 2, "Give agents <goal> in <component>". Pick 3 to 5 real tasks, have agents run the verify skill before they push, and review as usual. The team decides who reviews agent PRs and what it watches.
4. **Set Level 3 targets:** merge rate, first-time CI pass rate and the most change requests you accept, over at least 20 agent PRs in a 30-day window (configurable, never below 10), always compared with other PRs in the same window.
5. **Reach Level 4:** hold the targets for two consecutive windows while agent PR volume at least doubles, without the change-request rate rising.

Each item records its expected outcome, a watch metric from the fixed set (opened, merged, first-time CI pass, changes requested, median days to merge, PRs that add a stray file, merged PRs by activity label) and its baseline. The audit that closes an item records the date, and later audits fill in the observed value from the window after it closed.

## Choosing a goal

- Start with `bug_fixes` when the team wants agents on day-to-day maintenance. It's the default.
- Use `first_pr` for a quick first look at whether an agent can land anything at all.
- Use `features` once bug fixes go well. It adds accurate instructions, which matter more as tasks get broader.
- Use `repo_wide` before handing an agent an upgrade or migration.
