# Launch

Launch starts the local collector and Foreman with the dashboard, from whatever is already on disk. It does not deploy.

## Sub-features

- `ports-free` refuses to start when 8787 or 8790 is taken.
- `collector` starts `otelcol-contrib` when the binary is on `PATH` or `SA_OTELCOL_BIN` is set.
- `dev` starts `npm run dev` and waits until the dashboard health URL returns 200.
- `pids` records each process so cleanup can stop that process group.

## How to get to it (user POV)

- In a terminal at the factory folder, with `.env` loaded, run the launch command. Then open the dashboard URL.

## Driving it with verify-factory

Preconditions:

- `lsof -nP -iTCP:8787 -sTCP:LISTEN` and the same for 8790 print nothing.
- `SA_PORTAL_INGEST_SECRET` and `SA_PORTAL_URL` are set.
- `otelcol-contrib` runs, or `SA_OTELCOL_BIN` points at it.

- **Launch.** `npm run verify -- launch`. The command prints `ready http://127.0.0.1:8787/api/health`.
- **Confirm.** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/health` prints `200`. `.factory/verify/pids.json` lists the pids. `.factory/verify/dev.log` exists.
- **Doctor.** `npm run doctor -- --pids .factory/verify/pids.json` exits 0.

## Gotchas

- Launch does not stop a stranger on the port. Free it yourself, then retry.
- If health never returns, the pid file still exists. Run cleanup before another launch.
- An empty `SA_PORTAL_INGEST_SECRET` makes `npm run dev` invent a secret the doctor cannot know.
