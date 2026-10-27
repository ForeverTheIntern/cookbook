# Dashboard

The dashboard is the page an operator refreshes. After a claim, the overview is up and the run shows once Foreman pushes it.

## Sub-features

- `health` answers 200 on `/api/health`.
- `overview` renders the Factory page with KPIs and a Runs table.
- `shot` writes `portal.png` into the evidence folder.

## How to get to it (user POV)

- Open `http://127.0.0.1:8787/` in a browser after launch.
- The heading is Factory. A banner says the portal is waiting for Foreman until the first heartbeat, then names the version.

## Driving it with verify-factory

Preconditions:

- Launch printed `ready`.
- Chrome is on `PATH` or `SA_CHROME_BIN` is set.

- **Open.** `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/` prints `200`.
- **Capture.** `npm run verify -- evidence`. `.factory/verify/portal.png` shows the Factory overview.
- **After intake.** Reload the page. The Runs table lists the run id from `drive.json` once Foreman's heartbeat has pushed it. A banner that still says `Waiting for Foreman` means the push has not arrived yet. Wait for the next minute and capture again. Do not call the push a pass while the banner still says waiting and the table is empty after a claim that is more than a minute old.

## Gotchas

- The first screenshot can be the empty waiting state. That proves the server is the dashboard. It does not prove the run arrived.
- Viewer auth defaults to none on `npm run dev`. A portal with `SA_PORTAL_AUTH=basic` will not render until the browser has the password. This journey uses `none`.
