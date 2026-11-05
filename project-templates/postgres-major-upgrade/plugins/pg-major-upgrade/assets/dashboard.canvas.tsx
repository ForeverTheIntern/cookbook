import {
  Callout,
  Card,
  CardBody,
  CardHeader,
  CollapsibleSection,
  Divider,
  H1,
  Pill,
  Row,
  Stack,
  Text,
  UsageBar,
  useHostTheme,
} from "cursor/canvas";

type Gate = { id: string; item: string; status: string; owner: string; evidence: string };
type Block = {
  block: string;
  state: string;
  gates: Gate[];
  closedGates: number;
  taskCounts: Record<string, number>;
  taskTotal: number;
};
type Attention = { id: string; item: string; owner: string; status: string; due: string; stale: boolean; overdue: boolean; note: string };
type Consumer = { id: string; item: string; owner: string; path: string; auth: string; cdc: string; status: string };
type Open = { id: string; item: string; owner: string; status: string; gates?: string };
type Recent = { id: string; item: string; type: string; status: string; since: string };
type Decision = { id: string; item: string; owner: string; ownerRole: string; status: string; waitingOn: string[]; ready: boolean };
type DashboardData = {
  project: { name: string; source: string; target: string; window: string; targetDate: string };
  generatedFrom: string;
  today: string;
  current: string;
  totals: Record<string, number>;
  workTotal: number;
  recent: Recent[];
  decisions: Decision[];
  blocks: Block[];
  gatesClosed: number;
  gatesTotal: number;
  attention: Attention[];
  consumers: Consumer[];
  openQuestions: Open[];
  findings: Open[];
  issues: { id: string; line: number; severity: string; message: string }[];
};

/* @data-start */
const DATA: DashboardData = {
  project: { name: "Acme Postgres upgrade", source: "Cloud SQL PostgreSQL 14", target: "18", window: "60 min, weekend night", targetDate: "2026-12-12" },
  generatedFrom: "tracker.csv (synthetic example)",
  today: "2026-11-04",
  current: "0",
  totals: { Done: 7, "In progress": 5, "Needs approval": 1, "Waiting on customer": 3, "Waiting on provider": 0, Blocked: 1, Waived: 0, "Not started": 37 },
  workTotal: 54,
  recent: [
    { id: "G0.3", item: "Provider precheck clean", type: "Gate", status: "Done", since: "2026-11-03" },
  ],
  decisions: [
    { id: "D-01", item: "Path: in-place upgrade or logical migration", owner: "Dana Lee", ownerRole: "Program owner", status: "In progress", waitingOn: ["Q-09"], ready: false },
    { id: "D-04", item: "Data-loss rule, including after writes reopen", owner: "unknown", ownerRole: "Business approver", status: "Not started", waitingOn: [], ready: true },
    { id: "D-06", item: "Go or no-go owner, and a backup", owner: "Dana Lee", ownerRole: "Program owner", status: "Done", waitingOn: [], ready: false },
  ],
  blocks: [
    { block: "0", state: "In progress", closedGates: 2, taskTotal: 12, taskCounts: { Done: 5, "In progress": 3, "Waiting on customer": 2, "Not started": 2 },
      gates: [
        { id: "G0.1", item: "Every consumer has an owner", status: "In progress", owner: "Dana Lee", evidence: "" },
        { id: "G0.2", item: "Valid precheck run", status: "Waiting on customer", owner: "Sam Ortiz", evidence: "" },
        { id: "G0.3", item: "Provider precheck clean", status: "Done", owner: "Sam Ortiz", evidence: "precheck-18.json" },
        { id: "G0.4", item: "Kit blockers owned", status: "In progress", owner: "Sam Ortiz", evidence: "" },
        { id: "G0.5", item: "CDC inventory reconciled", status: "Blocked", owner: "unknown", evidence: "" },
        { id: "G0.6", item: "Decision record signed", status: "Not started", owner: "Dana Lee", evidence: "" },
        { id: "G0.7", item: "Provider questions owned", status: "Done", owner: "Dana Lee", evidence: "Q-13" },
      ] },
    { block: "1", state: "Not started", closedGates: 0, taskTotal: 12, taskCounts: { "Not started": 12 }, gates: [] },
    { block: "2", state: "Not started", closedGates: 0, taskTotal: 3, taskCounts: { "Not started": 3 }, gates: [] },
    { block: "3", state: "Not started", closedGates: 0, taskTotal: 1, taskCounts: { "Not started": 1 }, gates: [] },
  ],
  gatesClosed: 2,
  gatesTotal: 26,
  attention: [
    { id: "G0.5", item: "CDC inventory reconciled", owner: "unknown", status: "Blocked", due: "", stale: false, overdue: false, note: "3 publications have no known consumer" },
    { id: "F-6g-01", item: "Pin search_path on normalize_tags(text[])", owner: "Sam Ortiz", status: "Needs approval", due: "2026-11-06", stale: true, overdue: false, note: "PR open 3 days" },
  ],
  consumers: [
    { id: "C-orders-api", item: "orders-api", owner: "Priya N", path: "primary", auth: "scram", cdc: "none", status: "Done" },
    { id: "C-analytics-cdc", item: "Analytics CDC feed", owner: "unknown", path: "cdc", auth: "scram", cdc: "debezium 2.7 pgoutput", status: "Waiting on customer" },
  ],
  openQuestions: [
    { id: "Q-01", item: "Is the downtime window approved by the business?", owner: "Dana Lee", status: "Waiting on customer" },
    { id: "Q-04", item: "Owner and connector version for each CDC consumer", owner: "unknown", status: "In progress" },
  ],
  findings: [
    { id: "F-6g-01", item: "search_path-dependent function in an index", owner: "Sam Ortiz", status: "Needs approval", gates: "G0.4" },
  ],
  issues: [],
};
/* @data-end */

