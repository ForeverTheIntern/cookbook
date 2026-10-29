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
  name: string;
  status: string;
  args: Record<string, unknown>;
}

export interface Trajectory {
  driver: "sdk" | "external";
  toolCalls: ToolCall[];
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
  tags: ("smoke" | "full")[];
  expectedRun?: string;
  turns: Turn[];
  setup?: (ws: Workspace) => void;
  env?: Record<string, string>;
  prs?: string;
  remediation?: boolean;
  gates?: Gate[];
  description: string;
}

export interface CaseRun {
  id: string;
  repeat: number;
  model: string;
  driver: "sdk" | "external";
  workspace: string;
  grade: Grade;
  error: string | null;
}
