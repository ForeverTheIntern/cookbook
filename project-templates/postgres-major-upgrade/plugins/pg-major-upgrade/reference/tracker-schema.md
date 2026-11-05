# Tracker schema

The tracker is one table, and each row is one thing to track: a task, gate, question, consumer, finding, decision or risk. The `Type` column tells them apart. By default the table lives in the Project as `tracker.csv`, seeded from [assets/tracker.csv](../assets/tracker.csv). [Backends](#backends) explains how to keep it in Sheets, Notion, Linear or Jira instead.

## Columns

| Column | Values or format | Notes |
|---|---|---|
| ID | `B0-01`, `G2.1`, `Q-07`, `C-billing-api`, `F-6g-01`, `D-03`, `R-02` | Unique, with a prefix by type: B for task, G for gate, Q for question, C for consumer, F for finding, D for decision, R for risk |
| Type | `Task`, `Gate`, `Question`, `Consumer`, `Finding`, `Decision`, `Risk` | |
| Block | `0`, `1`, `2`, `3`, `Close-out` | |
| Stream | `Discovery`, `App code`, `Catalog`, `CDC`, `Auth`, `Infra`, `Monitoring`, `Runbook`, `Comms` | |
| Item | One line | What the row is |
| Done when | One checkable line | Required for Task and Gate rows |
| Owner role | `Program owner`, `DBA`, `App team`, `CDC owner`, `Security`, `Business approver`, `Partner`, `Provider support` | |
| Owner | Name, or `unknown` | Never invent a name. `unknown` gets a matching question row. |
| Side | `Customer`, `Partner`, `Pair`, `Provider` | Who does the work |
| Run by | `Agent`, `Human`, `Both` | |
| Session or PR | URL | Agent session or PR |
| Parallel group | Shard name, such as `repo:billing-api` | Rows in one group run in one session |
| Depends on | IDs, separated by spaces | A Decision row can't close while any of these is open |
| Gates | Gate IDs this row feeds, separated by spaces | |
| Status | See [Statuses](#statuses) | |
| Evidence | URL or `file#section` | Required for `Done` |
| Approver | Name | Required for `Waived` and for Decision rows |
| Due | `YYYY-MM-DD` | |
| Last checked | `YYYY-MM-DD` | Set by the daily status run |
| Notes | Free text | |
| Repo | `org/name` | Consumer rows |
| DB role | Role name | Consumer rows |
| Auth | `scram`, `md5`, `iam`, `cert`, `unknown` | Consumer rows |
| Path | `primary`, `replica`, `pooler`, `cdc` | Consumer rows |
| Driver and version | For example `psycopg 3.2` | Consumer rows |
| CDC | `none`, or connector, version and plugin, such as `debezium 3.4 pgoutput` | Consumer rows |
| Hazards found | Short list | Consumer rows |
| Status since | `YYYY-MM-DD` | The date `Status` last changed. Stale-approval checks use this, not `Last checked`. |

## Statuses

| Status | Meaning |
|---|---|
| `Not started` | Nobody has picked it up |
| `In progress` | A session or a person is working on it |
| `Waiting on customer` | Needs a paste-back, an answer or a review |
| `Waiting on provider` | Needs an answer from the cloud provider |
| `Needs approval` | The work is done, and it's waiting for the owner's approval or merge |
| `Blocked` | Can't move. `Notes` says why and on what. |
| `Done` | Done-when is met, and `Evidence` links to proof |
| `Waived` | Not doing it. Needs a named `Approver`, a reason in `Notes`, and an `Evidence` link to where the approver agreed. |

## Rules the tracker skill enforces

- A row can't be `Done` without `Evidence`, or `Waived` without an `Approver` and an `Evidence` URL linking to where they waived it. A `Decision` row can't be `Done` without a URL to where the decider chose it, or while a row in its `Depends on` is open. An agent can't produce such a link itself, so an agent never closes a decision or a waiver on its own. The skill sets such a row to `Needs approval` and says what's missing.
- A gate can't be `Done` without an `Approver`: the named person who approved closing it after a gate review passed.
- IDs are unique. A duplicate is reported, never merged silently.
- A gate's status is derived from the rows that list it in `Gates`. A gate is `Done` only when every one of those rows is `Done` or `Waived` and the gate row has its own evidence.
- A block has exited only when every gate in it is `Done` (with an approver) or `Waived` (with linked approval).
- `Owner` is a name or `unknown`. An `unknown` owner always has a question row.
- Values outside the lists above are reported, not guessed into a value.

## Backends

The default is a `tracker.csv` file in the Project's shared context, which every agent in the Project can read ([S-40](sources.md)). The canvas dashboard is rendered from it with `scripts/render-dashboard.mjs`.

To keep the tracker elsewhere, set `trackerBackend` in `upgrade/project.json` (the bootstrap prompt's "Tracker" line) and connect the matching MCP server. The column names stay the same.

| Backend | Maps to | Notes |
|---|---|---|
| `project` (default) | `tracker.csv` in Project shared context | No connections needed |
| `sheets` | One Google Sheet tab, with the CSV header as row 1 | Needs a Sheets or Drive MCP |
| `notion` | A Notion database, one property per column: `Status`, `Type` and `Block` are selects, `Due` is a date, URLs are URL properties | Needs the Notion MCP |
| `linear` | Issues in one project. `Type` and `Block` become labels, `Status` maps to workflow states, and the other columns go into the issue description as a key-value block. | Needs the Linear MCP |
| `jira` | Issues in one project, mapped the same way as Linear | Needs a Jira MCP |

If the backend's MCP is unavailable, the tracker skill applies the update to `tracker.csv`, appends the row to `upgrade/tracker-pending.csv`, adds `pending sync to <backend>` to the row's `Notes`, and tells the program owner. It syncs the pending rows before its next read, and never drops an update.
