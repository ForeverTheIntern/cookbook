# Bootstrap prompt

Paste this into a new Cursor Project's coordinator chat. Fill in what you know, and leave the rest as `unknown`. The bootstrap marks every unknown as a question instead of guessing.

You don't need to install anything first. If the plugin isn't in the workspace repo yet, step 0 has the agent install it and open a pull request. You review and merge that PR, then say "continue".

The Project's workspace should be the repository that will hold `upgrade/` and the plugin's `.cursor/` folder. That's usually the primary app repo, or a small control repo for the upgrade ([S-40](../plugins/pg-major-upgrade/reference/sources.md)).

```text
Set up this Project to run a Postgres major version upgrade.

Facts (use "unknown" for anything not listed):
- Customer / team: {{name}}
- Provider and instance: {{e.g. Cloud SQL, project/instance-name}}
- Versions: Postgres {{source}} to {{target or "undecided"}}
- Size: {{e.g. 2 TB}}. Databases: {{count}}. Replicas: {{count, which are live, which are cross-region}}
- Downtime window: {{minutes}}, {{read/write or write-only}}, {{when, e.g. weekend night}}
- Data loss allowed: {{e.g. none}}
- Deadline: {{hard date and why}}. Target date: {{date}}
- Program owners: {{names}}. Go or no-go owner: {{name}}
- GitHub orgs to search: {{orgs}}. Known primary repo: {{org/repo}}
- Compliance: {{e.g. regulated data; agents never see production data or connect to production}}
- Concurrency: at most {{n}} agent sessions at a time
- Tracker: {{project | sheets | notion | linear | jira}} {{plus the sheet, database or project link if not project}}
- Slack channel for status: {{#channel or none}}. Daily status time: {{e.g. 08:00 local}}

Template source: https://github.com/neverfield/cookbook at ref {{a commit SHA or tag; "main" if you haven't pinned one}}, folder project-templates/postgres-major-upgrade.

0. Install the plugin, only if .cursor/skills/pg-upgrade-bootstrap/SKILL.md isn't in this repo. Until it's installed and merged, follow these rules yourself: don't connect to any database, don't run cloud provider or IaC commands, don't merge anything, and don't push to the default branch.
   a. Clone the template source at that ref into a temporary folder outside this repo, shallow and read-only. Don't run anything from it except the installer below.
   b. On a new branch named pg-upgrade/install-plugin, run: node <clone>/project-templates/postgres-major-upgrade/plugins/pg-major-upgrade/scripts/install-into-repo.mjs <this repo>
      If it says .cursor/hooks.json already exists, stop and show me both files so we can merge the hooks by hand.
   c. Commit only the new .cursor/ files, with the ref you installed in the commit message. Push the branch and open a pull request. Don't merge it.
   d. Stop. Link the pull request and list what it adds: rules, skills, commands, guard hooks, reference docs. Wait for me to merge it and say "continue". Then start a new agent session for the steps below, so the plugin's rules and hooks are loaded.

Then use the pg-upgrade-bootstrap skill. Do this in order, and stop for my approval after step 4:
1. Write upgrade/project.json and create upgrade/tracker.csv from the plugin's seed.
2. Search every listed org for code that connects to this database, and add one Consumer row per repo with its evidence.
3. Add a Question row for every unknown above that a gate or decision depends on.
4. Show me project.json, the repo list with evidence, the questions, and the decisions we'll make (D-01 to D-11) with who makes each. Wait for approval.
5. After I approve: start one read-only readiness scan per approved repo, draft the precheck request for the DBA (don't send it), draft the daily status subscription from the plugin's reference/automations.md, and render the dashboard.

Keep upgrade/ in this Project's shared context so every agent sees the same tracker.
```

## Already under way?

Paste the bootstrap prompt with the values you know, and run `/pg-catch-up` with a handoff written in the shape of [catch-up-handoff-template.md](../plugins/pg-major-upgrade/reference/catch-up-handoff-template.md). The catch-up skill maps the handoff's results, decisions and open questions into the tracker. Then it stops so you can confirm the summary.

## Updating the plugin later

Paste only step 0 with a newer ref, and tell the agent to run the installer with `--force` on a new branch. Review the diff in the pull request before merging. It replaces the plugin's files under `.cursor/`, including `hooks.json`, so if you merged hooks by hand, check that file in the diff. It leaves `upgrade/` alone.
