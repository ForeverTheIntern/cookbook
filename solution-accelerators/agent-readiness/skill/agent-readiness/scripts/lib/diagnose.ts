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
  const tool = output.match(/(?:^|\n)(?:bash: |sh: \d+: |\/bin\/sh: \d+: )?([\w.-]+): (?:command )?not found/);
  if (tool) return { cause: "missing_tool", detail: `${tool[1]} is not installed` };
  const mod = output.match(/Cannot find module '([^']+)'|ModuleNotFoundError: No module named '([^']+)'|ERR_MODULE_NOT_FOUND[^\n]*'([^']+)'/);
  if (mod) return { cause: "missing_module", detail: `module ${mod[1] ?? mod[2] ?? mod[3]} is missing` };
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|Network is unreachable|Temporary failure in name resolution/.test(output)) {
    return { cause: "network", detail: "it tried to reach the network" };
  }
  if (/SyntaxError|error TS\d{4}|IndentationError/.test(output)) return { cause: "compile", detail: "the code doesn't compile" };
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const errLine = [...lines].reverse().find((l) => /error|fail|assert|exception/i.test(l)) ?? lines[lines.length - 1] ?? "no output";
  return { cause: "unknown", detail: errLine.slice(0, 160) };
}
