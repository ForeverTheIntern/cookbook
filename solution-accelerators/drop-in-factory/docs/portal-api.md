# Dashboard ingest API

Foreman pushes to the dashboard (`dashboard/`). The dashboard never calls Foreman, and Foreman never reads anything back from it except the list of runs it needs resent. All control stays on GitHub and Slack.

## Request

`POST <dashboard URL>/api/ingest`, JSON body, at most 2 MB.

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `X-Factory-Timestamp` | Unix seconds when Foreman signed the request. |
| `X-Factory-Signature` | `v1=` followed by the hex HMAC-SHA256 of `<timestamp>.<raw body>`, keyed with `SA_PORTAL_INGEST_SECRET`. |

The secret itself is never sent. The dashboard refuses a request whose timestamp is more than 5 minutes from its own clock, whose signature does not match, or whose signature it has already accepted in that window (a replay). Every message is idempotent anyway: a replayed run carries a rev the dashboard already holds, so it changes nothing.

To sign from a shell, for example to test a dashboard by hand:

```bash
body='{"schema":1,"factoryId":"manual","kind":"probe"}'
ts=$(date +%s)
sig="v1=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$SA_PORTAL_INGEST_SECRET" -hex | sed 's/^.* //')"
curl -sS "$SA_PORTAL_URL/api/ingest" -H 'content-type: application/json' \
  -H "x-factory-timestamp: $ts" -H "x-factory-signature: $sig" -d "$body"
```

## Messages

Every message has `schema: 1`, `factoryId` (the Foreman's id, stable across restarts and redeploys), `kind`, and a random `nonce` so that two identical messages sent in the same second still sign differently.

### `run`

```json
{ "schema": 1, "factoryId": "fac_…", "kind": "run", "doc": { "run": { … }, "transitions": [ … ], "roles": [ … ] } }
```

`doc` is the run document as Foreman stores it, without its post dedupe keys: the run (`id`, `repo`, `issue`, `title`, `stage`, `stageSince`, `pr`, `hold`, `blocked`, `sendBacks`, `createdAt`, `closedAt`, `rev`, …), its stage transitions (`seq`, `stage`, `at`, `reason`, `actor`), and its cloud agents (`agentId`, `role`, `visit`, `status`, `startedAt`, `finishedAt`, `url`, `costCents`, `costState`). The dashboard stores it only when `rev` is greater than the rev it holds, and answers `{ "ok": true, "stored": true|false }`.

Foreman sends one after every change to a run, and again whenever a heartbeat says the dashboard needs it.

### `heartbeat`

```json
{ "schema": 1, "factoryId": "fac_…", "kind": "heartbeat", "at": "2026-10-24T21:00:00Z", "version": "0.3.0",
  "repos": ["acme/api", "acme/web"], "openCount": 2, "runs": [{ "id": "f-api-12", "rev": 14 }] }
```

Sent every minute. `runs` lists every open run and every run closed in the last 24 hours, with its rev. The dashboard answers `{ "ok": true, "need": ["f-api-12"] }`: the ids it does not have, or holds at an older rev. Foreman sends those at once, so a new or wiped dashboard is complete within a minute, and a push lost while the dashboard was down is repaired on the next beat. The dashboard shows how long ago it last heard from each Foreman, and says so when that is over 3 minutes.

### `probe`

```json
{ "schema": 1, "factoryId": "doctor", "kind": "probe" }
```

`npm run doctor` sends this to check that the URL is the dashboard and that the secrets match. Nothing is stored.

## Responses

| Status | Meaning |
| --- | --- |
| `200` | Accepted. Body as above. |
| `400` | The body is not JSON, or a field is missing or malformed; `error` names it. |
| `401` | Missing, stale or wrong signature. |
| `409` | A replay of a request already accepted. |
| `413` | Body over 2 MB. |
| `503` | `SA_PORTAL_INGEST_SECRET` is not set on the dashboard. |

Foreman treats every non-200 as a failed push: it logs it (at most once every 5 minutes) and carries on. The next heartbeat repairs whatever was missed.
