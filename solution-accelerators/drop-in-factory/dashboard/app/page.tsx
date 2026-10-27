import type { Metadata } from "next";
import { db } from "../src/lib/db.ts";
import { DORA_WEEKS, KPI_DAYS, heartbeats, knownRepos, listRuns } from "../src/lib/read.ts";
import { dora, duration, kpis } from "../src/lib/kpi.ts";
import { FactoryStatus, StagePill, Tiles } from "./parts.tsx";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Factory" };

export default async function Overview({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const database = await db();
  const repos = await knownRepos(database);
  const asked = (await searchParams).repo ?? "all";
  const selected = repos.includes(asked) ? asked : "all";
  const docs = await listRuns(database, selected === "all" ? null : selected);
  const beats = await heartbeats(database);
  const now = Date.now();
  const many = repos.length > 1;
  return (
    <>
      <FactoryStatus beats={beats} now={now} />
      {many ? (
        <nav className="tabs" aria-label="Repository">
          {["all", ...repos].map((r) => (
            <a key={r} href={r === "all" ? "/" : `/?repo=${encodeURIComponent(r)}`} aria-current={r === selected ? "page" : undefined}>
              {r === "all" ? "All repositories" : r}
            </a>
          ))}
        </nav>
      ) : null}
      <section>
        <h2>
          KPIs <span className="muted">last {KPI_DAYS} days</span>
        </h2>
        <Tiles tiles={kpis(docs, now, KPI_DAYS)} />
      </section>
      <section>
        <h2>
          Delivery <span className="muted">last {DORA_WEEKS} weeks · factory runs only</span>
        </h2>
        <Tiles tiles={dora(docs, now, DORA_WEEKS)} />
      </section>
      <section>
        <h2>Runs</h2>
        {docs.length === 0 ? (
          <p className="muted empty">No runs yet. Label an issue for the factory, or mention Foreman in Slack.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                {many ? <th>Repo</th> : null}
                <th>Title</th>
                <th>Stage</th>
                <th>In stage</th>
                <th>GitHub</th>
              </tr>
            </thead>
            <tbody>
              {docs.map(({ run }) => (
                <tr key={run.id}>
                  <td className="mono">
                    <a href={`/runs/${encodeURIComponent(run.id)}`}>{run.id}</a>
                  </td>
                  {many ? <td className="mono">{run.repo}</td> : null}
                  <td>{run.title}</td>
                  <td>
                    <StagePill run={run} />
                  </td>
                  <td className="num muted">{duration(Date.parse(run.closedAt ?? new Date(now).toISOString()) - Date.parse(run.stageSince))}</td>
                  <td>
                    <a href={`https://github.com/${run.repo}/issues/${run.issue}`}>#{run.issue}</a>
                    {run.pr === null ? null : (
                      <>
                        {" · "}
                        <a href={`https://github.com/${run.repo}/pull/${run.pr}`}>PR #{run.pr}</a>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="muted small">Read-only. Approve, send back, retry and close runs on GitHub or in Slack.</p>
    </>
  );
}
