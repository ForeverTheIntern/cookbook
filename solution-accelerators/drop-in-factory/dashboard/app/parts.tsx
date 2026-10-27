import type { Heartbeat } from "../src/lib/read.ts";
import { duration, type Tile } from "../src/lib/kpi.ts";
import type { WireRun } from "../src/lib/wire.ts";

/** Foreman heartbeats every minute; past this the page says it has gone quiet. */
const QUIET_MS = 3 * 60_000;

export function StagePill({ run }: { run: WireRun }) {
  const tone = run.hold !== null ? "red" : run.stage === "done" ? "green" : run.stage.startsWith("awaiting") || run.blocked !== null ? "amber" : "";
  const text = run.hold !== null ? `held · ${run.stage}` : run.blocked !== null && run.blocked !== undefined ? `${run.stage} · ${run.blocked}` : run.stage;
  return <span className={`pill ${tone}`}>{text}</span>;
}

export function Tiles({ tiles }: { tiles: Tile[] }) {
  return (
    <div className="metrics">
      {tiles.map((t) => (
        <div className="metric" key={t.label}>
          <div className="label">{t.label}</div>
          <div className="value num">{t.value ?? "—"}</div>
          {t.note === undefined ? null : <div className={t.value === null ? "note" : "otel"}>{t.note}</div>}
        </div>
      ))}
    </div>
  );
}

export function FactoryStatus({ beats, now }: { beats: Heartbeat[]; now: number }) {
  if (beats.length === 0) {
    return (
      <p className="banner" role="status">
        Waiting for Foreman. It sends a heartbeat every minute once <code>SA_PORTAL_URL</code> and <code>SA_PORTAL_INGEST_SECRET</code> are set on it.
      </p>
    );
  }
  return (
    <>
      {beats.map((b) => {
        const age = now - Date.parse(b.receivedAt);
        const quiet = age > QUIET_MS;
        return (
          <p key={b.factoryId} className={`banner${quiet ? " red" : ""}`} role={quiet ? "alert" : "status"}>
            {quiet ? `Foreman has not been heard from for ${duration(age)}: it is down, or cannot reach this portal. Runs below are as of then. ` : `Foreman ${b.version} · last heard ${duration(age)} ago · `}
            {b.openCount} open run{b.openCount === 1 ? "" : "s"} across {b.repos.length} repositor{b.repos.length === 1 ? "y" : "ies"}
          </p>
        );
      })}
    </>
  );
}
