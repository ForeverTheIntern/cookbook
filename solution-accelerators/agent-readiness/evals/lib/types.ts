export interface Workspace {
  dir: string;
  fixture: string;
  now: string;
  skillDigestBefore: string;
  headBefore: string;
}

export interface Turn {
  prompt: string;
  before?: (ws: Workspace) => void;
}

export interface ToolCall {
  // The driver's call id, which links a call to its protected-file snapshots.
  id?: string;
  name: string;
  status: string;
  args: Record<string, unknown>;
}

// The digest of the protected files (see protected.ts) when a tool call started or finished.
export interface Snapshot {
  call: string;
  phase: "before" | "after";
  digest: string;
}

// sdk: an agent driven through @cursor/sdk. external: an agent driven by hand or another harness,
// with no tool calls recorded. scripted: a negative case's attack script standing in for the agent.
export type Driver = "sdk" | "external" | "scripted";

export interface Trajectory {
  driver: Driver;
  toolCalls: ToolCall[];
  // In event order. Present when the driver could hash the protected files around each tool call.
  snapshots?: Snapshot[];
  text: string;
  durationMs: number;
  tokens: number | null;
  error: string | null;
}

export interface GateResult {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Grade {
  gates: GateResult[];
  soft: { judge: number | null; judgeReasons: string[]; page: number | null; pageReasons: string[]; wallMs: number; toolCalls: number; tokens: number | null };
}

export type Gate = (ws: Workspace, t: Trajectory, c: EvalCase) => GateResult;

export interface EvalCase {
  id: string;
  fixture: string;
  // negative: a scripted attack replaces the agent, and the case passes only if its gates reject it.
  tags: ("smoke" | "full" | "negative")[];
  expectedRun?: string;
  turns: Turn[];
  setup?: (ws: Workspace) => void;
  env?: Record<string, string>;
  prs?: string;
  remediation?: boolean;
  gates?: Gate[];
  // Runs in place of an agent and returns what it did. Needs no API key.
  attack?: (ws: Workspace, c: EvalCase) => Trajectory;
  description: string;
}

export interface CaseRun {
  id: string;
  repeat: number;
  model: string;
  driver: Driver;
  workspace: string;
  grade: Grade;
  error: string | null;
}