const BLOCK_NAMES: Record<string, string> = {
  "0": "Discover and decide",
  "1": "Prepare in parallel",
  "2": "Rehearse on a clone",
  "3": "Cut over",
};

type Kind = "done" | "active" | "approval" | "waiting" | "blocked" | "idle";

const KIND: Record<string, Kind> = {
  Done: "done",
  Waived: "done",
  "In progress": "active",
  "Needs approval": "approval",
  "Waiting on customer": "waiting",
  "Waiting on provider": "waiting",
  Blocked: "blocked",
  "Not started": "idle",
};

const KIND_COLOR: Record<Kind, "green" | "blue" | "orange" | "yellow" | "red" | "gray"> = {
  done: "green",
  active: "blue",
  approval: "orange",
  waiting: "yellow",
  blocked: "red",
  idle: "gray",
};

function kindOf(status: string): Kind {
  return KIND[status] ?? "idle";
}

function count(counts: Record<string, number>, kind: Kind): number {
  return Object.entries(counts)
    .filter(([status]) => kindOf(status) === kind)
    .reduce((sum, [, n]) => sum + n, 0);
}

function StatusMark({ status }: { status: string }) {
  const theme = useHostTheme();
  const kind = kindOf(status);
  const color = theme.category[KIND_COLOR[kind]];
  const base = { width: 12, height: 12, borderRadius: 6, flexShrink: 0, boxSizing: "border-box" as const };
  if (kind === "done") {
    return (
      <span style={{ ...base, background: color, color: theme.bg.editor, fontSize: 9, lineHeight: "12px", textAlign: "center" }}>
        ✓
      </span>
    );
  }
  if (kind === "idle") return <span style={{ ...base, border: `1.5px solid ${theme.stroke.primary}` }} />;
  if (kind === "blocked") return <span style={{ ...base, background: color }} />;
  return <span style={{ ...base, border: `2px solid ${color}`, borderRightColor: "transparent" }} />;
}

function Dot({ kind }: { kind: Kind }) {
  const theme = useHostTheme();
  return <span style={{ width: 6, height: 6, borderRadius: 3, background: theme.category[KIND_COLOR[kind]], display: "inline-block" }} />;
}

function StatusText({ status }: { status: string }) {
  const theme = useHostTheme();
  const kind = kindOf(status);
  if (kind === "done" || kind === "idle") return null;
  return (
    <span style={{ color: theme.category[KIND_COLOR[kind]], fontSize: 12, whiteSpace: "nowrap", flexShrink: 0 }}>{status}</span>
  );
}

