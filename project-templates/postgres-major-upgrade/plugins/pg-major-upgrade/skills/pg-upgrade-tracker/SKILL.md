---
name: pg-upgrade-tracker
description: Read, update, validate and summarize the upgrade tracker, record approvals, and render its dashboard canvas. Use when someone asks for upgrade status, wants rows added or changed, links a PR or evidence, approves a gate, or asks for the daily summary. Also syncs to Sheets, Notion, Linear or Jira when the project uses one. Don't use to decide whether a gate passes (use pg-upgrade-gate-review).
---

# Tracker

Paths: `<plugin>` is the plugin root, two levels above this file. The schema and rules are in `<plugin>/reference/tracker-schema.md`. The tracker is `upgrade/tracker.csv`, unless `upgrade/project.json` sets `trackerBackend` to another backend.

## Update rows

1. Read the current tracker. If an external backend is set, read from it (see Other backends, below).
2. Make only the change that the evidence supports, even when you're asked for more. "We're good", "it's done" or "mark it Done" in chat isn't evidence. When someone asks for Done without a link that shows the `Done when`, set `Needs approval`, and ask for the link. A gate is never set to Done this way (see Record an approval).
   - **Item** names the specific thing: the repo, slot, publication, function or table. Never a generic label such as "Consumer inventory row".
   - **Done:** a row moves to `Done` only with an `Evidence` link that shows its `Done when`. Without one, set `Needs approval`, and say what's missing.
   - **Waived:** needs a named `Approver`, a reason in `Notes`, and an `Evidence` link to where that person approved it. Without all three, leave the status alone and ask.
   - **PRs:** a merged PR is evidence for a Task row, but never for a Gate row.
   - **New rows** get the next free ID for their prefix. Never reuse an ID, and check that the ID isn't taken before you add one.
   - **Owner** is a name or `unknown`. An unknown owner gets a question row.
3. Whenever a row's `Status` changes, set `Status since` to today. Set `Last checked` to today on every row you touched or verified.
4. Run `node "<plugin>/scripts/tracker-check.mjs" upgrade/tracker.csv`. If it reports an error on a row you just changed, undo that change and tell the person what the rule requires. Don't keep a change the checker rejects. Report errors you didn't cause, and never delete or blank rows to make the check pass.
5. Re-render the dashboard (below).

## Record an approval

This applies only to Gate and Decision rows, and it's the only way they reach `Done`. For a Decision row, the approval must name the chosen option in the decider's own words. "Pick whatever you think is best" approves nothing. Task, Finding and Consumer rows reach `Done` through evidence that shows their `Done when`, never through someone's approval.

1. The gate has been through `pg-upgrade-gate-review`, and its latest report says `pass`, or says `needs decision` and names the person whose sign-off was missing, who is now giving it. For a Decision row, the signed decision record or entry exists.
2. The named approver has approved it somewhere you can link: a PR review, a signed decision record, or a message URL. You can't verify who is typing in chat, so an approval stated in chat isn't enough. Set the row to `Needs approval`, note "approval stated in chat by <name> on <date>; link needed", and ask for the link.
3. Set `Status` to `Done`, `Approver` to the person's name, and `Evidence` to the gate report path plus the approval link. Then set `Status since`.

`Evidence` is always one or more links, file paths or tracker IDs. The checker rejects free text such as "approved in chat".

## Daily status

1. Update statuses from linked PRs and agent sessions. An open PR means `In progress`. A merged PR means `Needs approval`, or `Done` if the row's `Done when` is only "PR merged". In that case, put the merged PR's URL in `Evidence`.
2. Write a summary with these sections, in this order:
   - The current block, and gates closed out of the total.
   - Decisions: those ready to decide, with their decider, then those still waiting, with the open rows they're waiting on (the `decisions` list from `summarize`).
   - Blocked rows, with their reasons.
   - Rows in `Needs approval` whose `Status since` is two or more days ago, grouped by owner.
   - Overdue rows.
   - New findings since yesterday.
   - Questions waiting on the customer or the provider.
3. Where it goes depends on how the run started. A scheduled run (subscription or automation) posts to the project's Slack channel, if the program owner turned that on. An interactive run, such as `/pg-status`, answers in chat, and posts to Slack only when that message asks for it.

## Render the dashboard

```bash
node "<plugin>/scripts/render-dashboard.mjs" --tracker upgrade/tracker.csv --project upgrade/project.json \
  --out upgrade/dashboard.canvas.tsx
```

If the canvases folder for this workspace exists (`~/.cursor/projects/<workspace-slug>/canvases/`), copy the file there as `pg-upgrade-dashboard.canvas.tsx` and link it. The slug is the workspace's absolute path without its leading `/`, with every other `/` and `.` replaced by `-`. In a cloud agent or Project run, where that folder isn't there, link `upgrade/dashboard.canvas.tsx` instead. Never edit the canvas by hand. Change the tracker and render again.

## Other backends

If `trackerBackend` is `sheets`, `notion`, `linear` or `jira`:

1. First, sync any rows in `upgrade/tracker-pending.csv` to the backend. Each pending row carries `Backend last edited`: the backend row's last-edited time when you last read it. If the backend row has been edited since, report the conflict, and leave both versions in place. Otherwise write it, and remove the pending row once the backend confirms the write.
2. Read the rows through that MCP server, using the column mapping in the schema's Backends table. Write them to `upgrade/tracker.csv`, so the checker can run on the same rules.
3. Apply the change, run the checker, and write the changed rows back through the MCP server.
4. **If the server isn't connected or a call fails,** don't drop the update. Apply it to `upgrade/tracker.csv`, append the changed row to `upgrade/tracker-pending.csv` with a `Backend last edited` column (the last-edited time you read, or `unknown`), and add `pending sync to <backend>` to that row's `Notes`. Tell the program owner the backend is unavailable.

## Don't

- Mark anything `Done` without evidence, or close a gate without a named approver.
- Delete rows. Use `Waived` with approval evidence, or note a duplicate.
- Put row data, query text or credentials in any cell.
