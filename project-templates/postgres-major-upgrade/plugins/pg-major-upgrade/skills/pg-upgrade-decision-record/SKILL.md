---
name: pg-upgrade-decision-record
description: Guide the customer through the upgrade decisions (the D- rows, gate G0.6) - lay out options and trade-offs from the decision guide and the tracker's facts, surface what each decision still needs, and draft the decision record for the program owner to sign. Use any time in Block 0 when someone asks what they need to decide, wants to think through a trade-off (path, target, window, replicas, rollback, CDC, dates), or asks for the decision record or plan. Don't use to make the decisions; people make them.
---

# Decisions and the decision record

Paths: `<plugin>` is the plugin root, two levels above this file. The decisions, their options, trade-offs and the facts each needs are in `<plugin>/reference/decision-guide.md`. G0.6 in `<plugin>/reference/sop.md` lists what the record must cover.

The customer decides. Your job is to make each decision easy to make well: show what's known, what's still unknown, what the options cost, and which options the facts already rule out.

## Show what's coming (week one, and on request)

1. Read the tracker's `D-` rows. For each, list who decides (`Owner role` and `Owner`), and what it's waiting on: the open rows in its `Depends on`.
2. Show the program owner the list, ordered by what can be decided soonest. Point out decisions that need someone besides the program owner, such as the business approver for the window and the data-loss rule.

## Work through one decision

When someone asks about a decision, or its `Depends on` rows are all answered:

1. **Gather the facts.** Read the rows in its `Depends on`, the findings report, and the kit sections the guide names. Quote each fact with its row ID or file and section.
2. **Find the gaps.** For each fact the guide needs that nobody has, check for a question row. If there isn't one, add it through `pg-upgrade-tracker`, with an owner role, and add its ID to the decision's `Depends on`. Say plainly which gaps block the decision and which only lower confidence.
3. **Rule out options.** Check each option's "ruled out when" against the facts. Show what's excluded and why, with the source.
4. **Lay out what's left.** For each remaining option, give its gains and costs for this customer, in their numbers where you have them (sizes, window minutes, consumer names). Keep the guide's labels: Verified with `[S-nn]`, Inferred, or Unverified.
5. **Recommend, labeled as a recommendation.** Say which option you'd lean to and why, and whether it can be provisional (for example, "in-place, confirmed at G2.1, with logical as the fallback").
6. **Ask the decider.** Don't record a choice until the named decider makes it, by naming the option themselves ("we'll rebuild the replicas"). If they hand the choice to you ("just pick one", "whatever you think"), that isn't a decision: give your recommendation, and ask them to confirm it in their own words. Until they do, the row stays open. Set the `D-` row to `In progress` while facts are being gathered, and to `Needs approval` once the options are laid out and waiting on the decider.
7. **Record what they chose,** once every row in its `Depends on` is closed (`tracker-check` rejects a closed decision with open dependencies; if the decider accepts a gap, that question row is waived by name first), through `pg-upgrade-tracker`'s "Record an approval": the option, the reason, any condition (such as "provisional until G2.1"), the decider as `Approver`, and a URL to where they decided (a message, a comment, or the signed record) as `Evidence`. A file you wrote isn't that link. If there's no such link yet, leave the row at `Needs approval` and say what's needed.

## Draft the record (task B0-12)

1. Write `upgrade/decision-record.md` with one section per `D-` row, in the guide's order. Each section gives the facts, the options considered and the ones ruled out, the recommendation, who decides, and the status: `decided` (decider and link), `provisional` (and what confirms it), or `open` (and the question rows it waits on).
2. Add the source version's support dates (G0.6).
3. Ask the program owner to review it. Suggest `/pg-review` with the `gate` rubric before they sign. G0.6 closes only when the signed record, or a link to the sign-off, is the evidence.

## Don't

- Present a recommendation as a decision, or fill in a decision with your own choice, even when the decider asks you to.
- Leave out an option the customer asked about. If the facts rule it out, show why.
- Leave out an open item to make the record look complete.
- Ask the decider to weigh an option the facts already exclude.
