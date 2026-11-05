# Rehearsal 1 timing sheet (clone shop-clone-1, 2026-11-20)

Window: 60 minutes. Recorded by Sam Ortiz.

| Step | Start | End | Minutes |
|---|---|---|---|
| Stop writers, maintenance on | 22:00 | 22:03 | 3 |
| Drain CDC to zero lag | 22:03 | 22:09 | 6 |
| Provider precheck | 22:09 | 22:14 | 5 |
| Upgrade (gcloud patch) | 22:14 | 22:41 | 27 |
| Version check, ALTER EXTENSION | 22:41 | 22:43 | 2 |
| Analyze missing stats | 22:43 | 22:51 | 8 |
| New slots, start CDC consumers | 22:51 | 22:53 | 2 |
| Validation and smoke tests | 22:53 | 22:57 | 4 |
| Pooler and routing back | 22:57 | 22:59 | 2 |

Restore from pre-upgrade backup: not timed this round (clone budget ran out).
CDC: debezium_orders resumed from the new slot with no gaps. search_feed not tested.
