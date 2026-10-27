# State on host.kv

All of Foreman's state is in the Agent SDK's `host.kv`: one document per run (`run/<id>`), index keys for the open runs (`idx/open`), the runs closed each month (`idx/closed/<yyyy-mm>`), Slack threads and pull requests, plus leases (`lease/<name>`) and once-keys (`once/<key>`). Foreman doesn't use `host.files`.

`host.files` has conditional writes (`ifMatch`) and a listing, which `host.kv` lacks. But on Cursor hosting a deleted file can refuse every later write, so markers, leases and once-keys can't live there.

One store means accepting a documented race. `host.kv` in `@grok/agent-sdk` 0.3.0 has get, put and delete only. So:

- a list is a read-modify-write value; every save of a run puts its id back in `idx/open` if a racing writer dropped it;
- a lease is `{ owner, token, exp }`. A claim writes a fresh token, waits 150 ms and reads it back; release writes `exp: 0` rather than deleting;
- a once-key is claimed the same way, and listed in a day bucket (`idx/once/<yyyy-mm-dd>`) so the hourly sweep can delete it after 14 days.

On hosting every scheduled tick starts a runtime of its own, beside Slack and GitHub deliveries, so sessions can overlap even on one replica. Two that claim within the wait can both win, and then double a tick, a role launch or a post. Intake is human-driven, so this should be rare. Run `rev` checks and the keyed posts, launches and once-keys limit what a double can do.

When `host.kv` exposes `putIfAbsent` and `putIfVersion` (the Agent SDK's storage layer has them as `HostKvCasApi`; the agent-facing API doesn't), a claim becomes one conditional write and the race closes without changing the layout.