function ItemRow({ status, title, detail, trailing }: { status: string; title: string; detail?: string; trailing?: string }) {
  return (
    <Row gap={8} align="start">
      <span style={{ paddingTop: 3, display: "flex" }}>
        <StatusMark status={status} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }} title={detail ? `${title}\n${detail}` : title}>
        <Text truncate>{title}</Text>
        {detail && (
          <Text size="small" tone="tertiary" truncate>
            {detail}
          </Text>
        )}
      </div>
      {trailing ? (
        <Text size="small" tone="tertiary">
          {trailing}
        </Text>
      ) : (
        <StatusText status={status} />
      )}
    </Row>
  );
}

function Summary() {
  const theme = useHostTheme();
  const t = DATA.totals;
  const chips: { kind: Kind; label: string }[] = [
    { kind: "done", label: `${count(t, "done")} done` },
    { kind: "active", label: `${count(t, "active")} in progress` },
    { kind: "approval", label: `${count(t, "approval")} need approval` },
    { kind: "waiting", label: `${count(t, "waiting")} waiting` },
    { kind: "blocked", label: `${count(t, "blocked")} blocked` },
    { kind: "idle", label: `${count(t, "idle")} not started` },
  ];
  const closed = count(t, "done");
  const pct = DATA.workTotal ? Math.round((closed / DATA.workTotal) * 100) : 0;
  return (
    <div style={{ background: theme.fill.quaternary, borderRadius: 8, padding: 14 }}>
      <Stack gap={10}>
        <Row justify="space-between" align="center" wrap>
          <Text weight="semibold">{`${DATA.gatesClosed} of ${DATA.gatesTotal} gates closed`}</Text>
          <Text size="small" tone="secondary">{`Block ${DATA.current} · ${BLOCK_NAMES[DATA.current] ?? "Close-out"}`}</Text>
        </Row>
        <UsageBar
          total={Math.max(DATA.workTotal, 1)}
          segments={(["done", "active", "approval", "waiting", "blocked"] as Kind[]).map((k) => ({
            id: k,
            value: count(t, k),
            color: KIND_COLOR[k],
          }))}
          topLeftLabel={`${closed} of ${DATA.workTotal} tasks and gates closed`}
          topRightLabel={`${pct}%`}
        />
        <Row gap={6} wrap>
          {chips
            .filter((c) => !c.label.startsWith("0 "))
            .map((c) => (
              <Pill key={c.kind} size="sm" leadingContent={<Dot kind={c.kind} />}>
                {c.label}
              </Pill>
            ))}
        </Row>
      </Stack>
    </div>
  );
}

function Section({ title, children }: { title: string; children: Parameters<typeof Stack>[0]["children"] }) {
  return (
    <Stack gap={8}>
      <Text size="small" tone="tertiary" weight="medium">
        {title}
      </Text>
      {children}
    </Stack>
  );
}

function BlockCard({ block }: { block: Block }) {
  const done = count(block.taskCounts, "done");
  const isCurrent = block.block === DATA.current;
  const trailing = [block.gates.length ? `${block.closedGates}/${block.gates.length} gates` : "", `${done}/${block.taskTotal} tasks`]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card collapsible={block.gates.length > 0} defaultOpen={isCurrent}>
      <CardHeader trailing={trailing}>{`Block ${block.block} · ${BLOCK_NAMES[block.block] ?? ""}`}</CardHeader>
      <CardBody>
        <Stack gap={8}>
          {block.gates.map((g) => (
            <ItemRow key={g.id} status={g.status} title={`${g.id}  ${g.item}`} detail={g.owner ? `Owner: ${g.owner}` : undefined} />
          ))}
        </Stack>
      </CardBody>
    </Card>
  );
}

