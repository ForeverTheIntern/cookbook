# Acme Postgres upgrade: catch-up handoff

Written 2026-11-03 by Alex Kim. Newest information is from 2026-11-02.

## Project facts

| Field | Value | Source |
|---|---|---|
| Provider and instance | Cloud SQL, acme-prod/shop-primary | reported by Sam Ortiz on 2026-10-20 |
| Source version | 14 | reported by Sam Ortiz on 2026-10-20 |
| Target version | 18 (leaning, not decided) | call notes https://notes.example-meetings.com/d/abc123 |
| Databases | one application database | interview, 2026-10-21 |
| Size | about 3 TB | interview, 2026-10-21 |
| Window | 60 minutes, weekend night, read and write | interview, 2026-10-21 |
| Data-loss rule | none allowed | interview, 2026-10-21 |
| Program owners | Dana Lee, Sam Ortiz | |
| Go or no-go owner | unknown | |

## Results already in hand

- precheck-shop.txt and precheck-postgres.txt, attached. Run by Sam Ortiz on the primary with psql on 2026-11-02.
- precheck-18.json and instances-describe.yaml, attached, same day.

## Decisions made

| Decision | Who decided | When | Where recorded |
|---|---|---|---|
| Upgrade in place rather than migrate to a new instance | Dana Lee | 2026-10-24 | call notes https://notes.example-meetings.com/d/abc123 |
| Target 18 | nobody yet | | |

## Work done

| Item | Evidence link | Status |
|---|---|---|
| Code search across acme org | reports/code-search.md | done |
| Readiness scans per repo | | reported done by Alex, no links |

## Consumers known

| Consumer | Owner | Path | Auth | CDC | Source |
|---|---|---|---|---|---|
| orders-api | Priya N | primary | scram | none | scan |
| Debezium orders feed | Data team | cdc | scram | debezium pgoutput | interview |

The interview says these are the only two CDC consumers.

## Open questions

| Original ID | Question | Who answers | Why it matters |
|---|---|---|---|
| CQ-04 | Which Debezium version? | Data team | PG 18 support |
| CQ-09 | Who approves the window? | Dana Lee | Gate G0.6 |
