# Decision guide

The customer makes every decision in the decision record (gate G0.6). This guide helps them make each one well: the options, what each one gains and costs, which facts rule an option out, and which tracker rows hold those facts. The `pg-upgrade-decision-record` skill walks people through it. Agents never pick an option.

Each decision is a `D-` row in the tracker, seeded on day one. Its `Depends on` column lists the questions and tasks whose answers it needs, so the dashboard and the daily status can show what each decision is waiting on.

Claims follow the SOP's labels: **Verified** with an `[S-nn]` source, **Inferred**, or **Unverified**.

## How to use it

- **Start early.** Show the program owner the full list in week one, so they know what they'll be asked and who else needs to weigh in.
- **Rule out before choosing.** Check each option's "ruled out when" against the facts first. Don't ask anyone to weigh an option the facts already exclude.
- **Decide provisionally when the facts allow it.** Several decisions can only be confirmed by the rehearsal (path, window, rollback timing). Record them as "provisional, confirmed at G2.1", with the fallback named, rather than waiting.
- **Missing facts become questions.** If a decision needs a fact nobody has, add a question row with an owner, and list it in the decision's `Depends on`.

## D-01. Path: in-place upgrade or logical migration

**Facts it needs:** sizes, large objects and relation counts (kit sections 2a, 2d, 2e, from B0-03), keyless tables (5a), unlogged tables (5b), write rate and WAL per day (Q-09), the window (D-03), and the CDC inventory (Q-04, B0-07).

| Option | Gains | Costs | Ruled out when |
|---|---|---|---|
| In-place major version upgrade (default) | One instance: same endpoint, roles, grants and settings. Least work. | Downtime lasts as long as the upgrade, which only the rehearsal can measure. Rollback means restoring the pre-upgrade backup to a recovery instance [S-01]. Every logical slot is deleted [S-01]. | More than 10 million large objects in total, where the upgrade fails [S-01]. Above about 100,000 relations or 1,000 databases it gets less reliable and can time out [S-01], so plan the fallback. |
| Logical migration (DMS, pglogical or pgcopydb) | A short cutover. Rollback is switching connection strings back, while the old instance is still current. | A second instance to build and pay for. Keyless tables lose UPDATEs and DELETEs on a standard DMS migration [S-13]. Unlogged tables and large objects don't replicate, and materialized views arrive empty [S-13]. Roles and passwords must be migrated (Inferred). DMS suspends point-in-time recovery during replication [S-13]. | The data needs large objects or unlogged tables kept, or keyless tables take UPDATEs and can't get a replica identity. |

**A good default:** in-place, provisional until two rehearsals fit the window (G2.1), with logical as the named fallback.

## D-02. Target version

**Facts it needs:** version research (B0-10), extensions and their target versions (kit section 3), CDC connector support (Q-04), drivers from the readiness scans (B0-02), and provider answers (Q-30, Q-38).

| Option | Gains | Costs | Ruled out when |
|---|---|---|---|
| The newest the provider offers (18 on Cloud SQL) | The longest support. From 17 on, logical replication state carries through later upgrades [S-38]. Community pg_upgrade 18 can keep planner statistics [S-14], but whether Cloud SQL's upgrade does is Q-30. | The most changed behavior to test (SOP appendix A). Tools and CDC connectors may lag behind it. | A required extension isn't offered at a version the target needs [S-10]. For example, Cloud SQL 18 needs PostGIS 3.6.0, which isn't offered on 14 [S-01, S-10], so Q-38 has to be answered. Also ruled out if a CDC connector has no supported version and can't be replaced. |
| One version lower (17) | Fewer changes to test. Tooling support is more mature (Inferred). | Another major upgrade comes sooner. | The same checks, against 17. |

**A good default:** the newest version, unless an extension or a connector rules it out.

## D-03. Window

**Facts it needs:** the business's approval and approver (Q-01), dates and blackout periods (Q-10), and sizes and write rate (B0-03, Q-09).

Decide the length, the mode and the timing:

