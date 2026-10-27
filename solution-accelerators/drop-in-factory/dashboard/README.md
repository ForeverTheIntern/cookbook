# dashboard

An optional Next.js app showing every run: its timeline (who decided each step), its cloud agents with links, compute minutes, invoice cost and the KPI tiles. Foreman pushes signed run documents to it. The dashboard only reads them and never controls a run.

| Path | What it controls |
| --- | --- |
| `app/page.tsx`, `app/runs/` | The pages: the run list and one run's timeline. |
| `app/parts.tsx`, `app/globals.css`, `app/tokens.css` | Shared components, styles and colors. |
| `app/api/ingest/`, `app/api/health/` | Where Foreman pushes, and the health check. |
| `src/lib/kpi.ts` | The KPI tiles: what each one counts. |
| `src/lib/` | Storage (Postgres or the embedded PGlite), the signature check, and reading run documents. |
| `middleware.ts` | Who may view: `SA_PORTAL_AUTH` (`none`, `basic` or `proxy`). |
| `migrations/` | The database schema, applied on start. |
| `Dockerfile` | The image for hosting it yourself. |

To change it:

- **Run it:** `npm run dev` at the factory root starts it on <http://127.0.0.1:8787> next to Foreman, while `dashboard.enabled` is true in `factory.yaml`.
- **Change a page or a tile:** edit `app/` or `src/lib/kpi.ts`. Run `npm test` here for the ingest tests.
- **Change what Foreman sends:** the wire format is in [docs/portal-api.md](../docs/portal-api.md). Foreman's side is `foreman/bot/lib/dashboard-push.ts`. Change both together.
- **Host it:** see [Host the dashboard anywhere](../docs/reference.md#host-the-dashboard-anywhere) in the reference.