function Decisions() {
  const decided = DATA.decisions.filter((d) => kindOf(d.status) === "done");
  const open = DATA.decisions
    .filter((d) => kindOf(d.status) !== "done")
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.id.localeCompare(b.id));
  if (DATA.decisions.length === 0) return null;
  const ready = open.filter((d) => d.ready).length;
  return (
    <Section title={`Decisions · ${decided.length} of ${DATA.decisions.length} made${ready ? ` · ${ready} ready to decide` : ""}`}>
      {open.map((d) => (
        <ItemRow
          key={d.id}
          status={d.status}
          title={d.item}
          detail={[
            d.id,
            d.owner && d.owner !== "unknown" ? d.owner : `${d.ownerRole} (not named)`,
            d.ready ? "ready to decide" : `waiting on ${d.waitingOn.join(", ")}`,
          ].join(" · ")}
        />
      ))}
    </Section>
  );
}

export default function UpgradeDashboard() {
  const errors = DATA.issues.filter((i) => i.severity === "error");
  const needsYou = DATA.attention.filter((a) => a.status !== "Blocked");
  const blocked = DATA.attention.filter((a) => a.status === "Blocked");
  return (
    <Stack gap={18}>
      <Stack gap={4}>
        <H1>{DATA.project.name}</H1>
        <Text size="small" tone="secondary">
          {`${DATA.project.source} to ${DATA.project.target} · window ${DATA.project.window} · target ${DATA.project.targetDate}`}
        </Text>
      </Stack>

      <Summary />

      {errors.length > 0 && (
        <Callout tone="danger" title={`Tracker has ${errors.length} rule errors`}>
          {errors.slice(0, 5).map((e) => `line ${e.line} ${e.id}: ${e.message}`).join(" · ")}
        </Callout>
      )}

      {needsYou.length > 0 && (
        <Section title="Needs a person">
          {needsYou.map((a) => (
            <ItemRow
              key={a.id}
              status={a.status}
              title={a.item}
              detail={[a.id, a.owner, a.stale ? "stale" : "", a.overdue ? `overdue since ${a.due}` : a.due ? `due ${a.due}` : ""]
                .filter(Boolean)
                .join(" · ")}
            />
          ))}
        </Section>
      )}

      {blocked.length > 0 && (
        <Section title="Blocked">
          {blocked.map((a) => (
            <ItemRow key={a.id} status={a.status} title={a.item} detail={[a.id, a.owner, a.note].filter(Boolean).join(" · ")} />
          ))}
        </Section>
      )}

      <Decisions />

      <Stack gap={10}>
        {DATA.blocks.map((b) => (
          <BlockCard key={b.block} block={b} />
        ))}
      </Stack>

      {DATA.recent.length > 0 && (
        <Section title="Recently closed">
          {DATA.recent.map((r) => (
            <ItemRow key={r.id} status={r.status} title={r.item} detail={`${r.id} · ${r.type}`} trailing={r.since} />
          ))}
        </Section>
      )}

      {DATA.consumers.length > 0 && (
        <CollapsibleSection title="Consumers" count={DATA.consumers.length}>
          <Stack gap={8}>
            {DATA.consumers.map((c) => (
              <ItemRow
                key={c.id}
                status={c.status}
                title={c.item}
                detail={[c.owner, c.path, c.cdc !== "none" ? c.cdc : "", c.auth].filter(Boolean).join(" · ")}
              />
            ))}
          </Stack>
        </CollapsibleSection>
      )}

      {DATA.findings.length > 0 && (
        <CollapsibleSection title="Open findings" count={DATA.findings.length}>
          <Stack gap={8}>
            {DATA.findings.map((f) => (
              <ItemRow key={f.id} status={f.status} title={f.item} detail={[f.id, f.owner, f.gates ? `feeds ${f.gates}` : ""].filter(Boolean).join(" · ")} />
            ))}
          </Stack>
        </CollapsibleSection>
      )}

      {DATA.openQuestions.length > 0 && (
        <CollapsibleSection title="Open questions" count={DATA.openQuestions.length}>
          <Stack gap={8}>
            {DATA.openQuestions.map((q) => (
              <ItemRow key={q.id} status={q.status} title={q.item} detail={`${q.id} · ${q.owner}`} />
            ))}
          </Stack>
        </CollapsibleSection>
      )}

      <Divider />
      <Text size="small" tone="tertiary">{`Source: ${DATA.generatedFrom} · generated ${DATA.today} · view only; change rows through the tracker skill`}</Text>
    </Stack>
  );
}