- **Length.** Longer means more margin for a slow step and for a rollback, but costs the business more. The rehearsal has to fit within 75% of the window, with room for the rollback after it (G2.1). So a window chosen before any rehearsal is provisional.
- **Mode.** `read-write` stops reads and writes, and is the simplest. `write-only` keeps reads going, but every reader needs a path that stays up (a replica the upgrade doesn't touch, or the old instance on a logical path), and that routing has to be rehearsed (Q-06).
- **Timing.** The lowest-traffic period, clear of blackout dates, with every on-call owner available.

**A good default:** pick a provisional window from the database size, and confirm it after the second rehearsal.

## D-04. Data-loss rule

**Facts it needs:** the business approver's answer (Q-03).

| Option | What it means |
|---|---|
| Zero loss | Rollback is only allowed before the first write on the new version. After writes reopen, the plan is to fix forward. Each CDC consumer must drain fully, or re-snapshot. |
| Bounded loss | A named amount of loss is acceptable, which allows a later rollback point and simpler CDC handling. It needs the business approver's written sign-off. |

Most teams choose zero loss. Either way, write down the rule after writes reopen: fix forward, or roll back and lose the writes since then (SOP section 5).

## D-05. Rollback approach and decision time

**Facts it needs:** D-01, D-04, D-08, and whether point-in-time recovery can reach before the upgrade (Q-34).

- **In-place:** restore the pre-upgrade backup to a recovery instance [S-01]. Record the backup's ID when the upgrade starts. The latest rollback decision time is the window's end minus 1.25 times the rehearsed rollback, run all the way through app validation.
- **Logical:** switch connection strings back to the source. Writes made on the target after the switch are lost, unless they're replicated back (Inferred).
- **After reopening:** fix forward, unless D-04 allows loss.

**The trade-off to decide:** how much of the window to keep for rollback. Keeping more lowers the risk of a stuck upgrade, but leaves less time for the upgrade itself.

## D-06. Go or no-go owner

**Facts it needs:** Q-02.

This is one named person with the authority to call a rollback on the night, and a named backup. They should be awake and reachable for the whole window, and should not also be running commands.

## D-07. Target date

**Facts it needs:** dates and blackouts (Q-10), how long Blocks 1 and 2 will take (from the tracker), and the source version's support dates.

- **Earlier** means less risk of running an unsupported version, but less slack for fixes and rehearsals.
- **Later** gives more time, but for PostgreSQL 14: community updates end in November 2026 [S-21], and Cloud SQL extended support starts on 2027-02-01 [S-02]. It's charged in addition to regular instance pricing [S-04], and the provider starts sending notices three months before [S-03].

Plan for at least two rehearsals plus time to fix what they find. Pick the date after Block 1's fix list is known.

## D-08. Replica handling

**Facts it needs:** which replicas are live, and which are cross-region (Q-05); how routing behaves on restart (Q-06); provider answers (Q-33, Q-35); and consumer rows whose path is `replica`.

| Option | Gains | Costs | Ruled out when |
|---|---|---|---|
| Upgrade with the primary | One operation, and replicas stay attached. | The upgrade can't be cancelled once it starts [S-01]. It's run through gcloud [S-07]. Whether each replica keeps its stats and hostname is Q-33. | Rollback depends on cancelling the upgrade. |
| Upgrade replicas first | Read capacity on the target version is proven before the primary. | An upgraded replica can't be rolled back, and its databases are unavailable until the primary is upgraded [S-01]. | Readers can't lose those replicas for the time between the two upgrades. |
| Rebuild after the upgrade | No replica blocks rollback or cancelling. | No read replicas until they're rebuilt. Endpoints may change (Inferred). | Consumers with a `replica` path can't be pointed at the primary during the gap. |

Whatever the choice, the rehearsal adds the replicas back, because clones don't copy them [S-06]. A cross-region replica needs its own timing in the rehearsal.

## D-09. When the IaC version change merges

**Facts it needs:** whether the instance is managed in Terraform (B0-02), and Q-35.

On Cloud SQL, changing `database_version` in Terraform starts an upgrade of its own (SOP B1-11).

- **Run the upgrade with gcloud, and merge the version change afterwards as a reconcile** (the default). The plan must then show no change, or an in-place change.
- **Let Terraform run the upgrade.** Do this only if the provider confirms it covers your replica choice (Q-35), and the rehearsal ran it the same way.

## D-10. Freezes

**Facts it needs:** dates (Q-10), and whether schema changes can stop (Q-11).

- **Provider maintenance.** A deny period keeps maintenance from changing the instance between the last rehearsal and cutover. On Cloud SQL it can last up to 90 days [S-35]. The cost is delaying the provider's patches. Apply any pending minor update before the rehearsals, so the rehearsal and production match.
- **Schema changes.** Freezing migrations from the last rehearsal to cutover keeps the rehearsal valid. If they can't freeze, agree a rule instead: any schema change after the last rehearsal means another rehearsal.

## D-11. CDC plan, for each consumer

**Facts it needs:** each consumer's owner, connector version and decoding plugin (Q-04), the reconciled inventory (B0-07, G0.5), and the provider's decoding plugin answer (Q-39).

Cloud SQL's upgrade deletes every logical slot [S-01], so every consumer resumes from a new slot after the upgrade. For each consumer, choose:

| Option | When it fits |
|---|---|
| Drain at the fence, then resume from a new slot | The connector supports the target version, and its owner can confirm the drain. Nothing is lost if the drain is confirmed. |
| Re-snapshot after the upgrade | Simplest to get right, but it costs a full re-read, and the snapshot has to fit within the consumer's tolerance. |
| Upgrade or replace the connector first | Its current version doesn't support the target, or its decoding plugin isn't allowed (`output_plugin_libraries`, from 14.24 [S-21, S-23]). |
| Waive, as tested-unsupported | Only with its owner's written waiver after a rehearsal test. |

An inbound subscription (this instance consuming from elsewhere) has to be dropped and recreated across the upgrade from 14 [S-38].
