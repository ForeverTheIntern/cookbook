# Metrics go through the collector

Foreman pushes every KPI and DORA value to the OpenTelemetry collector over OTLP/HTTP after each event and each tick.

The dashboard does not read the values back from the collector. It computes its tiles from the run documents Foreman pushes ([portal-api.md](../portal-api.md)), and only the collector carries change failure rate and time to restore. A hosted Foreman exports metrics only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set on the deployment and the collector's host is in its egress list; see [Known issues](../reference.md#known-issues) in the reference.

Each push is a full snapshot computed from the store, so a lost push costs nothing. A metric with no value is sent as `factory.metric.not_emitted` with the reason, and the portal shows the reason instead of a zero.

Cost is real or absent. Compute minutes come from each agent's start and finish. Invoice cents are the sum of `chargedCents` (the billed amount, not `tokenUsage.totalCents`) over the Admin API usage events filtered on each role's cloud agent id, read once two hours after the role finishes so hourly aggregation has settled, and only when `CURSOR_ADMIN_API_KEY` is set. Filtering on the agent rather than the account keeps overlapping roles from being counted twice; an event that can't be tied to the agent is an error. There is no price table and no estimate.
