import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "../../../src/lib/db.ts";
import { computeMinutes, duration, runCost } from "../../../src/lib/kpi.ts";
import { runDoc } from "../../../src/lib/read.ts";
import type { WireRole } from "../../../src/lib/wire.ts";
import { StagePill } from "../../parts.tsx";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return { title: `${decodeURIComponent((await params).id)} · Factory` };
}

const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function roleLabels(agents: WireRole[]): string[] {
  const total = new Map<string, number>();
  for (const a of agents) total.set(a.role, (total.get(a.role) ?? 0) + 1);
  const seen = new Map<string, number>();
  return agents.map((a) => {
    const n = (seen.get(a.role) ?? 0) + 1;
    seen.set(a.role, n);
    return total.get(a.role)! > 1 ? `${a.role} (round ${n})` : a.role;
  });
}

function CostCell({ agent }: { agent: WireRole }) {
  if (agent.finishedAt === null) return <span className="muted">after it finishes</span>;
  if (agent.costCents === null) return <span className="muted">{agent.costCheckedAt === null ? "not read yet" : "no usage yet"}</span>;
  return agent.costState === "final" ? (
    <>
      {dollars(agent.costCents)} <span className="muted">final</span>
    </>
  ) : (
    <>
      {dollars(agent.costCents)} <span className="pill">settling</span>
    </>
  );
}

function costTotal(agents: WireRole[]): string {
  const total = runCost(agents);
  if (total.cents === null) return "invoice not read yet (Foreman reads each agent's cost after it finishes, when CURSOR_ADMIN_API_KEY is set)";
  if (total.state === "final") return `invoice ${dollars(total.cents)} final`;
  return `invoice ${dollars(total.cents)} so far, settling (${total.read} of ${total.agents} agents read)`;
}

export default async function RunPage({ params }: Params) {
  const found = await runDoc(await db(), decodeURIComponent((await params).id));
  if (found === null) notFound();
  const { run, transitions, roles } = found.doc;
  const now = new Date().toISOString();
  const labels = roleLabels(roles);
  return (
    <>
      <section className="head">
        <h1>{run.title}</h1>
        <div>
          <StagePill run={run} /> <a href={`https://github.com/${run.repo}/issues/${run.issue}`}>{`${run.repo} #${run.issue}`}</a>
          {run.pr === null ? null : (
            <>
              {" · "}
              <a href={`https://github.com/${run.repo}/pull/${run.pr}`}>PR #{run.pr}</a>
            </>
          )}
          <span className="muted small">{` · ${run.id} · rev ${run.rev}`}</span>
        </div>
        {run.hold === null ? null : (
          <p className="hold" role="alert">
            Held: {run.hold}
          </p>
        )}
      </section>
      <section className="cols">
        <div>
          <h2>Timeline</h2>
          <ol className="timeline">
            {transitions.map((t, i) => (
              <li key={t.seq}>
                <span className={`dot ${t.stage}`} />
                <div>
                  <span className="stage">{t.stage}</span>{" "}
                  <span className="muted num">
                    {new Date(t.at).toISOString().slice(0, 16).replace("T", " ")} · {duration(Date.parse(transitions[i + 1]?.at ?? run.closedAt ?? now) - Date.parse(t.at))}
                  </span>
                  <div className="muted">
                    {t.reason}
                    {t.actor === null ? null : (
                      <>
                        {" · "}
                        <span className="pill">human: @{t.actor}</span>
                      </>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div>
          <h2>Cloud agents</h2>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Status</th>
                <th>Compute</th>
                <th>Invoice</th>
                <th>Agent</th>
              </tr>
            </thead>
            <tbody>
              {roles.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted empty">
                    No cloud agents yet.
                  </td>
                </tr>
              ) : (
                roles.map((a, i) => (
                  <tr key={a.agentId}>
                    <td>{labels[i]}</td>
                    <td>{a.finishedAt === null ? "running" : a.status.toLowerCase()}</td>
                    <td className="num">{a.finishedAt === null ? "running" : `${Math.round((Date.parse(a.finishedAt) - Date.parse(a.startedAt)) / 60_000)} min`}</td>
                    <td className="num">
                      <CostCell agent={a} />
                    </td>
                    <td>
                      <a className="mono" href={a.url}>
                        {a.agentId.slice(0, 11)}
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <p className="muted">
            Compute {Math.round(computeMinutes(roles))} min · {costTotal(roles)}
          </p>
        </div>
      </section>
    </>
  );
}
