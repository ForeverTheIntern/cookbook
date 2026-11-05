---
name: pg-upgrade-runbook
description: Draft the rehearsal and cutover runbook from the SOP and the project's facts, parse rehearsal timing sheets against the window, and act as checklist and scribe during a cutover. Use for Block 1 runbook drafting, Block 2 rehearsal timings, or Block 3 cutover tracking. Don't use to run any step yourself; people run every command.
---

# Runbook

Paths: `<plugin>` is the plugin root, two levels above this file. The runbook template comes from Blocks 2 and 3 of `<plugin>/reference/sop.md`. The window comes from `upgrade/project.json` (`window.minutes`). If the window is `unknown`, stop, and add a question row.

**Provider support.** The SOP's Block 2 and 3 commands, timeouts, cancel rule and rollback are written for Cloud SQL. For another provider, write those steps as `<provider step: ...>` placeholders, with a question row for each. Don't adapt the Cloud SQL commands from memory.

**The in-window budget** is 75% of `window.minutes`, rounded down. In-window steps run from the write fence (starting the window clock) to reopening writes. Clone setup, baselines, and the rollback rehearsal itself aren't in-window steps.

**The latest rollback decision time** is the window's end minus 1.25 times the rehearsed end-to-end rollback duration. That duration runs from the fence on the upgraded instance, through the restore, replicas and repointing, to app validation. Before cutover, the go or no-go owner approves this number in the runbook.

## A. Draft the runbook (Block 1, task B1-10)

1. Read `upgrade/project.json`, the latest findings report, the decision record and the tracker.
2. Write `upgrade/runbook.md` with:
   - Roles with names, and the comms owner.
   - The window, the in-window budget, and the latest rollback decision time (`not yet rehearsed` until Block 2).
   - Pre-checks at T-14, T-7 and T-1.
   - Each in-window step, with its command for a person to run, the expected output, its rehearsed time (or `not yet rehearsed`) and its owner.
   - Go or no-go checkpoints.
   - The point of no return, which is the first write on the new version.
   - Rollback before that point, and fix-forward after it.
   - Comms at the start, at each go or no-go, at rollback, and at reopening.
   - Validation and close-out.
3. Fill commands from the SOP with the project's values. Write a literal `<placeholder>` for anything unknown, and add a question row for it.
4. Include:
   - Every prework item that only works on the target version.
   - The extension updates and the reindex steps (B1-14).
   - The analyze branch from the SOP's Block 2 step 9.
   - The write fence and sentinel steps.
   - Each CDC consumer's new-slot step, and each inbound subscription's disable and re-enable steps.
   - The IaC reconcile after the upgrade (B1-11).
5. Set B1-10 to `Needs approval`. The program owner and DBA review it under G1.6.

## B. Parse a rehearsal timing sheet (Block 2)

1. Screen the sheet for row data or credentials, as the `workspace-layout` rule says. Then save it unchanged to `upgrade/results/rehearsal-<n>.md`.
2. Build a table with one row per step: its time, the running total, and whether it falls inside the window.
3. Add up the in-window steps, and compare the total with the in-window budget (G2.1). Both of two consecutive rehearsals must fit. If any in-window step has no timing, the rehearsal doesn't count, so name the missing steps. Also check that the clone matched production's tier, storage, replica topology and minor version, or that a signed scaling waiver exists.
4. **Rollback (G2.6):** check that the rollback was rehearsed end to end, through app validation. If it was, compute the latest rollback decision time. If it wasn't, G2.6 isn't met, and the decision time stays unknown.
5. **CDC (G2.5):** check that every consumer's sentinels arrived exactly once from the new slots, or that a full re-snapshot of every affected consumer, plus downstream catch-up, was timed and fits. A consumer that wasn't tested doesn't meet G2.5.
6. Update `upgrade/runbook.md` with the measured times. Update the Block 2 rows, with the sheet as evidence:
   - A gate whose condition is met goes to `Needs approval`.
   - A gate whose condition isn't met goes to `Blocked`, with the reason in `Notes`.
   - Never set a gate to `Done`. Then run `pg-upgrade-gate-review` on the Block 2 gates, so each has a report for its approver.

## C. Cutover checklist and scribe (Block 3)

1. Post each runbook step in order, with its owner and rehearsed time.
2. At the latest rollback decision time, if the upgrade hasn't finished, tell the go or no-go owner plainly: "It's the rollback decision time; the runbook says roll back now." Then walk the rollback steps with them, unless they explicitly decide otherwise, and record that decision.
3. When a person reports a step done, compare the output they report with the step's expected output before you record it. If it matches, record the time and a short summary of the output, without any row data. If it doesn't match, or shows an error, leave the step open, say what differs, and ask the go or no-go owner how to proceed. Flag any step that runs past its rehearsed time plus 25%. From T+10 on, show the time left before the latest rollback decision time.
4. At each checkpoint, ask the go or no-go owner for an explicit "go" or "no-go". Record their exact reply and the time. Silence, or "sure, probably", isn't a "go".
5. When app writes reopen, record that time as the point of no return. Maintenance writes before that, such as extension updates and analyze, don't count, because the rollback restores the pre-upgrade backup. Then and switch the checklist to fix-forward.
6. At close-out, draft the retro, and add entries to `sop-feedback.md`.

## D. Logical migration

If the decision record picks a logical path (DMS, pglogical or pgcopydb), draft a separate `upgrade/runbook-logical.md`. It covers every item in section 6 of the SOP: target build, initial copy and catch-up timing, keyless tables, what doesn't replicate, recovery settings, roles and credentials, sequences, cutover and rollback. Every Block 2 and Block 3 gate still applies.

## Don't

- Run commands. Every command in the runbook is for a named person.
- Count a rehearsal with missing timings toward G2.1.
- Round times down to make a step fit.
