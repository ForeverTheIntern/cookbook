---
name: pg-upgrade-model-review
description: Run an independent review of an upgrade artifact (decision record, runbook, rehearsal timings, gate report, or the SOP itself) by several models that each see only the files and a rubric, then reconcile their findings against sources. Use before signing off a gate, or when someone runs /pg-review. Don't use for routine questions about the upgrade.
---

# Independent multi-model review

Paths: `<plugin>` is the plugin root, two levels above this file. The reviewer prompt, rubrics and output format are in `<plugin>/agents/independent-reviewer.md` and `<plugin>/agents/findings.schema.json`. Use the `gate` rubric for a team's own artifacts, and `sop`, `skills` or `readme` for the template itself.

## Check what you're allowed to use

Reviews send the artifacts to model providers, so read `compliance` and `approvedReviewBackends` from `upgrade/project.json` first.

- `subagent` (the default): read-only subagents in this Cursor session. Give each one only the reviewer prompt, the rubric name and the artifact files, never this conversation or another reviewer's output.
- `cursor`: `<plugin>/scripts/review-with-cursor.sh`, which runs the Cursor CLI read-only in ask mode.
- `codex`: `<plugin>/scripts/review-with-codex.sh`, which needs the Codex CLI installed and signed in. It sends files to OpenAI.

Use only the backends listed in `approvedReviewBackends`. If it's missing, use `subagent` only. Every reviewer in `reviewers` must use an approved backend; drop any that don't, and say so. If `compliance` mentions regulated data and the artifact names customers, systems or people, ask the program owner before using any backend outside Cursor.

Subagents only count as different families if you can choose each one's model. If you can't, a subagent-only round has one family, so it's `incomplete`. Ask the program owner to approve the `cursor` backend, which lets you choose models.

## Pick the reviewers

Use three or four reviewers from different model families. Model availability varies by account, so check it with `cursor-agent --list-models`. The list goes in `reviewers` in `project.json`, for example `["cursor:gemini-4-argon-high", "cursor:grok-4.7-high", "cursor:claude-opus-5-5-high"]`.

## Steps

1. List the artifact paths. For the `gate` rubric, also include `<plugin>/reference/sop.md` (for the gate's requirements) and every file the gate's tracker rows link as `Evidence`, so the reviewers can check claims against the evidence. Never include files with row data or credentials.
2. Run the round from the workspace root:

   ```bash
   REVIEWERS="cursor:gemini-4-argon-high cursor:grok-4.7-high cursor:claude-opus-5-5-high" \
     "<plugin>/scripts/run-review-round.sh" gate upgrade/reviews/<artifact>-<YYYY-MM-DD> upgrade/decision-record.md upgrade/runbook.md
   ```

   For subagents, run the same rubric in parallel subagents, and save each one's JSON to that folder.
3. **A round needs at least two successful reviewers from different model families.** Below that, mark the review `incomplete`, tell the gate owner the gate can't rely on it, and stop. A failed reviewer leaves a `.err` file, so report it.
4. **Reconcile.** Treat reviewer findings as claims, not facts.
   - Merge duplicates, and note how many reviewers raised each one.
   - For each factual finding, check the cited source or result yourself. Mark it `confirmed`, `rejected` (with the reason and the evidence), or `unverified`.
   - A finding raised by one reviewer can still be right. Check it rather than dropping it for being in the minority.
5. **Write `upgrade/reviews/<artifact>-<YYYY-MM-DD>.md`**: which reviewers ran, then one row per merged finding, giving the ID, severity, the reviewers who raised it, the claim, your verdict with its evidence, and the action.
6. **Act.** Confirmed blockers and majors become `Finding` rows that feed the gate under review, owned by the artifact's owner. Minor findings go in the report. The gate can't pass while a confirmed blocker is open.
7. **Summarize** for the gate owner: the counts by severity, the confirmed blockers, and what would change the verdict.
