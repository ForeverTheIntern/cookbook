---
name: pg-upgrade-bootstrap
description: Set up a new Postgres major version upgrade project from the bootstrap prompt. Writes upgrade/project.json and the tracker, searches for every repo that connects to the database, then stops for approval. Use when someone starts an upgrade project or pastes the bootstrap prompt. Don't use for a migration already in flight (use pg-upgrade-catch-up) or to update an existing tracker (use pg-upgrade-tracker).
---

# Bootstrap an upgrade project

Paths: `<plugin>` is the plugin root, two levels above this file, as an absolute path. Run scripts from the workspace root, as the `workspace-layout` rule says.

## Inputs

The bootstrap prompt's values. Any value that isn't given is `"unknown"`. Never infer a value from the company name, the repo, or general knowledge.

## Steps

1. **Check for an existing project.** If `upgrade/tracker.csv` or `upgrade/project.json` already exists, stop. Say it exists, change nothing, and suggest `pg-upgrade-tracker` (to update it) or `pg-upgrade-catch-up` (to load a handoff).
2. **Write `upgrade/project.json`** following `<plugin>/reference/project.schema.json`:
   - `window` is an object, `{ "minutes": 45, "mode": "read-write", "when": "Sunday night" }`, or `"unknown"`. Fill only the parts that were given: "45 minutes on a Sunday night" gives `minutes` and `when`, so `mode` stays `"unknown"`.
   - Lists (`programOwners`, `orgs`) are arrays.
   - Dates are `YYYY-MM-DD` or `"unknown"`.
   - `trackerBackend` defaults to `"project"`.
   - `approvedReviewBackends` defaults to `["subagent"]`.
3. **Create the tracker.** Copy `<plugin>/assets/tracker.csv` to `upgrade/tracker.csv`.
   - Set `Owner` on each row whose `Owner role` maps to a person named in the inputs. Leave the rest `unknown`.
   - The seed already has standard questions Q-01 to Q-14. Fill their answers if the inputs give them.
   - For every other unknown input that a gate depends on, add a new `Question` row, numbered from `Q-20` upward. Set `Gates` to that gate.
4. **Search for consumers.** Search every listed org for code that connects to this database: connection settings, hostnames, the instance name, env var names such as `DATABASE_URL` or `PG*`, database role names, and ORM or driver configuration.
   - For each repo with a hit, add a `Consumer` row:
     - `ID` is `C-<repo-name>`, and `Repo` is `org/name`.
     - `Gates` is `G0.1`, and `Status` is `Not started`.
     - `Evidence` is the file path and line of the strongest hit. Record the location only, never the matched text.
   - A hit that contains a password or token gets a `Finding` row for its owner to rotate. Never copy the value.
   - **If you can't search** (no code search tool, no access to the org) or the search finds nothing, don't invent repos. Update seed row `Q-07` to say the search couldn't run or found nothing, set it to `Waiting on customer`, and ask for the repo list.
5. **Validate.** Run `node "<plugin>/scripts/tracker-check.mjs" upgrade/tracker.csv`, and fix every error it reports.
6. **Stop for approval.** Show:
   - The values in `project.json`, with each `unknown` called out.
   - The repo list with its evidence locations, and any near-misses you excluded, with the reason.
   - The question rows you added or updated.
   - The decisions they'll make (the `D-` rows), who decides each, and what each is waiting on, as `pg-upgrade-decision-record` lays out under "Show what's coming". Don't recommend options yet.

   Ask the program owner to approve the repo list and fill the unknowns. **Don't continue until a named person approves in this conversation.**
7. **After approval only:**
   - Start one read-only readiness scan per approved repo, following `<plugin>/reference/readiness-scan.md`, up to `concurrency` at a time. Link each one in `Session or PR`.
   - Draft the precheck request with `pg-upgrade-precheck`. Don't send it.
   - Draft the daily status subscription from `<plugin>/reference/automations.md`, for the program owner to turn on.
   - Render the dashboard with `pg-upgrade-tracker`.

## Output

`upgrade/project.json`, `upgrade/tracker.csv` with no checker errors, a chat summary, and the approval request.

## Don't

- Connect to any database or run provider commands, even to "check the size".
- Send messages or start scans before approval.
- Guess owners. `unknown` plus a question row is correct.
