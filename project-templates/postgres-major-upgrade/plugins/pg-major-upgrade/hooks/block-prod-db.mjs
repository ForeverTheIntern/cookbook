#!/usr/bin/env node
// beforeShellExecution guard for upgrade projects. A backstop for the guardrail rules,
// not a guarantee: it reads only the command text.
//
// Denies commands that would let an agent reach a real database or change provider
// state: Postgres clients without an explicit local host, database URIs pointing at a
// remote host anywhere in a command, database proxies, state-changing Cloud SQL /
// AlloyDB / RDS / Azure commands, IaC applies, PR merges, and pushes to a default branch.
//
// No host is trusted by default, not even localhost: a Cloud SQL Auth Proxy listening on
// localhost reaches production. PG_UPGRADE_GUARD_ALLOW_HOSTS lists hosts or socket
// directories (comma-separated) known to be disposable, e.g. "localhost" on a laptop with
// no proxy running, or a test container's hostname.

import { readFileSync } from "node:fs";

const ALLOWED = (process.env.PG_UPGRADE_GUARD_ALLOW_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

const PG_CLIENTS = new Set([
  "psql", "pg_dump", "pg_dumpall", "pg_restore", "pg_upgrade", "pgcopydb", "vacuumdb",
  "reindexdb", "clusterdb", "createdb", "dropdb", "pg_basebackup", "pg_recvlogical",
]);
const WRAPPERS = new Set(["sudo", "env", "time", "nohup", "exec", "command", "xargs"]);

// Heredoc bodies are file contents, not commands.
function stripHeredocs(command) {
  return command.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<heredoc");
}

// Split a command line into the simple commands it runs. Separators inside quotes don't
// split, so text such as echo "a; gcloud sql ..." or sed '...psql...' stays one command.
function segments(command) {
  const out = [];
  let cur = "";
  let quote = null;
  const text = stripHeredocs(command);
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') { cur += text[++i] ?? ""; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\") { cur += c + (text[++i] ?? ""); continue; }
    const two = text.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "$(") { out.push(cur); cur = ""; i++; continue; }
    if (";|&\n()`".includes(c)) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Global flags that take a value and can sit between a CLI and its subcommand,
// e.g. "gcloud --project p sql instances patch" or "terraform -chdir=infra apply".
const GLOBAL_FLAGS = /\s--?(?:project|account|configuration|impersonate-service-account|verbosity|format|region|zone|profile|chdir|repo|R|C|c(?=\s+\S+=))(?:=\S+|\s+(?!-)\S+)/g;

// Commands handed to a shell or eval run too: check their text as well.
function innerCommands(segment) {
  const out = [];
  for (const m of segment.matchAll(/\b(?:sh|bash|zsh|dash)\s+(?:-[a-z]*c[a-z]*)\s+(['"])([\s\S]*?)\1/g)) out.push(m[2]);
  for (const m of segment.matchAll(/\beval\s+(['"])([\s\S]*?)\1/g)) out.push(m[2]);
  return out;
}

// A segment with leading wrappers, env assignments and wrapper flags removed, so it starts
// with the program it runs.
function program(segment) {
  const words = segment.split(/\s+/);
  let i = 0;
  while (i < words.length && (WRAPPERS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || (i > 0 && WRAPPERS.has(words[i - 1]) && /^-/.test(words[i])))) i++;
  const rest = words.slice(i);
  if (rest.length) rest[0] = rest[0].split("/").pop();
  return rest.join(" ");
}

// The segments that run a Postgres client, e.g. "psql ..." in "cd x && PGHOST=db psql -f a.sql | tee out".
function clientSegments(command) {
  return segments(command).filter((segment) => {
    const first = program(segment).split(/\s+/)[0] ?? "";
    return PG_CLIENTS.has(first.split("/").pop());
  });
}

const HELP_ONLY = /^\s*(?:\S+=\S+\s+)*\S*\s+(--help|-\?|--version|-V)\s*$/;

const RULES = [
  {
    test: /\b(cloud[-_]sql[-_]proxy|alloydb-auth-proxy)\b/,
    why: "database proxies give the agent a path to a real instance",
  },
  {
    test: /\bgcloud\s+(?:beta\s+|alpha\s+)?sql\s+(?:instances\s+(?:patch|clone|delete|restore-backup|promote-replica|failover|restart|import|export|pre-check-major-version-upgrade|reset-ssl-config)|backups\s+(?:restore|delete)|users\s+(?:set-password|create|delete)|connect|import|export|databases\s+(?:delete|patch))\b/,
    why: "Cloud SQL commands that change an instance, or connect to it, are run by a person from the runbook",
  },
  {
    test: /\bgcloud\s+(?:beta\s+|alpha\s+)?alloydb\s+(?:instances|clusters|backups)\s+(?:create|update|delete|restart|failover|restore|migrate-cloud-sql|upgrade)\b/,
    why: "AlloyDB commands that change a cluster are run by a person from the runbook",
  },
  {
    test: /\baws\s+rds\s+(?:modify-db-instance|modify-db-cluster|delete-db-[a-z-]+|restore-db-[a-z-]+|reboot-db-instance|failover-db-cluster|upgrade-db-[a-z-]+|start-db-[a-z-]+|stop-db-[a-z-]+)\b|\baws\s+rds-data\b/,
    why: "RDS commands that change an instance or run SQL are run by a person from the runbook",
  },
  {
    test: /\baz\s+postgres\s+flexible-server\s+(?:update|upgrade|delete|restart|restore|connect|execute|start|stop)\b/,
    why: "Azure Postgres commands that change or connect to a server are run by a person from the runbook",
  },
  {
    test: /\b(?:terraform|tofu|terragrunt)\s+(?:apply|destroy|import)\b|\bpulumi\s+(?:up|destroy|import)\b|\bcdk\s+(?:deploy|destroy)\b|\baws\s+cloudformation\s+(?:deploy|create-stack|update-stack|delete-stack|execute-change-set)\b/,
    why: "agents open IaC PRs; a person plans and applies them",
  },
  {
    test: /\bgh\s+pr\s+merge\b/,
    why: "agents never merge; the owner in the tracker merges",
  },
  {
    test: /\bgit\s+push\b(?=.*(?:\s|:)(?:main|master)\b)/,
    why: "agents never push to a default branch; they open PRs",
  },
];

function deny(why, command) {
  process.stdout.write(
    JSON.stringify({
      permission: "deny",
      user_message: `Blocked by the upgrade guardrail hook: ${why}.`,
      agent_message:
        `This command was blocked because ${why}. ` +
        "Don't retry it another way. Write the command into the runbook or a message for a person to run, " +
        "and work from the output they paste back.",
    }),
  );
  process.stderr.write(`pg-upgrade guard denied: ${command}\n`);
  process.exit(0);
}

function allow() {
  process.stdout.write(JSON.stringify({ permission: "allow" }));
  process.exit(0);
}

// Hosts named on a command line: -h, --host, host= in a conninfo string,
// a postgres:// URI, or an inline PGHOST= assignment.
function namedHosts(command) {
  const hosts = [];
  const patterns = [
    /(?:^|\s)-h\s*['"]?([^\s'"]+)/g,
    /--host[=\s]['"]?([^\s'"]+)/g,
    /\bhost\s*=\s*['"]?([^\s'"]+)/g,
    /\bPGHOST=['"]?([^\s'"]+)/g,
  ];
  for (const re of patterns) {
    for (const m of command.matchAll(re)) hosts.push(m[1].replace(/['"]/g, ""));
  }
  return hosts.concat(uriHosts(command));
}

function uriHosts(command) {
  return [...command.matchAll(/\bpostgres(?:ql)?:\/\/(?:[^@/\s'"]*@)?(\[[^\]]+\]|[^:/?\s'"]+)/g)].map((m) => m[1]);
}

function isLocal(host) {
  if (host.includes("$")) return false;
  const h = host.toLowerCase();
  if (h.startsWith("/")) return ALLOWED.some((d) => d.startsWith("/") && (h === d || h.startsWith(`${d}/`)));
  return ALLOWED.includes(h);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  deny("the hook could not read the command", "<unparseable input>");
}

const command = String(input.command ?? input.tool_input?.command ?? "");
if (!command) allow();

// Rules match the program a segment runs, so a command that only mentions one
// (in a file write, an echo, a grep pattern) isn't blocked.
function checkRules(text, depth = 0) {
  for (const segment of segments(text)) {
    let prog = program(segment).replace(GLOBAL_FLAGS, "");
    if (/^npx\s+/.test(prog)) prog = prog.replace(/^npx\s+(?:--yes\s+|-y\s+)?/, "");
    for (const rule of RULES) {
      if (rule.test.exec(prog)?.index === 0) deny(rule.why, command);
    }
    if (depth < 3) for (const inner of innerCommands(segment)) checkRules(inner, depth + 1);
  }
}
checkRules(command);

// A database URI with a remote host is denied in any command, e.g. python -c or node -e.
const remoteUris = uriHosts(command).filter((h) => !isLocal(h));
if (remoteUris.length > 0) deny(`it contains a database URI for a non-local host (${remoteUris.join(", ")})`, command);

const shellTexts = [command, ...segments(command).flatMap(innerCommands)];
for (const segment of shellTexts.flatMap(clientSegments)) {
  if (HELP_ONLY.test(segment)) continue;
  if (/\bservice\s*=|\bPGSERVICE=/.test(segment)) deny("a Postgres service name can point at any host", command);
  if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(segment.replace(/\$\(.*\)/g, ""))) {
    deny("a connection setting taken from a variable can point at any host", command);
  }
  const hosts = namedHosts(segment);
  if (hosts.length === 0) deny("a Postgres client needs an explicit local host (-h localhost), so it can't fall back to an inherited PGHOST", command);
  const remote = hosts.filter((h) => !isLocal(h));
  if (remote.length > 0) deny(`it points a Postgres client at a non-local host (${remote.join(", ")})`, command);
}

allow();
