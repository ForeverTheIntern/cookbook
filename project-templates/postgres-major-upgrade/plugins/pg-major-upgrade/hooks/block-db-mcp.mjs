#!/usr/bin/env node
// beforeMCPExecution and preToolUse guard for upgrade projects. Denies MCP tools that can query or
// change a database or a cloud database service, so an agent can't reach production
// through an MCP server instead of the shell.
//
// PG_UPGRADE_GUARD_ALLOW_MCP lists server names (comma-separated) that are allowed anyway,
// for example a server bound to a disposable test database.

import { readFileSync } from "node:fs";

const ALLOWED = new Set(
  (process.env.PG_UPGRADE_GUARD_ALLOW_MCP ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const DB_SERVER = /(postgres|postgresql|\bpg\b|pg[-_]|cloud[-_]?sql|alloydb|\brds\b|aurora|supabase|neon|cockroach|database|\bdb\b|bigquery|spanner)/i;
// Tool names that run SQL or change a database instance on any server. "query_database"
// isn't here, because document tools (Notion, for example) use it for non-SQL databases.
const DB_TOOL = /(execute[_-]?sql|run[_-]?sql|run[_-]?query|\bsql\b|execute[_-]?query|psql|connect[_-]?database|instances?[_-](patch|update|delete|restart|clone|upgrade))/i;

function respond(permission, why) {
  const out = { permission };
  if (permission === "deny") {
    out.user_message = `Blocked by the upgrade guardrail hook: ${why}.`;
    out.agent_message = `This MCP call was blocked because ${why}. Write the query or command for a person to run, and work from the output they paste back.`;
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  respond("deny", "the hook could not read the MCP call");
}

// beforeMCPExecution sends mcp_server_name and tool_name. In cloud agents that hook doesn't
// run; HTTP MCP tools arrive through preToolUse with tool_name "MCP:<tool>" and no server.
const server = String(input.mcp_server_name ?? "");
const rawTool = String(input.tool_name ?? "");
if (!input.mcp_server_name && !rawTool.startsWith("MCP:")) respond("allow");
const tool = rawTool.replace(/^MCP:/, "");
if (ALLOWED.has(server.toLowerCase())) respond("allow");
if (DB_SERVER.test(server)) respond("deny", `MCP server "${server}" looks like a database or database service`);
if (DB_TOOL.test(tool)) respond("deny", `MCP tool "${tool}" can run SQL or change a database`);
respond("allow");
