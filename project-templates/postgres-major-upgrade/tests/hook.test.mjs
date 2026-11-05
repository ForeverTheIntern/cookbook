import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hooks = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../plugins/pg-major-upgrade/hooks");

function decide(script, payload, env = {}) {
  const res = spawnSync("node", [path.join(hooks, script)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout).permission;
}
const shell = (command, env) => decide("block-prod-db.mjs", { command, cwd: "/project" }, env);
const mcp = (mcp_server_name, tool_name, env) => decide("block-db-mcp.mjs", { mcp_server_name, tool_name, tool_input: "{}" }, env);

const deniedShell = [
  "psql -h 10.1.2.3 -U app -d prod -c 'select 1'",
  "psql --host=db.prod.example.com -f precheck.sql",
  "psql 'host=db.internal dbname=app user=x' -f precheck.sql",
  "psql postgresql://app:secret@prod-db.example.com:5432/app",
  "PGHOST=prod-db psql -f precheck.sql",
  "psql -f precheck.sql",
  'psql "$DATABASE_URL" -f precheck.sql',
  "psql service=prod -f precheck.sql",
  "psql -h /cloudsql/acme:us-central1:prod -f precheck.sql",
  "cd infra && psql -f precheck.sql | tee out.txt",
  "vacuumdb --all --analyze-only -h prod-primary",
  "pg_dump -h 34.12.0.9 app > dump.sql",
  "python3 -c \"import psycopg; psycopg.connect('postgresql://u:p@10.0.0.5/db')\"",
  "cloud-sql-proxy my-project:us-central1:prod",
  "gcloud sql instances patch prod --database-version=POSTGRES_18",
  "gcloud sql instances clone prod prod-clone",
  "gcloud sql instances pre-check-major-version-upgrade prod --target-database-version=POSTGRES_18",
  "gcloud beta sql instances delete prod",
  "gcloud sql backups restore 123 --restore-instance=prod",
  "gcloud sql connect prod --user=postgres",
  "gcloud alloydb instances update prod-primary --cluster=c1",
  "aws rds modify-db-instance --db-instance-identifier prod --engine-version 18.1",
  "aws rds-data execute-statement --sql 'select 1' --resource-arn x",
  "az postgres flexible-server upgrade -g rg -n prod --version 18",
  "terraform apply -auto-approve",
  "cd infra && tofu destroy",
  "pulumi up --yes",
  "npx cdk deploy",
  "aws cloudformation deploy --template-file t.yaml --stack-name db",
  "gh pr merge 42 --squash",
  "git push origin main",
  "git push origin HEAD:master",
  "./cloud-sql-proxy acme:us-central1:prod",
  "/usr/local/bin/psql -h 10.9.9.9 -f precheck.sql",
  "echo ok; gcloud sql instances patch prod --database-version=POSTGRES_18",
  "cat <<'EOF' > q.py\nimport psycopg\npsycopg.connect('postgresql://app:pw@10.0.0.7/app')\nEOF",
  "psql -h localhost -d shop -f precheck.sql",
  "psql -h 127.0.0.1 -f precheck.sql",
  "psql -h /tmp -f precheck.sql",
  "bash -c \"gcloud sql instances patch prod --database-version=POSTGRES_18\"",
  "sh -c 'psql -h 10.1.1.1 -f precheck.sql'",
  "eval \"terraform apply -auto-approve\"",
  "gcloud --project acme-prod sql instances patch prod --database-version=POSTGRES_18",
  "gcloud --verbosity=debug sql instances clone prod prod-clone",
  "terraform -chdir=infra apply",
  "git -C repo push origin main",
  "gh -R acme/app pr merge 812",
];

const allowedShell = [
  "psql --help",
  "psql --version",
  "gcloud sql instances describe prod --format=json",
  "gcloud sql operations list --instance=prod",
  "terraform plan -out plan.tfplan",
  "gh pr create --draft --fill",
  "git push origin cursor/upgrade-fix",
  "git push -u origin cursor/maintenance-docs",
  "node scripts/render-dashboard.mjs",
  "grep -rn 'psql' src/",
  "rg 'psql -h' docs/ | head",
  "cat precheck.sql | grep vacuumdb",
  "sed -i '' 's/old/Run gcloud sql instances patch prod during the window/' upgrade/runbook.md",
  "echo \"Step 7: gcloud sql instances patch <clone> --database-version=POSTGRES_18\" >> upgrade/runbook.md",
  "cat > upgrade/results/precheck-request.md <<'EOF'\nRun this on the primary:\npsql \"<connection to the primary>\" -X -f precheck.sql\nThen: gcloud sql instances pre-check-major-version-upgrade INSTANCE\nEOF",
  "python3 - <<'PY'\nrows = ['psql -f precheck.sql', 'gcloud sql connect']\nprint(rows)\nPY",
  "node -e 'const s = \"vacuumdb --all --analyze-only\"; console.log(s)'",
];

for (const command of deniedShell) test(`shell denies: ${command}`, () => assert.equal(shell(command), "deny"));
for (const command of allowedShell) test(`shell allows: ${command}`, () => assert.equal(shell(command), "allow"));

test("allow-list env admits disposable hosts, and nothing else", () => {
  assert.equal(shell("psql -h pgtest -f precheck.sql"), "deny");
  assert.equal(shell("psql -h pgtest -f precheck.sql", { PG_UPGRADE_GUARD_ALLOW_HOSTS: "pgtest" }), "allow");
  assert.equal(shell("psql -h localhost -f precheck.sql", { PG_UPGRADE_GUARD_ALLOW_HOSTS: "localhost" }), "allow");
  assert.equal(shell("psql -h /tmp -f precheck.sql", { PG_UPGRADE_GUARD_ALLOW_HOSTS: "/tmp" }), "allow");
  assert.equal(shell("psql -h prod -f precheck.sql", { PG_UPGRADE_GUARD_ALLOW_HOSTS: "localhost" }), "deny");
});

test("unparseable shell input is denied", () => {
  assert.equal(decide("block-prod-db.mjs", "not json"), "deny");
});

test("mcp denies database servers and SQL tools", () => {
  assert.equal(mcp("cloudsql-prod", "list_instances"), "deny");
  assert.equal(mcp("postgres", "query"), "deny");
  assert.equal(mcp("supabase", "list_tables"), "deny");
  assert.equal(mcp("internal-tools", "execute_sql"), "deny");
  assert.equal(mcp("internal-tools", "run_query"), "deny");
});

test("mcp guard reads preToolUse payloads from cloud agents", () => {
  const pre = (tool_name) => decide("block-db-mcp.mjs", { tool_name, tool_input: {} });
  assert.equal(pre("MCP:execute_sql"), "deny");
  assert.equal(pre("MCP:run_query"), "deny");
  assert.equal(pre("MCP:slack_send_message"), "allow");
  assert.equal(pre("Shell"), "allow");
  assert.equal(pre("Read"), "allow");
});

test("mcp allows ordinary tools and allow-listed servers", () => {
  assert.equal(mcp("slack", "slack_send_message"), "allow");
  assert.equal(mcp("github", "get_file_contents"), "allow");
  assert.equal(mcp("notion", "notion-update-page"), "allow");
  assert.equal(mcp("notion", "query-database"), "allow");
  assert.equal(mcp("pg-scratch", "query", { PG_UPGRADE_GUARD_ALLOW_MCP: "pg-scratch" }), "allow");
});
