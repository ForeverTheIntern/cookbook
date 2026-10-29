import type { Diagnosis } from "./types.ts";

const PORTS: Record<string, string> = {
  "5432": "Postgres",
  "3306": "MySQL",
  "6379": "Redis",
  "27017": "MongoDB",
  "9200": "Elasticsearch",
  "5672": "RabbitMQ",
  "9092": "Kafka",
  "11211": "Memcached",
};

const SECRET_NAME = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/;

// The test totals a runner prints, so the report can say "82 of 82 tests" instead of "passed".
// Covers node --test (tap and spec), vitest, jest, mocha, pytest and unittest; null when none match.
export function testCounts(output: string): { passed: number; failed: number; total: number } | null {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const num = (re: RegExp) => {
    const all = [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
    return all.length ? Number(all[all.length - 1][1]) : null;
  };
  const nodePass = num(/^\s*[#ℹ] pass (\d+)\s*$/m);
  if (nodePass !== null) {
    const failed = num(/^\s*[#ℹ] fail (\d+)\s*$/m) ?? 0;
    return { passed: nodePass, failed, total: num(/^\s*[#ℹ] tests (\d+)\s*$/m) ?? nodePass + failed };
  }
  const vitest = [...text.matchAll(/Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed[^(\n]*\((\d+)\)/g)].pop();
  if (vitest) return { passed: Number(vitest[2]), failed: Number(vitest[1] ?? 0), total: Number(vitest[3]) };
  const jest = [...text.matchAll(/Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:\d+ todo, )?(\d+) passed, (\d+) total/g)].pop();
  if (jest) return { passed: Number(jest[2]), failed: Number(jest[1] ?? 0), total: Number(jest[3]) };
  const mochaPass = num(/^\s*(\d+) passing\b/m);
  if (mochaPass !== null) {
    const failed = num(/^\s*(\d+) failing\b/m) ?? 0;
    return { passed: mochaPass, failed, total: mochaPass + failed };
  }
  const pytest = [...text.matchAll(/(?:(\d+) failed, )?(\d+) passed(?:, \d+ \w+)* in [\d.]+s/g)].pop();
  if (pytest) return { passed: Number(pytest[2]), failed: Number(pytest[1] ?? 0), total: Number(pytest[2]) + Number(pytest[1] ?? 0) };
  const ran = num(/^Ran (\d+) tests? in /m);
  if (ran !== null) {
    const failed = (num(/FAILED \((?:failures=(\d+))/m) ?? 0) + (num(/FAILED \([^)]*errors=(\d+)/m) ?? 0);
    return { passed: ran - failed, failed, total: ran };
  }
  return null;
}

export function diagnose(output: string, timedOut: boolean, phase: string): Diagnosis {
  if (timedOut) return { cause: "timeout", detail: `the ${phase} step ran out of time` };
  const refused = output.match(/ECONNREFUSED (?:127\.0\.0\.1|::1|localhost|\[::1\]):(\d+)|connect(?:ion)? refused[^\n]*?:(\d{2,5})/i);
  if (refused) {
    const port = refused[1] ?? refused[2];
    const service = PORTS[port] ?? `a service on port ${port}`;
    return { cause: "service", detail: `connection refused on port ${port}`, service };
  }
  const cred = output.match(/\bMissing (?:required )?(?:env(?:ironment)? (?:var(?:iable)?)?\s*)?([A-Z][A-Z0-9_]{2,})\b|\b([A-Z][A-Z0-9_]{2,}) (?:is )?(?:not set|required|missing)\b/);
  if (cred) {
    const name = cred[1] ?? cred[2];
    if (SECRET_NAME.test(name)) return { cause: "credential", detail: `needs ${name}` };
  }
  if ((phase === "install" || phase === "doctor") && (/\b(E?401|Unauthorized|authentication required|no auth token)\b/i.test(output) || /Failed to replace env in config: \$\{[A-Z_]+\}/.test(output))) {
    return { cause: "registry", detail: "registry credentials not provided" };
  }
  const tool = output.match(/(?:^|\n)(?:[^\n:]*: line \d+: |[^\n:]*: \d+: |bash: )?([\w.+-]+): (?:command )?not found/);
  if (tool) return { cause: "missing_tool", detail: `${tool[1]} is not installed` };
  const mod = output.match(/Cannot find module '([^']+)'|ModuleNotFoundError: No module named '([^']+)'|ERR_MODULE_NOT_FOUND[^\n]*'([^']+)'/);
  if (mod) return { cause: "missing_module", detail: `module ${mod[1] ?? mod[2] ?? mod[3]} is missing` };
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Network is unreachable|Temporary failure in name resolution/.test(output)) {
    return { cause: "network", detail: "it tried to reach the network" };
  }
  if (/SyntaxError|error TS\d{4}|IndentationError/.test(output)) return { cause: "compile", detail: "the code doesn't compile" };
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const noise = /^(npm (error|ERR!|warn)|ELIFECYCLE|error Command failed|>\s|\$ |command failed|at |# )/i;
  const meaningful = lines.filter((l) => !noise.test(l));
  const errLine = [...meaningful].reverse().find((l) => /error|fail|assert|exception|remove|missing|expected/i.test(l)) ?? meaningful[meaningful.length - 1] ?? lines[lines.length - 1] ?? "no output";
  return { cause: "unknown", detail: errLine.slice(0, 160) };
}
