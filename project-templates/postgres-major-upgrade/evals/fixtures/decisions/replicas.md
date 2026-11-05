# Replicas on shop-primary

Pasted by Sam Ortiz, {{TODAY}}, from `gcloud sql instances describe shop-primary` and the console.

| Replica | Region | Serves |
|---|---|---|
| shop-replica-1 | us-east1 (same as the primary) | reports-ui read traffic |
| shop-replica-dr | us-west1 (cross-region) | Disaster recovery only; no app traffic |

Notes from Sam: reports-ui can fall back to the primary for a few hours if it has to, but it's heavy during business hours. Nobody has tested what the pooler does when a replica restarts.
