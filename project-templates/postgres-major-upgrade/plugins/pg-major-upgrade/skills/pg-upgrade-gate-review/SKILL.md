---
name: pg-upgrade-gate-review
description: Check whether an upgrade block's exit gates are met from the tracker and its evidence, write a gate report, and record SOP feedback. Use when someone asks whether a block or gate can close, before moving to the next block, or runs /pg-gate. Don't use for routine tracker updates (use pg-upgrade-tracker).
---

# Gate review

Paths: `<plugin>` is the plugin root, two levels above this file. Each block's exit gates table in `<plugin>/reference/sop.md` says what every gate needs.

## Steps

1. **Pick the scope.** Use the gate or block named in the request. Otherwise use the current block, which is the lowest block with an open gate.
2. **For each gate in scope:**
   1. Find the gate row, and every row whose `Gates` lists it.
   2. Check each feeding row. A row passes when either:
      - it's `Done` with `Evidence`, and the evidence actually shows its `Done when` (open the linked file or result and confirm); or
      - it's `Waived` with a named `Approver`, a reason, and an `Evidence` link to where that person approved the waiver.

      A missing link, or one that doesn't show the condition, fails the row. A waiver whose approval isn't linked fails too.
   3. Check the gate's own `Done when` against the evidence the SOP's table names for it. G0.3 and G0.4 are ownership gates: they pass when the findings report exists and every `Finding` row from it has a named owner and a fix task, even though those rows stay open until G1.1.
   4. Give the gate a verdict:
      - `pass`: every check succeeded.
      - `fail`: something is missing or contradicts the condition. List exactly what.
      - `needs decision`: everything is present, but the SOP needs a named person's sign-off that isn't recorded.
3. **A block exits** only when every gate in it is either `Done`, after a `pass` verdict and a recorded approval, or `Waived` with linked approval. One `fail` means the block doesn't exit, and the next block doesn't start.
4. **Write the report** to `upgrade/gate-reports/<gate-or-block>-<YYYY-MM-DD>.md`. It needs:
   - A table of each gate, with its verdict, the evidence checked, and what's missing.
   - The risks you saw.
   - One plain line: "Block N can exit" or "Block N can't exit".
5. **Update the tracker:**
   - `pass` or `needs decision`: set the gate to `Needs approval`. Name the person whose sign-off is needed, and link the report in `Notes`.
   - `fail`: set the gate to `Blocked`, with the reason in `Notes`.
   - Never set a gate to `Done` yourself. The named approver approves it, and `pg-upgrade-tracker` records the approval.
6. **Record SOP feedback.** When an SOP step or gate didn't fit what happened, append an entry to `upgrade/sop-feedback.md`: the date, the SOP section, what the SOP said, what happened, and a suggested change.
7. **Offer an independent review.** For Block 0 (the decision record), Block 2 (rehearsal timings) and Block 3 (runbook), suggest `/pg-review`, so other models check the artifact before sign-off.

## Checks that often fail

- **G0.2:** the run was on a replica, came from an ORM rather than psql, missed a database, or has unclear provenance.
- **G0.5:** a publication, slot or subscription maps to no consumer.
- **G1.1:** the provider precheck wasn't rerun, or an original finding has no closing evidence of its own.
- **G1.4:** only `SHOW password_encryption` was offered. That shows how new passwords are hashed, not how existing ones are stored.
- **G2.1:** only one rehearsal fit, the in-window steps exceed 75% of the window, or the clone's shape didn't match production.
- **G2.6:** a restore was timed, but the full rollback wasn't rehearsed through app validation.
- **G2.8:** an appendix B question is still open, with no answer, demonstration or waiver.

## Don't

- Pass a gate on someone's say-so in chat. The evidence has to be linked in the tracker.
- Soften a `fail` because the deadline is close. Say what would change the verdict.
